/**
 * VibeMon - Main Process Entry Point
 *
 * This file orchestrates the application by connecting modules:
 * - StateManager: State and timer management (per-project timers)
 * - CharacterWindowManager: The single character window and per-project state registry
 * - BubbleWindowManager: The speech bubble that follows the character window
 * - TrayManager: System tray icon and menu
 * - HttpServer: HTTP API server
 */

// Load environment variables from .env.local or .env
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { app, ipcMain, dialog, powerMonitor, screen } = require('electron');
const { exec } = require('child_process');

// Modules
const { StateManager } = require('./modules/state-manager.cjs');
const { CharacterWindowManager } = require('./modules/character-window-manager.cjs');
const { BubbleWindowManager } = require('./modules/bubble-window-manager.cjs');
const { TrayManager } = require('./modules/tray-manager.cjs');
const { HttpServer } = require('./modules/http-server.cjs');
const { WsClient } = require('./modules/ws-client.cjs');
const { HookInstaller } = require('./modules/hook-installer.cjs');
const { VibemonConfigManager } = require('./modules/vibemon-config-manager.cjs');
const { UpdateChecker } = require('./modules/update-checker.cjs');
const { SettingsWindowManager } = require('./modules/settings-window-manager.cjs');
const { UsageRefresher } = require('./modules/usage-refresher.cjs');
const { validateStatusPayload } = require('./modules/validators.cjs');
const registryCache = require('./shared/registry-cache.cjs');
const {
  HOOK_CHECK_INITIAL_DELAY_MS, HOOK_CHECK_INTERVAL_MS,
  UPDATE_CHECK_INITIAL_DELAY_MS, UPDATE_CHECK_INTERVAL_MS,
  USAGE_REFRESH_INITIAL_DELAY_MS, USAGE_REFRESH_INTERVAL_MS
} = require('./shared/config.cjs');

// Single instance lock - prevent duplicate instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit immediately
  console.log('Another instance is already running. Exiting...');
  app.exit(0);
}

// Initialize managers
const stateManager = new StateManager();
const windowManager = new CharacterWindowManager();
const bubbleWindowManager = new BubbleWindowManager((projectId) => windowManager.getWindow(projectId));
const hookInstaller = new HookInstaller();
const vibemonConfigManager = new VibemonConfigManager();
const updateChecker = new UpdateChecker();
const usageRefresher = new UsageRefresher();
let trayManager = null;
let settingsWindowManager = null;
let httpServer = null;
let wsClient = null;
let hookCheckTimer = null;
let updateCheckTimer = null;
let usageRefreshTimer = null;
let registryRefreshTimer = null;

function getBubbleOptions(projectId) {
  return {
    state: windowManager.getState(projectId),
    speechBubbleFields: windowManager.getSpeechBubbleFields()
  };
}

// Refresh the speech bubble whenever the followed project's state/info changes
windowManager.onStateUpdated = (projectId) => {
  bubbleWindowManager.update(projectId, getBubbleOptions(projectId))
    .catch((err) => console.error('Bubble update failed:', err));
};

// Keep the speech bubble following live while the character window is dragged
windowManager.onWindowMoved = (projectId) => {
  bubbleWindowManager.reposition(projectId);
};

// Speech bubble field toggles re-render the bubble
windowManager.onDisplayModeChanged = () => {
  for (const projectId of windowManager.getProjectIds()) {
    bubbleWindowManager.update(projectId, getBubbleOptions(projectId))
      .catch((err) => console.error('Bubble update failed:', err));
  }
};

// Keep the speech bubble's always-on-top flag matching the character window's
windowManager.onAlwaysOnTopChanged = (projectId) => {
  bubbleWindowManager.syncAlwaysOnTop(projectId);
};

// Handle second instance launch attempt
app.on('second-instance', () => {
  windowManager.showActiveWindow();
});

// Set up state manager callbacks
stateManager.onStateTimeout = (projectId, newState) => {
  // Merge with the registry state so background projects expire too.
  const existingState = windowManager.getRegisteredState(projectId);
  if (!existingState) return;

  const stateData = { ...existingState, state: newState };
  // A timeout is a clock event, not project activity — it must never move
  // focus to (or open a window for) a background project.
  const routeResult = windowManager.routeStatusUpdate(projectId, stateData, { preserveFocus: true });
  if (routeResult.switchedProject) {
    bubbleWindowManager.destroy(routeResult.switchedProject);
  }
  if (routeResult.updateResult.updated) {
    windowManager.sendToWindow(projectId, 'state-update', routeResult.stateData);
  }
  stateManager.setupStateTimeout(projectId, newState);

  if (windowManager.getFocusedProjectId() === projectId) {
    windowManager.updateAlwaysOnTopByState(newState);
  }

  if (trayManager) {
    trayManager.updateIcon();
    trayManager.updateMenu();
  }
};

