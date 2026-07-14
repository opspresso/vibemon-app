/**
 * HTTP utility functions for the Vibe Monitor HTTP server
 */

/**
 * Set CORS headers on response
 * Only allow localhost origins for security (prevents malicious web pages from accessing the API)
 * @param {http.ServerResponse} res
 * @param {http.IncomingMessage} req
 */
function setCorsHeaders(res, req) {
  const origin = req?.headers?.origin || '';
  // Allow localhost origins only (IPv4, IPv6, with various port numbers)
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

  if (isLocalhost) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

// Request timeout in milliseconds (prevents Slowloris attacks)
const REQUEST_TIMEOUT = 30000;

/**
 * Parse JSON body from request with size limit and timeout
 * @param {http.IncomingMessage} req
 * @param {number} maxSize - Maximum payload size in bytes
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<{data: object|null, error: string|null, statusCode: number|null}>}
 */
function parseJsonBody(req, maxSize, timeout = REQUEST_TIMEOUT) {
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
        resolve({ data, error: null, statusCode: null });
      } catch (e) {
        console.error('JSON parse error:', e.message);
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
  sendJson,
  sendError,
  parseJsonBody
};
