/**
 * HTTP server for Vibe Monitor (Multi-Window)
 */

const http = require('http');
const fsPromises = require('fs').promises;
const path = require('path');
const { HTTP_PORT, MAX_PAYLOAD_SIZE, MAX_WINDOWS, STATS_CACHE_PATH } = require('../shared/config.cjs');
const { setCorsHeaders, sendJson, sendError, parseJsonBody } = require('./http-utils.cjs');
const { validateStatusPayload } = require('./validators.cjs');

// Rate limiting configuration
const RATE_LIMIT = 100;       // Max requests per window
const RATE_WINDOW_MS = 60000; // 1 minute window
const RATE_CLEANUP_THRESHOLD = 100;  // Cleanup when map exceeds this size

class HttpServer {
  constructor(stateManager, windowManager, app) {
    this.server = null;
    this.stateManager = stateManager;
    this.windowManager = windowManager;
    this.app = app;
    this.onStateUpdate = null;  // Callback for menu/icon updates
    this.onProjectSwitched = null;  // Callback: (oldProjectId) => void, single-mode window reuse
    this.onError = null;        // Callback for server errors

    // Rate limiting state
    this.requestCounts = new Map();  // IP -> { count, resetTime }
  }

  /**
   * Cleanup expired rate limit entries to prevent memory leak
   */
  cleanupExpiredRateLimits() {
    const now = Date.now();
    for (const [ip, record] of this.requestCounts) {
      if (now > record.resetTime) {
        this.requestCounts.delete(ip);
      }
    }
  }