stateManager.onWindowCloseTimeout = (projectId) => {
  // End of the project's lifecycle (sleep held for the full close window).
  // closeWindow only acts when the window follows this project; drop the
  // project from tracking either way, so background projects don't linger
  // in the registry (and dashboard) as ghost sleep entries.
  windowManager.closeWindow(projectId);
  stateManager.cleanupProject(projectId);
  windowManager.removeProject(projectId);
  bubbleWindowManager.destroy(projectId);
  if (trayManager) {
    trayManager.updateMenu();
    trayManager.updateIcon();
  }
};

// Set up window manager callback for when the window is closed
windowManager.onWindowClosed = (projectId) => {
  stateManager.cleanupProject(projectId);
  bubbleWindowManager.destroy(projectId);
  if (trayManager) {
    trayManager.updateMenu();
    trayManager.updateIcon();
  }
};

/**
 * Handle status update from WebSocket
 * Reuses the same logic as HTTP POST /status
 * @param {Object} data - status payload
 * @param {{auto?: boolean}} [meta] - auto:true marks a clock-driven
 *   transition from the server's state-transition Lambda; like local state
 *   timeouts it must not move focus to (or open a window for) a background
 *   project.
 */
function handleWsStatusUpdate(data, meta = {}) {
  // Validate payload
  const validation = validateStatusPayload(data);
  if (!validation.valid) {
    console.error('WebSocket invalid payload:', validation.error);
    return;
  }

  // Validate and normalize state data via stateManager
  const stateValidation = stateManager.validateStateData(data);
  if (!stateValidation.valid) {
    console.error('WebSocket invalid state data:', stateValidation.error);
    return;
  }
  const stateData = stateValidation.data;

  // A status without a project name has nothing meaningful to display — drop it.
  if (!stateData.project) return;
  const projectId = stateData.project;

  const routeResult = windowManager.routeStatusUpdate(projectId, stateData, {
    preserveFocus: meta.auto === true
  });

  // The window was retargeted from another project
  if (routeResult.switchedProject) {
    bubbleWindowManager.destroy(routeResult.switchedProject);
  }

  const updateResult = routeResult.updateResult;

  // Every accepted update is activity, including unchanged/background updates.
  stateManager.setupStateTimeout(projectId, stateData.state);

  // No visible change - skip unnecessary renderer/tray updates
  if (!updateResult.updated) {
    return;
  }

  // State changed - full update (alwaysOnTop, timeout, tray)
  if (updateResult.stateChanged) {
    windowManager.updateAlwaysOnTopByState(stateData.state);
    if (trayManager) {
      trayManager.updateIcon();
      trayManager.updateMenu();
    }
  }

  // Send update to renderer (routeResult.stateData reflects Character Lock, if set)
  windowManager.sendToWindow(projectId, 'state-update', routeResult.stateData);
}

/**
 * Handle project deletion from WebSocket ({type: 'delete', data: {project}}).
 * Closes the window when it follows the deleted project; windowManager
 * .onWindowClosed cascades into stateManager.cleanupProject and tray
 * refresh, so no extra bookkeeping is needed here. No-op when the window
 * follows another project.
 */
function handleWsStatusDelete(projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return;
  }
  stateManager.cleanupProject(projectId);
  windowManager.removeProject(projectId);
  if (windowManager.getWindow(projectId)) windowManager.closeWindow(projectId);
}

// IPC handlers
ipcMain.handle('get-version', () => {
  return app.getVersion();
});

// Character registry for the renderer's engine setup (canonical:
// vibemon-static, resolved by registry-cache.cjs — cached remote copy or
// bundled fallback). staticBaseUrl lets the renderer build remote-first
// image URLs.
ipcMain.handle('get-character-registry', () => {
  return { ...registryCache.charactersRegistry, staticBaseUrl: registryCache.STATIC_BASE_URL };
});

// State registry for the renderer's engine setup (canonical: vibemon-static,
// resolved by registry-cache.cjs)
ipcMain.handle('get-state-registry', () => {
  return registryCache.statesRegistry;
});

ipcMain.on('show-context-menu', (event) => {
  if (trayManager) {
    trayManager.showContextMenu(event.sender);
  }
});

