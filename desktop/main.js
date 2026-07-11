/**
 * VibeMon - Main Process Entry Point
 *
 * This file orchestrates the application by connecting modules:
 * - StateManager: State and timer management (per-project timers)
 * - MultiWindowManager: Multi-window creation and management (one per project)
 * - TrayManager: System tray icon and menu
 * - HttpServer: HTTP API server
 */

// Load environment variables from .env.local or .env
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, ipcMain, BrowserWindow, dialog } = require('electron');
const { exec } = require('child_process');

// Modules
const { StateManager } = require('./modules/state-manager.cjs');
const { MultiWindowManager } = require('./modules/multi-window-manager.cjs');
const { BubbleWindowManager } = require('./modules/bubble-window-manager.cjs');
const { TrayManager } = require('./modules/tray-manager.cjs');
const { HttpServer } = require('./modules/http-server.cjs');
const { WsClient } = require('./modules/ws-client.cjs');
const { HookInstaller } = require('./modules/hook-installer.cjs');
const { UpdateChecker } = require('./modules/update-checker.cjs');
const { validateStatusPayload } = require('./modules/validators.cjs');
const { MAX_WINDOWS, HOOK_CHECK_INTERVAL_MS, UPDATE_CHECK_INTERVAL_MS } = require('./shared/config.cjs');

// Initial hook-installer check runs shortly after startup so the tray/HTTP
// server/WebSocket client are fully initialized before any dialog appears.
const HOOK_CHECK_INITIAL_DELAY_MS = 5000;
// Staggered slightly after the hook-installer check so both don't fire in
// the same tick.
const UPDATE_CHECK_INITIAL_DELAY_MS = 10000;

// Single instance lock - prevent duplicate instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit immediately
  console.log('Another instance is already running. Exiting...');
  app.exit(0);
}

// Initialize managers
const stateManager = new StateManager();
const windowManager = new MultiWindowManager();
const bubbleWindowManager = new BubbleWindowManager((projectId) => windowManager.getWindow(projectId));
const hookInstaller = new HookInstaller();
const updateChecker = new UpdateChecker();
let trayManager = null;
let httpServer = null;
let wsClient = null;
let hookCheckTimer = null;
let updateCheckTimer = null;

function getBubbleOptions(projectId) {
  return {
    state: windowManager.getState(projectId),
    speechBubbleFields: windowManager.getSpeechBubbleFields(),
    characterOnlyMode: windowManager.isCharacterMode()
  };
}

// Refresh a project's speech bubble whenever its state/info changes
windowManager.onStateUpdated = (projectId) => {
  bubbleWindowManager.update(projectId, getBubbleOptions(projectId));
};

// Keep the speech bubble following live while its character window is dragged
windowManager.onWindowMoved = (projectId) => {
  bubbleWindowManager.reposition(projectId);
};

// Character Only Mode / speech bubble field toggles affect every open window
windowManager.onDisplayModeChanged = () => {
  for (const projectId of windowManager.getProjectIds()) {
    bubbleWindowManager.update(projectId, getBubbleOptions(projectId));
  }
};

// Keep the speech bubble's always-on-top flag matching its character window's
windowManager.onAlwaysOnTopChanged = (projectId) => {
  bubbleWindowManager.syncAlwaysOnTop(projectId);
};

// After leaving Input Mode, replay every project's last known state through
// the normal ingestion pipeline so windows reappear immediately instead of
// waiting for the next external status update.
windowManager.onResyncNeeded = () => {
  for (const stateData of Object.values(windowManager.getRegisteredStates())) {
    handleWsStatusUpdate(stateData);
  }
};

// Handle second instance launch attempt
app.on('second-instance', () => {
  // Focus the first window if available
  const first = windowManager.getFirstWindow();
  if (first && !first.isDestroyed()) {
    if (first.isMinimized()) first.restore();
    first.show();
    first.focus();
  }
});

