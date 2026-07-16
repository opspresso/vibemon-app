const { EventEmitter } = require('events');
const http = require('http');

const { HttpServer } = require('../src/modules/http-server.cjs');

function request(method, url, { headers = {}, body, rawBody } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = jest.fn();
  process.nextTick(() => {
    if (rawBody !== undefined) req.emit('data', Buffer.from(rawBody));
    else if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function response() {
  const res = {
    headers: {},
    headersSent: false,
    statusCode: null,
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headersSent = true;
      Object.assign(this.headers, headers);
    },
    end(body = '') { this.body = body; }
  };
  return res;
}

function createServer() {
  const stateManager = {
    validateStateData: jest.fn(data => ({ valid: true, data })),
    setupStateTimeout: jest.fn(),
    cleanupProject: jest.fn()
  };
  const windowManager = {
    routeStatusUpdate: jest.fn((_project, data) => ({
      switchedProject: null,
      updateResult: { updated: true, stateChanged: true, infoChanged: false },
      stateData: data
    })),
    getFocusedProjectId: jest.fn(() => 'demo'),
    sendToWindow: jest.fn(),
    updateAlwaysOnTopByState: jest.fn(),
    getRegisteredStates: jest.fn(() => ({})),
    getCharacterLock: jest.fn(() => 'auto'),
    closeWindow: jest.fn(() => true),
    showWindow: jest.fn(() => true),
    showActiveWindow: jest.fn(() => true),
    setCharacterLock: jest.fn(),
    getDebugInfo: jest.fn(() => ({ ok: true }))
  };
  const app = { quit: jest.fn(), getVersion: jest.fn(() => '0.0.0-test') };
  return { server: new HttpServer(stateManager, windowManager, app), stateManager, windowManager, app };
}

describe('HttpServer request boundaries', () => {
  test('rejects non-local browser origins before routing', async () => {
    const { server } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/quit', { headers: { origin: 'https://evil.example' } }), res);

    expect(res.statusCode).toBe(403);
  });

  test('requires JSON content type for status updates', async () => {
    const { server } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/status', { body: { state: 'working' } }), res);

    expect(res.statusCode).toBe(415);
  });

  test('routes a valid status update and refreshes its timeout', async () => {
    const { server, stateManager, windowManager } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' },
      body: { state: 'working', project: 'demo' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(stateManager.setupStateTimeout).toHaveBeenCalledWith('demo', 'working');
    expect(windowManager.sendToWindow).toHaveBeenCalled();
  });

  test('serves health and rejects unknown routes', async () => {
    const { server } = createServer();
    const health = response();
    const missing = response();

    await server.handleRequest(request('GET', '/health'), health);
    await server.handleRequest(request('GET', '/missing'), missing);

    expect(health.statusCode).toBe(200);
    expect(missing.statusCode).toBe(404);
  });

  test('rate limits repeated requests from the same client', async () => {
    const { server } = createServer();
    const { RATE_LIMIT } = require('../src/shared/config.cjs');
    server.requestCounts.set('127.0.0.1', { count: RATE_LIMIT, resetTime: Date.now() + 1000 });
    const res = response();

    await server.handleRequest(request('GET', '/health'), res);

    expect(res.statusCode).toBe(429);
  });

  test('closes the requested project window', async () => {
    const { server, windowManager } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/close', {
      headers: { 'content-type': 'application/json' }, body: { project: 'demo' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(windowManager.closeWindow).toHaveBeenCalledWith('demo');
  });

  test('rejects close without a project', async () => {
    const { server } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/close', {
      headers: { 'content-type': 'application/json' }, body: {}
    }), res);

    expect(res.statusCode).toBe(400);
  });

  test('shows the active window without a request body', async () => {
    const { server, windowManager } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/show'), res);

    expect(res.statusCode).toBe(200);
    expect(windowManager.showActiveWindow).toHaveBeenCalled();
  });

  test('updates and reads character lock', async () => {
    const { server, windowManager } = createServer();
    const setResult = response();
    const getResult = response();

    await server.handleRequest(request('POST', '/character-lock', {
      headers: { 'content-type': 'application/json' }, body: { character: 'kiro' }
    }), setResult);
    await server.handleRequest(request('GET', '/character-lock'), getResult);

    expect(setResult.statusCode).toBe(200);
    expect(getResult.statusCode).toBe(200);
    expect(windowManager.setCharacterLock).toHaveBeenCalledWith('kiro');
  });

  test('rejects an invalid character lock', async () => {
    const { server } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/character-lock', {
      headers: { 'content-type': 'application/json' }, body: { character: 'unknown' }
    }), res);

    expect(JSON.parse(res.body).success).toBe(false);
  });

  test('returns status, dashboard data, and debug data', async () => {
    const { server } = createServer();
    const status = response();
    const dashboard = response();
    const debug = response();

    await server.handleRequest(request('GET', '/status'), status);
    await server.handleRequest(request('GET', '/dashboard-data'), dashboard);
    await server.handleRequest(request('GET', '/debug'), debug);

    expect(status.statusCode).toBe(200);
    expect(dashboard.statusCode).toBe(200);
    expect(debug.statusCode).toBe(200);
  });

  test('accepts preflight requests', async () => {
    const { server } = createServer();
    const res = response();

    await server.handleRequest(request('OPTIONS', '/status', {
      headers: { origin: 'http://localhost:3000' }
    }), res);

    expect(res.statusCode).toBe(200);
  });

  test('quits asynchronously for an originless local request', async () => {
    jest.useFakeTimers();
    const { server, app } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/quit'), res);
    jest.advanceTimersByTime(100);

    expect(app.quit).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('returns validation errors without routing status data', async () => {
    const { server, windowManager } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' }, body: { state: 'invalid' }
    }), res);

    expect(res.statusCode).toBe(400);
    expect(windowManager.routeStatusUpdate).not.toHaveBeenCalled();
  });

  test('skips status updates without a project name instead of routing them', async () => {
    const { server, windowManager } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' }, body: { state: 'done' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).skipped).toBe(true);
    expect(windowManager.routeStatusUpdate).not.toHaveBeenCalled();
  });

  test('skips status updates with an empty project name instead of routing them', async () => {
    const { server, windowManager } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' }, body: { state: 'idle', project: '' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).skipped).toBe(true);
    expect(windowManager.routeStatusUpdate).not.toHaveBeenCalled();
  });

  test('reports unchanged status updates as skipped', async () => {
    const { server, windowManager } = createServer();
    windowManager.routeStatusUpdate.mockReturnValue({
      switchedProject: null,
      updateResult: { updated: false, stateChanged: false, infoChanged: false },
      stateData: { state: 'idle', project: 'demo' }
    });
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' }, body: { state: 'idle', project: 'demo' }
    }), res);

    expect(JSON.parse(res.body).skipped).toBe(true);
  });

  test('reports a missing close target without throwing', async () => {
    const { server, windowManager } = createServer();
    windowManager.closeWindow.mockReturnValue(false);
    const res = response();

    await server.handleRequest(request('POST', '/close', {
      headers: { 'content-type': 'application/json' }, body: { project: 'missing' }
    }), res);

    expect(JSON.parse(res.body).success).toBe(false);
  });

  test('shows a requested project and validates optional JSON bodies', async () => {
    const { server, windowManager } = createServer();
    const shown = response();
    const invalidType = response();

    await server.handleRequest(request('POST', '/show', {
      headers: { 'content-type': 'application/json', 'content-length': '18' }, body: { project: 'demo' }
    }), shown);
    await server.handleRequest(request('POST', '/show', {
      headers: { 'content-type': 'text/plain', 'content-length': '2' }, body: {}
    }), invalidType);

    expect(windowManager.showWindow).toHaveBeenCalledWith('demo');
    expect(invalidType.statusCode).toBe(415);
  });

  test('requires a character value', async () => {
    const { server } = createServer();
    const res = response();

    await server.handleRequest(request('POST', '/character-lock', {
      headers: { 'content-type': 'application/json' }, body: {}
    }), res);

    expect(res.statusCode).toBe(400);
  });

  test('resets an expired rate-limit record and removes expired overflow entries', () => {
    const { server } = createServer();
    const now = Date.now();
    for (let i = 0; i < 101; i++) {
      server.requestCounts.set(`ip-${i}`, { count: 100, resetTime: now - 1 });
    }

    expect(server.checkRateLimit('127.0.0.1')).toBe(true);
    expect(server.requestCounts.size).toBe(1);
  });

  test('starts, reports server errors, and stops cleanly', async () => {
    const nativeServer = new EventEmitter();
    nativeServer.listen = jest.fn((_port, _host, callback) => callback());
    nativeServer.close = jest.fn(callback => callback());
    jest.spyOn(http, 'createServer').mockReturnValue(nativeServer);
    const { server } = createServer();
    server.onError = jest.fn();

    expect(server.start()).toBe(nativeServer);
    nativeServer.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }));
    await server.stop();

    expect(server.onError).toHaveBeenCalled();
    expect(server.server).toBeNull();
    http.createServer.mockRestore();
  });

  test('stop is a no-op before start', async () => {
    const { server } = createServer();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  test('rejects invalid JSON and missing JSON content types on mutation routes', async () => {
    const { server } = createServer();
    const invalidJson = response();
    const invalidCharacterType = response();
    const req = request('POST', '/status', {
      headers: { 'content-type': 'application/json' }, rawBody: '{'
    });

    await server.handleRequest(req, invalidJson);
    await server.handleRequest(request('POST', '/character-lock'), invalidCharacterType);

    expect(invalidJson.statusCode).toBe(400);
    expect(invalidCharacterType.statusCode).toBe(415);
  });

  test('handles focus switches and info-only updates without state side effects', async () => {
    const { server, windowManager } = createServer();
    server.onProjectSwitched = jest.fn();
    server.onStateUpdate = jest.fn();
    windowManager.routeStatusUpdate.mockReturnValue({
      switchedProject: 'old',
      updateResult: { updated: true, stateChanged: false, infoChanged: true },
      stateData: { state: 'working', project: 'demo', memory: 20 }
    });
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' },
      body: { state: 'working', project: 'demo', memory: 20 }
    }), res);

    expect(server.onProjectSwitched).toHaveBeenCalledWith('old');
    expect(server.onStateUpdate).not.toHaveBeenCalled();
  });

  test('notifies menu updates for close and character mutations', async () => {
    const { server } = createServer();
    server.onStateUpdate = jest.fn();

    await server.handleRequest(request('POST', '/close', {
      headers: { 'content-type': 'application/json' }, body: { project: 'demo' }
    }), response());
    await server.handleRequest(request('POST', '/character-lock', {
      headers: { 'content-type': 'application/json' }, body: { character: 'kiro' }
    }), response());

    expect(server.onStateUpdate).toHaveBeenNthCalledWith(1, true);
    expect(server.onStateUpdate).toHaveBeenNthCalledWith(2, true);
  });

  test('rejects a status payload that cannot be normalized', async () => {
    const { server, stateManager } = createServer();
    stateManager.validateStateData.mockReturnValue({ valid: false, error: 'normalization failed' });
    const res = response();

    await server.handleRequest(request('POST', '/status', {
      headers: { 'content-type': 'application/json' }, body: { state: 'working' }
    }), res);

    expect(res.statusCode).toBe(400);
  });
});