// Focus terminal (iTerm2 or Ghostty on macOS)
ipcMain.handle('focus-terminal', async (event) => {
  // Only supported on macOS
  if (process.platform !== 'darwin') {
    return { success: false, reason: 'not-macos' };
  }

  // Get project ID from the window that sent the request
  const projectId = windowManager.getProjectIdByWebContents(event.sender);
  if (!projectId) {
    return { success: false, reason: 'no-project' };
  }

  // Get terminal ID for this project
  const terminalId = windowManager.getTerminalId(projectId);
  if (!terminalId) {
    return { success: false, reason: 'no-terminal-id' };
  }

  // Parse terminal type and ID (format: "iterm2:w0t4p0:UUID" or "ghostty:PID")
  const parts = terminalId.split(':');
  if (parts.length < 2) {
    return { success: false, reason: 'invalid-terminal-id-format' };
  }

  const terminalType = parts[0];

  if (terminalType === 'iterm2') {
    // Extract UUID from terminal ID (format: iterm2:w0t4p0:UUID)
    const uuid = parts.length === 3 ? parts[2] : parts[1];
    if (!uuid) {
      return { success: false, reason: 'invalid-terminal-id' };
    }

    // Validate UUID format (8-4-4-4-12 hex) to prevent command injection
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(uuid)) {
      return { success: false, reason: 'invalid-uuid-format' };
    }

    // AppleScript to activate iTerm2 and select the session
    const script = `
      tell application "iTerm2"
        activate
        repeat with aWindow in windows
          repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
              if unique ID of aSession is "${uuid}" then
                select aTab
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not-found"
      end tell
    `;

    return new Promise((resolve) => {
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, stdout) => {
        if (error) {
          resolve({ success: false, reason: 'applescript-error', error: error.message });
        } else {
          const result = stdout.trim();
          resolve({ success: result === 'ok', reason: result });
        }
      });
    });
  } else if (terminalType === 'ghostty') {
    // Extract PID from terminal ID (format: ghostty:PID)
    const pid = parts[1];
    if (!pid || !/^\d+$/.test(pid)) {
      return { success: false, reason: 'invalid-ghostty-pid' };
    }

    // For Ghostty, we can only activate the application
    // Ghostty doesn't expose session/PID information via AppleScript
    // so we can't programmatically switch to a specific tab like iTerm2
    const script = `
      tell application "Ghostty"
        activate
      end tell
    `;

    return new Promise((resolve) => {
      exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, _stdout) => {
        if (error) {
          resolve({ success: false, reason: 'applescript-error', error: error.message });
        } else {
          // Successfully activated Ghostty app
          // Note: User will need to manually navigate to the correct tab
          resolve({ success: true, reason: 'activated', note: 'app-activated-only' });
        }
      });
    });
  } else {
    return { success: false, reason: 'unsupported-terminal-type' };
  }
});