  /**
   * Check rate limit for an IP address
   * @param {string} ip
   * @returns {boolean} true if allowed, false if rate limited
   */
  checkRateLimit(ip) {
    // Cleanup expired entries when map gets large
    if (this.requestCounts.size > RATE_CLEANUP_THRESHOLD) {
      this.cleanupExpiredRateLimits();
    }

    const now = Date.now();
    const record = this.requestCounts.get(ip);

    if (!record || now > record.resetTime) {
      // New window or expired - reset counter
      this.requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW_MS });
      return true;
    }

    if (record.count >= RATE_LIMIT) {
      return false;  // Rate limited
    }

    record.count++;
    return true;
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('Unhandled request error:', err.message);
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error');
        }
      });
    });

    this.server.on('error', (err) => {
      console.error('HTTP Server error:', err.message);
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${HTTP_PORT} is already in use`);
      }
      // Notify error callback if registered
      if (this.onError) {
        this.onError(err);
      }
    });

    this.server.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log(`Vibe Monitor HTTP server running on http://127.0.0.1:${HTTP_PORT}`);
    });

    return this.server;
  }

  stop() {
    return new Promise((resolve) => {
      // Clear rate limiting state
      this.requestCounts.clear();

      if (!this.server) {
        resolve();
        return;
      }

      const forceCloseTimeout = setTimeout(() => {
        console.warn('HTTP server close timeout, forcing shutdown');
        resolve();
      }, 5000);

      this.server.close((err) => {
        clearTimeout(forceCloseTimeout);
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error('HTTP server close error:', err.message);
        }
        this.server = null;
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    setCorsHeaders(res, req);

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Rate limiting check
    const ip = req.socket.remoteAddress || '127.0.0.1';
    if (!this.checkRateLimit(ip)) {
      sendError(res, 429, 'Too many requests');
      return;
    }

    const route = `${req.method} ${req.url}`;

    switch (route) {
      case 'GET /':
        await this.handleGetDashboard(res);
        break;
      case 'GET /dashboard-data':
        this.handleGetDashboardData(res);
        break;
      case 'POST /status':
        await this.handlePostStatus(req, res);
        break;
      case 'GET /status':
        this.handleGetStatus(res);
        break;
      case 'GET /windows':
        this.handleGetWindows(res);
        break;
      case 'POST /close':
        await this.handlePostClose(req, res);
        break;
      case 'GET /health':
        this.handleGetHealth(res);
        break;
      case 'POST /show':
        await this.handlePostShow(req, res);
        break;
      case 'GET /debug':
        this.handleGetDebug(res);
        break;
      case 'POST /quit':
        this.handlePostQuit(res);
        break;
      case 'POST /lock':
        await this.handlePostLock(req, res);
        break;
      case 'POST /unlock':
        this.handlePostUnlock(res);
        break;
      case 'GET /lock-mode':
        this.handleGetLockMode(res);
        break;
      case 'POST /lock-mode':
        await this.handlePostLockMode(req, res);
        break;
      case 'GET /window-mode':
        this.handleGetWindowMode(res);
        break;
      case 'POST /window-mode':
        await this.handlePostWindowMode(req, res);
        break;
      case 'GET /stats':
        await this.handleGetStatsPage(res);
        break;
      case 'GET /stats/data':
        await this.handleGetStatsData(res);
        break;
      default:
        res.writeHead(404);
        res.end('Not Found');
    }
  }

  async handlePostStatus(req, res) {
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    // Validate payload
    const validation = validateStatusPayload(data);
    if (!validation.valid) {
      sendError(res, 400, validation.error);
      return;
    }

    // Validate and normalize state data via stateManager
    const stateValidation = this.stateManager.validateStateData(data);
    if (!stateValidation.valid) {
      sendError(res, 400, stateValidation.error || 'Invalid state data');
      return;
    }
    const stateData = stateValidation.data;  // Extract normalized data

    // Get projectId from data or use default
    let projectId = stateData.project || 'default';

    // Create window if not exists
    if (!this.windowManager.getWindow(projectId)) {
      const result = this.windowManager.createWindow(projectId);

      // Blocked by lock in single mode
      if (result.blocked) {
        sendJson(res, 200, {
          success: false,
          error: 'Project locked',
          lockedProject: this.windowManager.getLockedProject()
        });
        return;
      }

      // No window created (max limit in multi mode)
      if (!result.window) {
        sendJson(res, 200, {
          success: false,
          error: `Maximum windows limit (${MAX_WINDOWS}) reached`,
          windowCount: this.windowManager.getWindowCount()
        });
        return;
      }

      // Project was switched in single mode
      if (result.switchedProject) {
        // Clean up old project's timers
        this.stateManager.cleanupProject(result.switchedProject);
        if (this.onProjectSwitched) {
          this.onProjectSwitched(result.switchedProject);
        }
      }
    }

    // Apply auto-lock after window is successfully created (single mode only)
    this.windowManager.applyAutoLock(projectId, stateData.state);

    // Update window state via windowManager (with change detection)
    const updateResult = this.windowManager.updateState(projectId, stateData);

    // No change - skip unnecessary updates
    if (!updateResult.updated) {
      sendJson(res, 200, {
        success: true,
        project: projectId,
        state: stateData.state,
        windowCount: this.windowManager.getWindowCount(),
        skipped: true
      });
      return;
    }

    // State changed - full update (alwaysOnTop, rearrange, timeout, tray)
    if (updateResult.stateChanged) {
      // Update always on top based on state (active states stay on top)
      this.windowManager.updateAlwaysOnTopByState(projectId, stateData.state);

      // Rearrange windows by state and name (active states on right)
      this.windowManager.rearrangeWindows();

      // Set up state timeout for this project
      this.stateManager.setupStateTimeout(projectId, stateData.state);

      // Update tray
      if (this.onStateUpdate) {
        this.onStateUpdate(false);  // Full update
      }
    }

    // Send update to renderer (for both state and info changes)
    this.windowManager.sendToWindow(projectId, 'state-update', stateData);

    sendJson(res, 200, {
      success: true,
      project: projectId,
      state: stateData.state,
      windowCount: this.windowManager.getWindowCount()
    });
  }

  handleGetStatus(res) {
    // Return all windows' states
    const states = this.windowManager.getStates();
    sendJson(res, 200, {
      windowCount: this.windowManager.getWindowCount(),
      projects: states
    });
  }

  handleGetWindows(res) {
    // List all active windows
    const windows = this.windowManager.getWindows();
    const windowList = Object.entries(windows).map(([projectId, windowInfo]) => ({
      project: projectId,
      state: windowInfo.state ? windowInfo.state.state : 'unknown',
      bounds: windowInfo.window && !windowInfo.window.isDestroyed()
        ? windowInfo.window.getBounds()
        : null
    }));

    sendJson(res, 200, {
      windowCount: windowList.length,
      windows: windowList
    });
  }

  async handlePostClose(req, res) {
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const projectId = data.project;

    if (!projectId) {
      sendError(res, 400, 'Project is required');
      return;
    }

    const closed = this.windowManager.closeWindow(projectId);

    if (!closed) {
      sendJson(res, 200, {
        success: false,
        error: `Window for project '${projectId}' not found`
      });
      return;
    }

    // Update tray
    if (this.onStateUpdate) {
      this.onStateUpdate(true);  // Menu only
    }

    sendJson(res, 200, {
      success: true,
      project: projectId,
      windowCount: this.windowManager.getWindowCount()
    });
  }

  handleGetHealth(res) {
    sendJson(res, 200, { status: 'ok' });
  }

  async handlePostShow(req, res) {
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const projectId = data.project;

    // Show specific project window or first window
    const shown = projectId
      ? this.windowManager.showWindow(projectId)
      : this.windowManager.showFirstWindow();

    sendJson(res, 200, {
      success: shown,
      project: projectId || 'first'
    });
  }

  handleGetDebug(res) {
    const debugInfo = this.windowManager.getDebugInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(debugInfo, null, 2));
  }

  handlePostQuit(res) {
    sendJson(res, 200, { success: true });
    setTimeout(() => this.app.quit(), 100);
  }

  async handlePostLock(req, res) {
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const projectId = data.project;

    if (!projectId) {
      sendError(res, 400, 'Project is required');
      return;
    }

    // Lock only works in single mode
    if (this.windowManager.isMultiMode()) {
      sendJson(res, 200, {
        success: false,
        error: 'Lock only available in single-window mode'
      });
      return;
    }

    // Check if project has an active window
    const hasWindow = this.windowManager.hasWindow(projectId);
    const locked = this.windowManager.lockProject(projectId);

    // Update tray menu
    if (this.onStateUpdate) {
      this.onStateUpdate(true);
    }

    const response = {
      success: locked,
      lockedProject: this.windowManager.getLockedProject()
    };

    // Add warning if locking a project without active window
    if (locked && !hasWindow) {
      response.warning = 'No active window for this project';
    }

    sendJson(res, 200, response);
  }

  handlePostUnlock(res) {
    // Unlock only works in single mode
    if (this.windowManager.isMultiMode()) {
      sendJson(res, 200, {
        success: false,
        error: 'Unlock only available in single-window mode'
      });
      return;
    }

    this.windowManager.unlockProject();

    // Update tray menu
    if (this.onStateUpdate) {
      this.onStateUpdate(true);
    }

    sendJson(res, 200, {
      success: true,
      lockedProject: null
    });
  }

  handleGetLockMode(res) {
    sendJson(res, 200, {
      mode: this.windowManager.getLockMode(),
      modes: this.windowManager.getLockModes(),
      lockedProject: this.windowManager.getLockedProject(),
      windowMode: this.windowManager.getWindowMode()
    });
  }

  async handlePostLockMode(req, res) {
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const mode = data.mode;

    if (!mode) {
      sendError(res, 400, 'Mode is required');
      return;
    }

    const success = this.windowManager.setLockMode(mode);

    if (!success) {
      sendJson(res, 200, {
        success: false,
        error: `Invalid mode: ${mode}`,
        validModes: Object.keys(this.windowManager.getLockModes())
      });
      return;
    }

    // Update tray menu
    if (this.onStateUpdate) {
      this.onStateUpdate(true);
    }

    sendJson(res, 200, {
      success: true,
      mode: this.windowManager.getLockMode(),
      lockedProject: this.windowManager.getLockedProject()
    });
  }

  handleGetWindowMode(res) {
    sendJson(res, 200, {
      mode: this.windowManager.getWindowMode(),
      windowCount: this.windowManager.getWindowCount(),
      lockedProject: this.windowManager.getLockedProject()
    });
  }

  async handlePostWindowMode(req, res) {
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const mode = data.mode;

    if (!mode) {
      sendError(res, 400, 'Mode is required');
      return;
    }

    if (mode !== 'multi' && mode !== 'single') {
      sendJson(res, 200, {
        success: false,
        error: `Invalid mode: ${mode}`,
        validModes: ['multi', 'single']
      });
      return;
    }

    this.windowManager.setWindowMode(mode);

    // Update tray menu
    if (this.onStateUpdate) {
      this.onStateUpdate(true);
    }

    sendJson(res, 200, {
      success: true,
      mode: this.windowManager.getWindowMode(),
      windowCount: this.windowManager.getWindowCount(),
      lockedProject: this.windowManager.getLockedProject()
    });
  }

  handleGetDashboardData(res) {
    const windows = this.windowManager.getWindows();
    const windowList = Object.entries(windows).map(([projectId, info]) => ({
      project: projectId,
      state: info.state ? info.state.state : 'unknown'
    }));

    sendJson(res, 200, {
      health: 'ok',
      windowCount: windowList.length,
      windowMode: this.windowManager.getWindowMode(),
      lockMode: this.windowManager.getLockMode(),
      lockedProject: this.windowManager.getLockedProject(),
      windows: windowList
    });
  }

  async handleGetDashboard(res) {
    const dashboardPath = path.join(__dirname, '..', 'dashboard.html');

    try {
      const html = await fsPromises.readFile(dashboardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      console.error('Failed to load dashboard page:', err.message);
      sendError(res, 500, 'Failed to load dashboard page');
    }
  }

  async handleGetStatsPage(res) {
    const statsHtmlPath = path.join(__dirname, '..', 'stats.html');

    try {
      const html = await fsPromises.readFile(statsHtmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      console.error('Failed to load stats page:', err.message);
      sendError(res, 500, 'Failed to load stats page');
    }
  }

  async handleGetStatsData(res) {
    try {
      const data = await fsPromises.readFile(STATS_CACHE_PATH, 'utf8');
      const stats = JSON.parse(data);
      sendJson(res, 200, stats);
    } catch (err) {
      if (err.code === 'ENOENT') {
        sendError(res, 404, 'Stats file not found: ~/.claude/stats-cache.json');
      } else if (err instanceof SyntaxError) {
        sendError(res, 500, `Failed to parse stats file: ${err.message}`);
      } else {
        sendError(res, 500, `Failed to read stats file: ${err.message}`);
      }
    }
  }
}

module.exports = { HttpServer };
