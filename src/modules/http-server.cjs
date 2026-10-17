/**
 * HTTP server for VibeMon
 */

const http = require('http');
const { URL } = require('url');
const { HTTP_PORT, MAX_PAYLOAD_SIZE, RATE_LIMIT, RATE_WINDOW_MS, HTTP_CLOSE_TIMEOUT_MS, CHARACTER_NAMES } = require('../shared/config.cjs');
const { setCorsHeaders, isAllowedOrigin, isAllowedHost, hasJsonContentType, sendJson, sendError, parseJsonBody } = require('./http-utils.cjs');
const { StatusIngress } = require('../application/status-ingress.cjs');
const { t, currentLocale } = require('../shared/i18n/locale.cjs');

// Rate limiting: cleanup when the per-IP map exceeds this size
const RATE_CLEANUP_THRESHOLD = 100;

class HttpServer {
  constructor(stateManager, windowManager, app, ingress) {
    this.server = null;
    this.stateManager = stateManager;
    this.windowManager = windowManager;
    this.app = app;
    this.onStateUpdate = null;  // Callback for menu/icon updates
    this.onProjectSwitched = null;  // Callback: (oldProjectId) => void, window retargeted to another project
    this.onError = null;        // Callback for server errors
    this.ingress = ingress || new StatusIngress(stateManager, windowManager, {
      onProjectSwitched: id => this.onProjectSwitched?.(id),
      onStateUpdate: menuOnly => this.onStateUpdate?.(menuOnly)
    });

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

      const server = this.server;
      const forceCloseTimeout = setTimeout(() => {
        server.closeAllConnections();
      }, HTTP_CLOSE_TIMEOUT_MS);

      server.close((err) => {
        clearTimeout(forceCloseTimeout);
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error('HTTP server close error:', err.message);
        }
        if (this.server === server) this.server = null;
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    if (!isAllowedOrigin(req) || !isAllowedHost(req)) {
      sendError(res, 403, 'Request host or origin is not allowed');
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

    // Match on the pathname only, so a query string (e.g. GET /status?x=1)
    // doesn't fall through to 404. Fall back to the raw url if parsing fails.
    let pathname = req.url;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      // keep raw req.url
    }
    const route = `${req.method} ${pathname}`;

    switch (route) {
      case 'GET /':
        this.handleGetInfo(res);
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
      case 'GET /auth/callback':
        this.handleSignInCallback(req, res);
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

  /**
   * The browser returns here after VibeMon Web sign-in (see web-sign-in.cjs).
   * The page shows fixed text only; it never echoes the query.
   */
  handleSignInCallback(req, res) {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams;
    const { ok, message } = this.webSignIn
      ? this.webSignIn.complete(params)
      : { ok: false, message: t('signIn.page.idle') };
    const color = ok ? '#047857' : '#b91c1c';
    res.writeHead(ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The one-time code is in this page's URL; never send it onward.
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
    });
    res.end(`<!doctype html><html lang="${currentLocale()}"><meta charset="utf-8"><title>VibeMon</title><body style="font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center"><h1 style="font-size:1.4rem;color:${color}">VibeMon</h1><p>${message}</p></body>`);
  }

  /**
   * Reads a JSON object body, or sends the error response and returns null.
   * @param {boolean} [optional] accept a request without a JSON Content-Type (no body)
   */
  async readJson(req, res, optional = false) {
    if (!optional && !hasJsonContentType(req)) {
      sendError(res, 415, 'Content-Type must be application/json');
      return null;
    }
    const { data, error, statusCode } = await parseJsonBody(req, MAX_PAYLOAD_SIZE);
    if (error) {
      sendError(res, statusCode, error);
      return null;
    }
    return data;
  }

  async handlePostStatus(req, res) {
    const data = await this.readJson(req, res);
    if (!data) return;

    const result = this.ingress.accept(data);
    if (!result.valid) { sendError(res, 400, result.error); return; }
    sendJson(res, 200, result.response);
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
    const data = await this.readJson(req, res);
    if (!data) return;

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
    // An empty body selects the followed project.
    const data = await this.readJson(req, res, !req.headers['content-length']);
    if (!data) return;

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
    const data = await this.readJson(req, res);
    if (!data) return;

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
      version: this.app.getVersion(),
      focusedProject,
      characterLock: this.windowManager.getCharacterLock(),
      projects
    });
  }

  handleGetInfo(res) {
    sendJson(res, 200, {
      application: 'VibeMon Desktop',
      version: this.app.getVersion(),
      dashboard: 'Open the desktop workspace from the VibeMon tray icon.',
      documentation: 'https://vibemon.io/docs'
    });
  }

}

module.exports = { HttpServer };
