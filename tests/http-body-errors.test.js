const http = require('node:http');
const { parseJsonBody, sendError } = require('../src/modules/http-utils.cjs');

test.each([
  ['oversized body', 10, 1000, 413, 'Payload too large'],
  ['unfinished body', 1024, 25, 408, 'Request timeout']
])('%s receives an HTTP error before its connection closes', async (_label, limit, timeout, status, message) => {
  const server = http.createServer(async (req, res) => {
    const result = await parseJsonBody(req, limit, timeout);
    sendError(res, result.statusCode, result.error);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let request;
  try {
    const response = await new Promise((resolve, reject) => {
      request = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        res.on('error', reject);
      });
      request.on('error', reject);
      request.write(status === 413 ? 'x'.repeat(100) : '{');
    });
    expect(response).toEqual({ status, connection: 'close', body: { error: message } });
  } finally {
    request?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