// Set up state manager callbacks
stateManager.onStateTimeout = (projectId, newState) => {
  // Merge with existing state to preserve project, model, memory, etc.
  const existingState = windowManager.getState(projectId);
  if (!existingState) return;  // Window no longer exists

  const stateData = { ...existingState, state: newState };

  // updateState returns false if window doesn't exist (handles race condition)
  if (!windowManager.updateState(projectId, stateData)) return;

  windowManager.sendToWindow(projectId, 'state-update', stateData);
  stateManager.setupStateTimeout(projectId, newState);

  // Update always on top based on new state and rearrange windows
  windowManager.updateAlwaysOnTopByState(projectId, newState);
  windowManager.rearrangeWindows();

  if (trayManager) {
    trayManager.updateIcon();
    trayManager.updateMenu();
  }
};

stateManager.onWindowCloseTimeout = (projectId) => {
  windowManager.closeWindow(projectId);
};

// Set up window manager callback for when windows are closed
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
 */
function handleWsStatusUpdate(data) {
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

  // Get projectId from data or use default
  const projectId = stateData.project || 'default';

  const routeResult = windowManager.routeStatusUpdate(projectId, stateData);

  // Blocked by lock in single mode
  if (routeResult.blocked) {
    return;
  }

  // No window created (max limit in multi mode)
  if (routeResult.maxWindowsReached) {
    console.log(`WebSocket: Max windows limit (${MAX_WINDOWS}) reached`);
    return;
  }

  // Project was switched in single mode
  if (routeResult.switchedProject) {
    stateManager.cleanupProject(routeResult.switchedProject);
    bubbleWindowManager.destroy(routeResult.switchedProject);
  }

  const updateResult = routeResult.updateResult;

  // No change - skip unnecessary updates
  if (!updateResult.updated) {
    return;
  }

  // State changed - full update (alwaysOnTop, rearrange, timeout, tray)
  if (updateResult.stateChanged) {
    windowManager.updateAlwaysOnTopByState(projectId, stateData.state);
    windowManager.rearrangeWindows();
    stateManager.setupStateTimeout(projectId, stateData.state);

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
 * Closes the window for the deleted project; windowManager.onWindowClosed
 * cascades into stateManager.cleanupProject and tray refresh, so no extra
 * bookkeeping is needed here. No-op when the project is unknown locally.
 */
function handleWsStatusDelete(projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return;
  }
  if (!windowManager.getWindow(projectId)) {
    return;
  }
  windowManager.closeWindow(projectId);
}

// IPC handlers
ipcMain.handle('get-version', () => {
  return app.getVersion();
});

// Renderer's engine/image loading is async and can outlast the main
// process's one-shot 'display-mode-update' push sent at window ready-to-show,
// dropping that event if the renderer's listener isn't registered yet. This
// lets the renderer pull the current settings once it's actually ready.
ipcMain.handle('get-display-mode', () => {
  return {
    characterOnlyMode: windowManager.isCharacterMode(),
    speechBubbleFields: windowManager.getSpeechBubbleFields()
  };
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.close();
  }
});

ipcMain.on('minimize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.minimize();
  }
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

  // Create tray (windows are created on demand via HTTP /status endpoint)
  trayManager = new TrayManager(windowManager, app);
  trayManager.createTray();

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
  wsClient.onStatusUpdate = (data) => {
    handleWsStatusUpdate(data);
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
  updateChecker.onStateChanged = () => {
    if (trayManager) {
      trayManager.updateIcon();
      trayManager.updateMenu();
    }
  };

  wsClient.connect();

  // Detect AI tools missing VibeMon hooks: once shortly after startup, then
  // periodically so tools installed later are picked up too.
  setTimeout(() => hookInstaller.checkAndPrompt(wsClient.getToken()), HOOK_CHECK_INITIAL_DELAY_MS);
  hookCheckTimer = setInterval(
    () => hookInstaller.checkAndPrompt(wsClient.getToken()),
    HOOK_CHECK_INTERVAL_MS
  );

  // Detect new VibeMon releases: once shortly after startup, then
  // periodically. Installing only happens when the user clicks the tray's
  // "Update to vX" item.
  setTimeout(() => updateChecker.checkForUpdates(), UPDATE_CHECK_INITIAL_DELAY_MS);
  updateCheckTimer = setInterval(() => updateChecker.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);

  app.on('activate', () => {
    const first = windowManager.getFirstWindow();
    if (first && !first.isDestroyed()) {
      first.show();
      first.focus();
    }
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
  if (httpServer) {
    httpServer.stop();
  }
  if (wsClient) {
    wsClient.cleanup();
  }
});
