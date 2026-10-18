/**
 * VibeMon - Main Process Entry Point
 *
 * This file orchestrates the application by connecting modules:
 * - StateManager: State and timer management (per-project timers)
 * - CharacterWindowManager: The single character window and per-project state registry
 * - BubbleWindowManager: The speech bubble that follows the character window
 * - TrayManager: System tray icon and menu
 * - HttpServer: HTTP API server
 * - WidgetPublisher: The feed that the macOS widgets read
 */

// Load environment variables from .env.local or .env
const path = require('path');
const Store = require('electron-store');
for (const name of ['.env.local', '.env']) {
  try { process.loadEnvFile(path.join(__dirname, '..', name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const { app, ipcMain, dialog, powerMonitor, screen, safeStorage, shell } = require('electron');
const os = require('node:os');
const { MonitoringClient } = require('./monitoring/client.cjs');
const { CredentialStore } = require('./monitoring/credential-store.cjs');
const { WebSignIn } = require('./monitoring/web-sign-in.cjs');
const { WorkspaceWindow } = require('./workspace/window.cjs');
const { getAccountProfiles } = require('./modules/account-profiles.cjs');
const { WorkspaceSettings } = require('./workspace/settings.cjs');
const { localActivity } = require('./workspace/activity.cjs');
const { attentionAreas, attentionNotices } = require('./shared/attention.cjs');
const { installWorkspaceMenu } = require('./workspace/menu.cjs');
const { t, initLocale, currentLocale } = require('./shared/i18n/locale.cjs');
const { dashboardPage } = require('./workspace/deep-link.cjs');
const { getUsageSnapshot } = require('./modules/usage-cache-reader.cjs');
const { WidgetPublisher, usageByAccount, widgetsSupported } = require('./widgets/publisher.cjs');
const { prepareWidgetRuntime } = require('./widgets/runtime.cjs');
const { execFile } = require('child_process');

// Modules
const { StateManager } = require('./modules/state-manager.cjs');
const { CharacterWindowManager } = require('./modules/character-window-manager.cjs');
const { BubbleWindowManager } = require('./modules/bubble-window-manager.cjs');
const { DockMonitor } = require('./modules/dock-monitor.cjs');
const { TrayManager } = require('./modules/tray-manager.cjs');
const { HttpServer } = require('./modules/http-server.cjs');
const { HookInstaller } = require('./modules/hook-installer.cjs');
const { VibemonConfigManager } = require('./modules/vibemon-config-manager.cjs');
const { HookCloudDelivery } = require('./modules/hook-cloud-delivery.cjs');
const { UpdateChecker } = require('./modules/update-checker.cjs');
const { UsageRefresher } = require('./modules/usage-refresher.cjs');
const { StatusIngress } = require('./application/status-ingress.cjs');
const { interactionTarget } = require('./modules/window-interaction-target.cjs');
const registryCache = require('./shared/registry-cache.cjs');
const {
  CHARACTER_CONFIG, CHARACTER_IMAGE_FETCH_TIMEOUT_MS, CHARACTER_IMAGE_MAX_BYTES, CHARACTER_IMAGE_SIZES,
  HOOK_CHECK_INITIAL_DELAY_MS, HOOK_CHECK_INTERVAL_MS, HTTP_PORT,
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
const dockMonitor = new DockMonitor();
const windowManager = new CharacterWindowManager({ dockMonitor: process.platform === 'darwin' ? dockMonitor : null });
const bubbleWindowManager = new BubbleWindowManager(
  (projectId) => windowManager.getWindow(projectId),
  () => windowManager.getEdgeMargin(),
  () => windowManager.getDisplayOptions().characterScale / 100,
  { getLayout: () => windowManager.dockLayout, setBubbleSize: size => windowManager.setBubbleSize(size) }
);
dockMonitor.onChange = () => windowManager.refreshDockLayout();
const hookInstaller = new HookInstaller();
const vibemonConfigManager = new VibemonConfigManager({ allowLocalHttp: !app.isPackaged });
const updateChecker = new UpdateChecker();
const usageRefresher = new UsageRefresher();
let trayManager = null;
let workspaceSettings = null;
let httpServer = null;
let monitoringClient = null;
let workspaceWindow = null;
let webSignIn = null;
let widgetPublisher = null;
let quitting = false;
let hookCheckTimer = null;
let updateCheckTimer = null;
let usageRefreshTimer = null;
let registryRefreshTimer = null;

function getBubbleOptions(projectId) {
  const source = projectId?.startsWith('cloud:')
    ? monitoringClient?.sources.find(source => `cloud:${source.sourceId}` === projectId)
    : null;
  return {
    state: windowManager.getState(projectId),
    observedAt: source?.observedAt || windowManager.getRegisteredState(projectId)?.observedAt,
    now: source ? monitoringClient.currentTime() : Date.now(),
    speechBubbleFields: windowManager.getSpeechBubbleFields()
  };
}

// Local activity feeds the workspace and the widgets.
function activityChanged() {
  workspaceWindow?.notify('activity');
  widgetPublisher?.schedule();
}

// Refresh the speech bubble whenever the followed project's state/info changes
windowManager.onRegistryChanged = activityChanged;
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
  workspaceWindow?.open('overview');
});

// A widget click opens its Dashboard page. A link can arrive before the
// workspace exists when it launches the App; the page then opens once ready.
let pendingPage = null;
app.on('open-url', (event, link) => {
  event.preventDefault();
  const page = dashboardPage(link);
  if (!page) return;
  if (workspaceWindow) workspaceWindow.open(page);
  else pendingPage = page;
});

// Set up state manager callbacks
stateManager.onStateTimeout = (projectId, newState) => {
  activityChanged();
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
  activityChanged();
  bubbleWindowManager.destroy(projectId);
  if (trayManager) {
    trayManager.updateMenu();
    trayManager.updateIcon();
  }
};

// Set up window manager callback for when the window is closed
windowManager.onWindowClosed = (projectId) => {
  activityChanged();
  // Activity expires independently of the companion's visibility.
  bubbleWindowManager.destroy(projectId);
  if (trayManager) {
    trayManager.updateMenu();
    trayManager.updateIcon();
  }
};

function notifyStatusChange(menuOnly) {
  activityChanged();
  if (!menuOnly) trayManager?.updateIcon();
  trayManager?.updateMenu();
}
const statusIngress = new StatusIngress(stateManager, windowManager, {
  onProjectSwitched: id => bubbleWindowManager.destroy(id),
  onStateUpdate: notifyStatusChange
});

/**
 * Tray action "Show Character": reopen the character window — and its
 * speech bubble — after they closed (the sleep close-timeout or a manual
 * close / POST /close). restoreLastWindow recreates the window from the
 * last displayed state (or a default) through the normal routing pipeline,
 * which brings the bubble back via onStateUpdated; here we re-arm the
 * project's state timers and refresh the tray.
 */
function showCharacterAgain() {
  const restored = windowManager.restoreLastWindow();
  if (!restored) return;

  if (restored.stateData) {
    stateManager.setupStateTimeout(restored.projectId, restored.stateData.state, { remote: Boolean(restored.projectId?.startsWith('cloud:')) });
  }
  if (trayManager) {
    trayManager.updateMenu();
    trayManager.updateIcon();
  }
}

// IPC handlers
ipcMain.handle('get-version', () => {
  return app.getVersion();
});

// Character registry for the renderer's engine setup (canonical:
// the public App distribution, resolved by registry-cache.cjs — cached remote copy or
// bundled fallback). Only images absent from the package require a download.
ipcMain.handle('get-character-registry', () => {
  return {
    ...registryCache.charactersRegistry,
    staticBaseUrl: registryCache.STATIC_BASE_URL,
    imageFetchTimeoutMs: CHARACTER_IMAGE_FETCH_TIMEOUT_MS,
    imageMaxBytes: CHARACTER_IMAGE_MAX_BYTES, imageSizes: CHARACTER_IMAGE_SIZES,
    bundledImageFiles: registryCache.bundledImageFiles
  };
});

// State registry for the renderer's engine setup (canonical: the public App distribution,
// resolved by registry-cache.cjs)
ipcMain.handle('get-state-registry', () => {
  return registryCache.statesRegistry;
});

// Which engine the renderer should boot: '2d' pixel-art or '3d' pet
ipcMain.handle('get-render-mode', () => {
  return windowManager.getRenderMode();
});

// How the character window draws itself: the Character Size scale it applies
// with CSS, and whether dev mode tints its display area. Later changes are
// pushed over the 'display-options' channel.
ipcMain.handle('get-display-options', () => {
  return windowManager.getDisplayOptions();
});

ipcMain.on('show-context-menu', (event) => {
  if (trayManager) {
    trayManager.showContextMenu(event.sender);
  }
});

const getInteractionTarget = sender => interactionTarget(sender, windowManager, bubbleWindowManager);

ipcMain.on('window-ignore-mouse', (event, ignore) => {
  const target = getInteractionTarget(event.sender);
  if (target && typeof ignore === 'boolean') target.window.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('window-drag-start', (event) => {
  const target = getInteractionTarget(event.sender);
  if (target) windowManager.beginUserDrag(target.window);
});
ipcMain.on('window-drag-move', (event) => {
  const target = getInteractionTarget(event.sender);
  if (target) windowManager.moveUserDrag(target.window);
});
ipcMain.on('window-drag-end', (event) => {
  const target = getInteractionTarget(event.sender);
  if (target) windowManager.endUserDrag(target.window);
});

// Focus terminal (iTerm2 or Ghostty on macOS)
// osascript receives the script as one argument, so no shell parses it.
function runAppleScript(script) {
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-e', script], (error, stdout) => resolve({ error, stdout: String(stdout || '') }));
  });
}

ipcMain.handle('focus-terminal', async (event) => {
  // Only supported on macOS
  if (process.platform !== 'darwin') {
    return { success: false, reason: 'not-macos' };
  }

  // Get project ID from the window that sent the request
  const projectId = getInteractionTarget(event.sender)?.projectId;
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

    const { error, stdout } = await runAppleScript(script);
    if (error) return { success: false, reason: 'applescript-error', error: error.message };
    const result = stdout.trim();
    return { success: result === 'ok', reason: result };
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

    const { error } = await runAppleScript(script);
    if (error) return { success: false, reason: 'applescript-error', error: error.message };
    // The user still selects the tab: Ghostty exposes no session lookup.
    return { success: true, reason: 'activated', note: 'app-activated-only' };
  } else {
    return { success: false, reason: 'unsupported-terminal-type' };
  }
});

/**
 * WidgetKit accepts reload requests only from the main executable of the app
 * that contains the widgets, so a Node-API module makes the request from this
 * process. An unpackaged Electron binary contains no VibeMon widgets.
 */
async function widgetReloader() {
  if (!app.isPackaged) return null;
  try {
    const native = require(path.join(process.resourcesPath, 'widget-center.node'));
    await prepareWidgetRuntime({
      bundlePath: path.resolve(path.dirname(process.execPath), '../..'),
      registerApplication: native.registerApplication
    });
    return native.reloadTimelines;
  } catch (error) {
    console.error('Could not prepare the macOS widget runtime:', error.message);
    return null;
  }
}

// App lifecycle
app.whenReady().then(async () => {
  // The OS languages are complete only after 'ready'; every later text uses them.
  initLocale(app);
  // Hide Dock icon on macOS (tray-only app)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // Tray menu actions open the workspace; status ingress creates the companion on demand.
  trayManager = new TrayManager(windowManager, app);

  const cloudDelivery = new HookCloudDelivery({ configManager: vibemonConfigManager, allowLocalHttp: !app.isPackaged });
  workspaceSettings = new WorkspaceSettings({ windowManager, app, hookInstaller, vibemonConfigManager, updateChecker, cloudDelivery, getAccountProfiles, openExternal: url => shell.openExternal(url) });
  const monitoringStore = new Store({ name: 'monitoring' });
  monitoringClient = new MonitoringClient({ preferences: monitoringStore, credentials: new CredentialStore(monitoringStore, safeStorage), allowLocalHttp: !app.isPackaged });
  webSignIn = new WebSignIn({ port: HTTP_PORT, openExternal: url => shell.openExternal(url), allowLocalHttp: !app.isPackaged, deviceName: os.hostname().split('.')[0] });
  workspaceWindow = new WorkspaceWindow({
    monitoring: monitoringClient,
    settings: workspaceSettings,
    signIn: webSignIn,
    getActivity: () => localActivity(windowManager.getRegisteredStates(), windowManager.getWindowCount() ? windowManager.getFocusedProjectId() : null),
    getUsage: () => getUsageSnapshot(),
    showCompanion: showCharacterAgain,
    reportError: error => dialog.showErrorBox(t('dialog.workspaceFailed'), error.message)
  });
  // Every source of an issue lands here: cloud polls, settings, hooks, updates.
  const refreshAttention = () => trayManager.setAttention(attentionNotices(attentionAreas(monitoringClient.snapshot(), workspaceSettings.getSnapshot())));
  workspaceSettings.onSettingsChanged = () => {
    workspaceWindow.notify('settings');
    refreshAttention();
  };
  cloudDelivery.onChange = () => workspaceSettings.notifyChanged();
  trayManager.openDashboard = () => workspaceWindow.open('overview');
  if (pendingPage) workspaceWindow.open(pendingPage);
  pendingPage = null;
  trayManager.openSettings = page => workspaceWindow.open(page || 'companion');
  installWorkspaceMenu({ open: page => workspaceWindow.open(page), showCompanion: showCharacterAgain });
  trayManager.setShowCharacterHandler(showCharacterAgain);
  trayManager.createTray();
  const cloudActivity = statusIngress.cloudActivity(() => monitoringClient.currentTime());
  monitoringClient.on('change', snapshot => {
    cloudActivity.accept(snapshot.sources);
    widgetPublisher?.schedule();
    refreshAttention();
    for (const projectId of windowManager.getProjectIds()) {
      bubbleWindowManager.refresh(projectId, getBubbleOptions(projectId))
        .catch(err => console.error('Bubble countdown refresh failed:', err));
    }
  });
  monitoringClient.start();

  if (widgetsSupported()) {
    // feed.mjs is an ES module that shares the renderer's display rules.
    const { buildWidgetFeed } = require('./widgets/feed.mjs');
    const reload = await widgetReloader();
    if (quitting) return;
    widgetPublisher = new WidgetPublisher({
      collect: () => ({ cloud: monitoringClient.snapshot(), states: windowManager.getRegisteredStates(), usage: usageByAccount(getUsageSnapshot()) }),
      build: input => buildWidgetFeed({ ...input, locale: currentLocale() }),
      reload,
      artwork: character => CHARACTER_CONFIG[character]?.image
    });
    widgetPublisher.schedule();
  }


  // Start HTTP server
  httpServer = new HttpServer(stateManager, windowManager, app, statusIngress);
  httpServer.onStateUpdate = notifyStatusChange;
  httpServer.webSignIn = webSignIn;
  httpServer.onError = (err) => {
    if (err.code === 'EADDRINUSE') {
      dialog.showErrorBox(t('dialog.portConflict.title'), t('dialog.portConflict.message', { port: HTTP_PORT }));
    }
  };
  httpServer.start();

  hookInstaller.onStateChanged = () => {
    workspaceWindow?.notify('settings');
    refreshAttention();
  };
  updateChecker.onStateChanged = () => {
    workspaceWindow?.notify('settings');
    refreshAttention();
  };
  refreshAttention();

  // Detect AI tools missing VibeMon hooks: once shortly after startup, then
  // periodically so tools installed later are picked up too. Also keeps
  // ~/.vibemon/config.json pointed at this app, since a hook file can be
  // present while that shared config is missing or stale. The same cycle
  // compares installed hook/script files against the published manifest and
  // updates drifted ones; broken registrations surface in the tray badge and
  // Settings > Integrations.
  const runHookCheck = () => {
    vibemonConfigManager.ensureDesktopUrl(null);
    hookInstaller.checkAndPrompt(null)
      .catch((err) => console.error('Hook check failed:', err));
    hookInstaller.updateChanged()
      .then(() => {
        workspaceWindow?.notify('settings');
        refreshAttention();
      })
      .catch((err) => console.error('Hook change check failed:', err));
  };
  setTimeout(runHookCheck, HOOK_CHECK_INITIAL_DELAY_MS);
  hookCheckTimer = setInterval(runHookCheck, HOOK_CHECK_INTERVAL_MS);

  // Detect new VibeMon releases: once shortly after startup, then
  // periodically. Installing requires the update action in Settings > About.
  const checkForUpdates = () => updateChecker.checkForUpdates().catch(error => console.error('Update check failed:', error.message));
  setTimeout(checkForUpdates, UPDATE_CHECK_INITIAL_DELAY_MS);
  updateCheckTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);

  // Refresh the shared plan-usage cache (~/.vibemon/cache/usage.json) via
  // ~/.vibemon/usage.py: once shortly after startup, then periodically, so
  // usage data stays fresh even when no Claude Code session is running.
  // A partial refresh can update some accounts while others need login.
  const refreshUsage = () => usageRefresher.refresh().then(() => {
    workspaceWindow?.notify('usage');
    workspaceWindow?.notify('settings');
    widgetPublisher?.schedule();
  });
  setTimeout(refreshUsage, USAGE_REFRESH_INITIAL_DELAY_MS);
  usageRefreshTimer = setInterval(refreshUsage, USAGE_REFRESH_INTERVAL_MS);

  // Refresh the canonical registry cache from the public App distribution: once shortly
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
  const restoreOverlayPosition = () => dockMonitor.refresh().then(() => windowManager.restoreWindowPosition());
  powerMonitor.on('unlock-screen', restoreOverlayPosition);
  powerMonitor.on('resume', restoreOverlayPosition);
  screen.on('display-added', () => {
    windowManager.suspendPositionTracking();
    restoreOverlayPosition();
  });
  screen.on('display-removed', () => {
    windowManager.suspendPositionTracking();
    restoreOverlayPosition();
  });
  screen.on('display-metrics-changed', () => {
    dockMonitor.refresh().then(() => windowManager.refreshDockLayout());
  });
  dockMonitor.start(() => windowManager.isNearBottomCorner());

  app.on('activate', () => {
    workspaceWindow.open('overview');
  });
});

app.on('window-all-closed', () => {
  // Keep app running in the system tray on all platforms;
  // quitting is handled by the tray menu, POST /quit, and the updater
});

app.on('before-quit', () => {
  quitting = true;
  dockMonitor.cleanup();
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
  // Before monitoring stops: the last feed keeps the final readings.
  widgetPublisher?.stop();
  if (monitoringClient) monitoringClient.stop();
  if (workspaceWindow) workspaceWindow.cleanup();
  if (httpServer) {
    httpServer.stop();
  }
});
