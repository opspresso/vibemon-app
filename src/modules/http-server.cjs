/**
 * HTTP server for VibeMon
 */

const http = require('http');
const fsPromises = require('fs').promises;
const path = require('path');
const { HTTP_PORT, MAX_PAYLOAD_SIZE, RATE_LIMIT, RATE_WINDOW_MS, CHARACTER_NAMES } = require('../shared/config.cjs');
const { setCorsHeaders, isAllowedOrigin, hasJsonContentType, sendJson, sendError, parseJsonBody } = require('./http-utils.cjs');
const { validateStatusPayload } = require('./validators.cjs');

// Rate limiting: cleanup when the per-IP map exceeds this size
const RATE_CLEANUP_THRESHOLD = 100;

class HttpServer {
  constructor(stateManager, windowManager, app) {
    this.server = null;
    this.stateManager = stateManager;
    this.windowManager = windowManager;
    this.app = app;
    this.onStateUpdate = null;  // Callback for menu/icon updates
    this.onProjectSwitched = null;  // Callback: (oldProjectId) => void, window retargeted to another project
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
      console.log(`VibeMon HTTP server running on http://127.0.0.1:${HTTP_PORT}`);
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
    if (!isAllowedOrigin(req)) {
      sendError(res, 403, 'Origin not allowed');
      return;
    }
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
      case 'GET /character-lock':
        this.handleGetCharacterLock(res);
        break;
      case 'POST /character-lock':
        await this.handlePostCharacterLock(req, res);
        break;
      default:
        res.writeHead(404);
        res.end('Not Found');
    }
  }

  async handlePostStatus(req, res) {
    if (!hasJsonContentType(req)) {
      sendError(res, 415, 'Content-Type must be application/json');
      return;
    }
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
    const projectId = stateData.project || 'default';

    const routeResult = this.windowManager.routeStatusUpdate(projectId, stateData);

    // The window was retargeted from another project
    if (routeResult.switchedProject) {
      if (this.onProjectSwitched) {
        this.onProjectSwitched(routeResult.switchedProject);
      }
    }

    const updateResult = routeResult.updateResult;

    // Every accepted update is activity, including unchanged/background updates.
    this.stateManager.setupStateTimeout(projectId, stateData.state);

    // No change - skip unnecessary updates
    if (!updateResult.updated) {
      sendJson(res, 200, {
        success: true,
        project: projectId,
        state: stateData.state,
        focusedProject: this.windowManager.getFocusedProjectId(),
        skipped: true
      });
      return;
    }

    // State changed - full update (alwaysOnTop, timeout, tray)
    if (updateResult.stateChanged) {
      // Update always on top based on state (active states stay on top)
      this.windowManager.updateAlwaysOnTopByState(stateData.state);

      // Update tray
      if (this.onStateUpdate) {
        this.onStateUpdate(false);  // Full update
      }
    }

    // Send update to renderer (for both state and info changes); routeResult.stateData
    // reflects Character Lock, if set
    this.windowManager.sendToWindow(projectId, 'state-update', routeResult.stateData);

    sendJson(res, 200, {
      success: true,
      project: projectId,
      state: stateData.state,
      focusedProject: this.windowManager.getFocusedProjectId()
    });
  }

  handleGetStatus(res) {
    // Return every tracked project's latest state, plus which one the
    // character window currently follows
    sendJson(res, 200, {
      focusedProject: this.windowManager.getFocusedProjectId(),
      projects: this.windowManager.getRegisteredStates()
    });
  }

  async handlePostClose(req, res) {
    if (!hasJsonContentType(req)) {
      sendError(res, 415, 'Content-Type must be application/json');
      return;
    }
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
      project: projectId
    });
  }

  handleGetHealth(res) {
    sendJson(res, 200, { status: 'ok' });
  }

  async handlePostShow(req, res) {
    if (req.headers['content-length'] && !hasJsonContentType(req)) {
      sendError(res, 415, 'Content-Type must be application/json');
      return;
    }
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const projectId = data.project;

    // Show the window for a specific project, or whichever it follows
    const shown = projectId
      ? this.windowManager.showWindow(projectId)
      : this.windowManager.showActiveWindow();

    sendJson(res, 200, {
      success: shown,
      project: projectId || this.windowManager.getFocusedProjectId()
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

  handleGetCharacterLock(res) {
    sendJson(res, 200, {
      character: this.windowManager.getCharacterLock()
    });
  }

  async handlePostCharacterLock(req, res) {
    if (!hasJsonContentType(req)) {
      sendError(res, 415, 'Content-Type must be application/json');
      return;
    }
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);

    if (error) {
      sendError(res, statusCode, error);
      return;
    }

    const character = data.character;

    if (!character) {
      sendError(res, 400, 'Character is required');
      return;
    }

    if (character !== 'auto' && !CHARACTER_NAMES.includes(character)) {
      sendJson(res, 200, {
        success: false,
        error: `Invalid character: ${character}`,
        validCharacters: ['auto', ...CHARACTER_NAMES]
      });
      return;
    }

    this.windowManager.setCharacterLock(character);

    // Update tray menu
    if (this.onStateUpdate) {
      this.onStateUpdate(true);
    }

    sendJson(res, 200, {
      success: true,
      character: this.windowManager.getCharacterLock()
    });
  }

  handleGetDashboardData(res) {
    const focusedProject = this.windowManager.getFocusedProjectId();
    const projects = Object.entries(this.windowManager.getRegisteredStates()).map(([projectId, state]) => ({
      project: projectId,
      state: state ? state.state : 'unknown',
      focused: projectId === focusedProject
    }));

    sendJson(res, 200, {
      health: 'ok',
      focusedProject,
      characterLock: this.windowManager.getCharacterLock(),
      projects
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

}

module.exports = { HttpServer };
