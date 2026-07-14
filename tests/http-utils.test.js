/**
 * Tests for http-utils.cjs
 */

const { EventEmitter } = require('events');
const {
  setCorsHeaders,
  sendJson,
  sendError,
  parseJsonBody
} = require('../src/modules/http-utils.cjs');

// Mock response object
function createMockResponse() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    setHeader: jest.fn((name, value) => {
      headers[name] = value;
    }),
    writeHead: jest.fn((statusCode, headersObj) => {
      this.statusCode = statusCode;
      Object.assign(headers, headersObj);
    }),
    end: jest.fn((body) => {
      this.body = body;
    })
  };
}

// Mock request object with EventEmitter for streaming
function createMockRequest(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.destroy = jest.fn();
  return req;
}

describe('setCorsHeaders', () => {
  test('sets CORS headers for localhost origin', () => {
    const res = createMockResponse();
    const req = { headers: { origin: 'http://localhost:3000' } };

    setCorsHeaders(res, req);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:3000');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'Content-Type');
  });

  test('sets CORS headers for 127.0.0.1 origin', () => {
    const res = createMockResponse();
    const req = { headers: { origin: 'http://127.0.0.1:19280' } };

    setCorsHeaders(res, req);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://127.0.0.1:19280');
  });

  test('sets CORS headers for IPv6 localhost origin', () => {
    const res = createMockResponse();
    const req = { headers: { origin: 'http://[::1]:8080' } };

    setCorsHeaders(res, req);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://[::1]:8080');
  });

  test('sets CORS headers for https localhost', () => {
    const res = createMockResponse();
    const req = { headers: { origin: 'https://localhost:443' } };

    setCorsHeaders(res, req);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://localhost:443');
  });

  test('does not set origin header for non-localhost origin', () => {
    const res = createMockResponse();
    const req = { headers: { origin: 'http://example.com' } };

    setCorsHeaders(res, req);

    expect(res.setHeader).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  });

  test('handles missing origin header', () => {
    const res = createMockResponse();
    const req = { headers: {} };

    setCorsHeaders(res, req);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  });

  test('handles null request', () => {
    const res = createMockResponse();

    setCorsHeaders(res, null);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  });
});

describe('sendJson', () => {
  test('sends JSON response with correct headers and body', () => {
    const res = createMockResponse();
    const data = { success: true, message: 'Hello' };

    sendJson(res, 200, data);

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify(data));
  });

  test('sends JSON response with different status code', () => {
    const res = createMockResponse();
    const data = { error: 'Not found' };

    sendJson(res, 404, data);

    expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
  });

  test('handles empty object', () => {
    const res = createMockResponse();

    sendJson(res, 200, {});

    expect(res.end).toHaveBeenCalledWith('{}');
  });

  test('handles nested objects', () => {
    const res = createMockResponse();
    const data = { user: { name: 'test', settings: { theme: 'dark' } } };

    sendJson(res, 200, data);

    expect(res.end).toHaveBeenCalledWith(JSON.stringify(data));
  });
});

describe('sendError', () => {
  test('sends error response with message', () => {
    const res = createMockResponse();

    sendError(res, 400, 'Bad request');

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Bad request' }));
  });

  test('sends 500 error', () => {
    const res = createMockResponse();

    sendError(res, 500, 'Internal server error');

    expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Internal server error' }));
  });
});

describe('parseJsonBody', () => {
  test('parses valid JSON body', async () => {
    const req = createMockRequest();
    const data = { state: 'working', project: 'test' };

    const promise = parseJsonBody(req, 1024);

    // Simulate data chunks
    req.emit('data', Buffer.from(JSON.stringify(data)));
    req.emit('end');

    const result = await promise;

    expect(result.data).toEqual(data);
    expect(result.error).toBeNull();
    expect(result.statusCode).toBeNull();
  });

  test('parses empty body as empty object', async () => {
    const req = createMockRequest();

    const promise = parseJsonBody(req, 1024);
    req.emit('end');

    const result = await promise;

    expect(result.data).toEqual({});
    expect(result.error).toBeNull();
  });

  test('handles multiple data chunks', async () => {
    const req = createMockRequest();
    const data = { state: 'working', project: 'test-project' };
    const jsonStr = JSON.stringify(data);

    const promise = parseJsonBody(req, 1024);

    // Split JSON into multiple chunks
    req.emit('data', Buffer.from(jsonStr.substring(0, 10)));
    req.emit('data', Buffer.from(jsonStr.substring(10)));
    req.emit('end');

    const result = await promise;

    expect(result.data).toEqual(data);
  });

  test('rejects payload exceeding max size', async () => {
    const req = createMockRequest();
    const maxSize = 10;

    const promise = parseJsonBody(req, maxSize);

    // Send data larger than max size
    req.emit('data', Buffer.from('{"data":"this is way too long"}'));

    const result = await promise;

    expect(result.data).toBeNull();
    expect(result.error).toBe('Payload too large');
    expect(result.statusCode).toBe(413);
    expect(req.destroy).toHaveBeenCalled();
  });

  test('rejects invalid JSON', async () => {
    const req = createMockRequest();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const promise = parseJsonBody(req, 1024);

    req.emit('data', Buffer.from('{ invalid json }'));
    req.emit('end');

    const result = await promise;

    expect(result.data).toBeNull();
    expect(result.error).toBe('Invalid JSON');
    expect(result.statusCode).toBe(400);

    consoleSpy.mockRestore();
  });

  test('handles request error', async () => {
    const req = createMockRequest();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const promise = parseJsonBody(req, 1024);

    req.emit('error', new Error('Connection reset'));

    const result = await promise;

    expect(result.data).toBeNull();
    expect(result.error).toBe('Request error');
    expect(result.statusCode).toBe(500);

    consoleSpy.mockRestore();
  });

  test('handles request timeout', async () => {
    jest.useFakeTimers();
    const req = createMockRequest();

    const promise = parseJsonBody(req, 1024, 100); // 100ms timeout

    // Advance time past timeout
    jest.advanceTimersByTime(150);

    const result = await promise;

    expect(result.data).toBeNull();
    expect(result.error).toBe('Request timeout');
    expect(result.statusCode).toBe(408);
    expect(req.destroy).toHaveBeenCalled();

    jest.useRealTimers();
  });

  test('clears timeout on successful parse', async () => {
    jest.useFakeTimers();
    const req = createMockRequest();

    const promise = parseJsonBody(req, 1024, 1000);

    req.emit('data', Buffer.from('{"success":true}'));
    req.emit('end');

    const result = await promise;

    expect(result.data).toEqual({ success: true });

    // Advancing time should not cause issues
    jest.advanceTimersByTime(2000);

    jest.useRealTimers();
  });
});
