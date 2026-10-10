/**
 * HTTP utility functions for the Vibe Monitor HTTP server
 */

const { REQUEST_TIMEOUT_MS } = require('../shared/config.cjs');
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Set CORS headers on response
 * Only allow localhost origins for security (prevents malicious web pages from accessing the API)
 * @param {http.ServerResponse} res
 * @param {http.IncomingMessage} req
 */
function setCorsHeaders(res, req) {
  const origin = req?.headers?.origin || '';
  // Allow localhost origins only (IPv4, IPv6, with various port numbers)
  const isLocalhost = LOCAL_ORIGIN.test(origin);

  if (isLocalhost) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isAllowedOrigin(req) {
  const origin = req?.headers?.origin;
  return !origin || LOCAL_ORIGIN.test(origin);
}

function isAllowedHost(req) {
  const host = req?.headers?.host;
  // Browsers always send Host, including same-origin reads without Origin.
  return host === undefined || typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

function hasJsonContentType(req) {
  const contentType = req?.headers?.['content-type'] || '';
  return /^application\/json(?:\s*;|$)/i.test(contentType);
}

/**
 * Send JSON response
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} data
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} message
 */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/**
 * Parse JSON body from request with size limit and timeout
 * @param {http.IncomingMessage} req
 * @param {number} maxSize - Maximum payload size in bytes
 * @param {number} timeout - Request timeout in milliseconds (prevents Slowloris attacks)
 * @returns {Promise<{data: object|null, error: string|null, statusCode: number|null}>}
 */
function parseJsonBody(req, maxSize, timeout = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const chunks = [];
    let bodySize = 0;
    let aborted = false;

    // Timeout handler
    const timer = setTimeout(() => {
      if (!aborted) {
        aborted = true;
        req.destroy();
        resolve({ data: null, error: 'Request timeout', statusCode: 408 });
      }
    }, timeout);

    req.on('data', (chunk) => {
      if (aborted) return;
      bodySize += chunk.length;
      if (bodySize > maxSize) {
        aborted = true;
        clearTimeout(timer);
        req.destroy();
        resolve({ data: null, error: 'Payload too large', statusCode: 413 });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      clearTimeout(timer);
      if (aborted) return;
      try {
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : '{}';
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          resolve({ data: null, error: 'Payload must be a JSON object', statusCode: 400 });
          return;
        }
        resolve({ data, error: null, statusCode: null });
      } catch {
        resolve({ data: null, error: 'Invalid JSON', statusCode: 400 });
      }
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      if (!aborted) {
        console.error('HTTP request error:', err.message);
        resolve({ data: null, error: 'Request error', statusCode: 500 });
      }
    });
  });
}

module.exports = {
  setCorsHeaders,
  isAllowedOrigin,
  isAllowedHost,
  hasJsonContentType,
  sendJson,
  sendError,
  parseJsonBody
};