// App lifecycle
app.whenReady().then(() => {
  // Hide Dock icon on macOS (tray-only app)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // Create tray (the window is created on demand via HTTP /status endpoint)
  trayManager = new TrayManager(windowManager, app, stateManager);
  trayManager.createTray();

  // Settings window (opened from the tray menu)
  settingsWindowManager = new SettingsWindowManager({ windowManager, app, hookInstaller, vibemonConfigManager, updateChecker });
  settingsWindowManager.onSettingsChanged = () => {
    if (trayManager) {
      trayManager.updateMenu();
      trayManager.updateIcon();
    }
  };
  trayManager.setSettingsWindowManager(settingsWindowManager);

  // Start HTTP server
  httpServer = new HttpServer(stateManager, windowManager, app);
  httpServer.onStateUpdate = (menuOnly) => {
    if (trayManager) {
      if (!menuOnly) {
        trayManager.updateIcon();
      }
      trayManager.updateMenu();
    }
  };
  httpServer.onProjectSwitched = (oldProjectId) => {
    bubbleWindowManager.destroy(oldProjectId);
  };
  httpServer.onError = (err) => {
    if (err.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'VibeMon - Port Conflict',
        'Port 19280 is already in use.\nAnother instance may be running.\n\nThe app will continue but HTTP API won\'t work.'
      );
    }
  };
  httpServer.start();

  // Start WebSocket client (if configured)
  wsClient = new WsClient();
  wsClient.onStatusUpdate = (data, meta) => {
    handleWsStatusUpdate(data, meta);
  };
  wsClient.onStatusDelete = (projectId) => {
    handleWsStatusDelete(projectId);
  };
  wsClient.onConnectionChange = () => {
    if (trayManager) {
      trayManager.updateMenu();
    }
  };

  // Set wsClient reference in trayManager for status display
  trayManager.setWsClient(wsClient);
  trayManager.setHookInstaller(hookInstaller);
  trayManager.setUpdateChecker(updateChecker);
  settingsWindowManager.setWsClient(wsClient);
  updateChecker.onStateChanged = () => {
    if (trayManager) {
      trayManager.updateIcon();
      trayManager.updateMenu();
    }
    if (settingsWindowManager) {
      settingsWindowManager.notifyUpdateStateChanged();
    }
  };

  wsClient.connect();

  // Detect AI tools missing VibeMon hooks: once shortly after startup, then
  // periodically so tools installed later are picked up too. Also keeps
  // ~/.vibemon/config.json pointed at this app, since a hook file can be
  // present while that shared config is missing or stale.
  setTimeout(() => {
    vibemonConfigManager.ensureDesktopUrl(wsClient.getToken());
    hookInstaller.checkAndPrompt(wsClient.getToken())
      .catch((err) => console.error('Hook check failed:', err));
  }, HOOK_CHECK_INITIAL_DELAY_MS);
  hookCheckTimer = setInterval(
    () => {
      vibemonConfigManager.ensureDesktopUrl(wsClient.getToken());
      hookInstaller.checkAndPrompt(wsClient.getToken())
        .catch((err) => console.error('Hook check failed:', err));
    },
    HOOK_CHECK_INTERVAL_MS
  );

  // Detect new VibeMon releases: once shortly after startup, then
  // periodically. Installing only happens when the user clicks the tray's
  // "Update to vX" item.
  setTimeout(() => updateChecker.checkForUpdates(), UPDATE_CHECK_INITIAL_DELAY_MS);
  updateCheckTimer = setInterval(() => updateChecker.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);

  // Refresh the shared plan-usage cache (~/.vibemon/cache/usage.json) via
  // ~/.vibemon/usage.py: once shortly after startup, then periodically, so
  // usage data stays fresh even when no Claude Code session is running.
  // The tray menu's Claude/Codex usage rows read that cache fresh on every
  // build, so a successful refresh is followed by a menu rebuild to surface
  // the new numbers right away.
  const refreshUsageAndUpdateTray = () => usageRefresher.refresh().then((result) => {
    if (result.ok && trayManager) {
      trayManager.updateMenu();
    }
  });
  setTimeout(refreshUsageAndUpdateTray, USAGE_REFRESH_INITIAL_DELAY_MS);
  usageRefreshTimer = setInterval(refreshUsageAndUpdateTray, USAGE_REFRESH_INTERVAL_MS);

  // Refresh the canonical registry cache from vibemon-static: once shortly
  // after startup, then periodically. A refreshed registry applies on the
  // next launch (startup resolves cache → bundled synchronously).
  setTimeout(() => registryCache.refresh(), UPDATE_CHECK_INITIAL_DELAY_MS);
  registryRefreshTimer = setInterval(() => registryCache.refresh(), UPDATE_CHECK_INTERVAL_MS);

  // Screen lock, system sleep, and display attach/detach make macOS move
  // windows itself (e.g. onto the primary display while another display
  // sleeps). Those moves must not be persisted as the user's position, and
  // the window is put back at its saved position once displays are back.
  powerMonitor.on('lock-screen', () => windowManager.suspendPositionTracking());
  powerMonitor.on('suspend', () => windowManager.suspendPositionTracking());
  powerMonitor.on('unlock-screen', () => windowManager.restoreWindowPosition());
  powerMonitor.on('resume', () => windowManager.restoreWindowPosition());
  screen.on('display-added', () => {
    windowManager.suspendPositionTracking();
    windowManager.restoreWindowPosition();
  });
  screen.on('display-removed', () => {
    windowManager.suspendPositionTracking();
    windowManager.restoreWindowPosition();
  });

  app.on('activate', () => {
    windowManager.showActiveWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep app running in tray on macOS
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (hookCheckTimer) {
    clearInterval(hookCheckTimer);
    hookCheckTimer = null;
  }
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
  }
  if (registryRefreshTimer) {
    clearInterval(registryRefreshTimer);
    registryRefreshTimer = null;
  }

  // Null callbacks first to prevent any fired timers from triggering updates
  stateManager.onStateTimeout = null;
  stateManager.onWindowCloseTimeout = null;
  windowManager.onWindowClosed = null;
  windowManager.onStateUpdated = null;
  windowManager.onWindowMoved = null;
  windowManager.onDisplayModeChanged = null;
  windowManager.onAlwaysOnTopChanged = null;

  stateManager.cleanup();
  windowManager.cleanup();
  bubbleWindowManager.cleanup();
  if (trayManager) {
    trayManager.cleanup();
  }
  if (settingsWindowManager) {
    settingsWindowManager.cleanup();
  }
  if (httpServer) {
    httpServer.stop();
  }
  if (wsClient) {
    wsClient.cleanup();
  }
});
