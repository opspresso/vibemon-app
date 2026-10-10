const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { MonitoringClient } = require('../../src/monitoring/client.cjs');
const { WorkspaceSettings } = require('../../src/workspace/settings.cjs');
const { WorkspaceWindow } = require('../../src/workspace/window.cjs');
const { TOKEN, memoryStore, sources, createPorts, trend } = require('../fixtures/workspace.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-workspace-'));
app.setPath('userData', directory);

async function startFixture() {
  await app.whenReady();
  const ports = createPorts();
  const state = { sources, status: 200, requests: [], trendDelayMs: 0 };
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    state.requests.push(request.url);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end('{}'); return; }
    if (state.status !== 200) { response.writeHead(state.status); response.end('{}'); return; }
    const url = new URL(request.url, 'http://localhost');
    const data = state.sources();
    if (url.pathname.endsWith('/trend')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const item = data.find(item => item.sourceId === id || item.account && `${item.account.provider}:${item.account.id}` === id);
      const payload = JSON.stringify(item ? trend(item) : { points: [] });
      if (state.trendDelayMs) setTimeout(() => response.end(payload), state.trendDelayMs);
      else response.end(payload);
      return;
    }
    const ids = url.searchParams.get('ids')?.split(','), accounts = url.searchParams.get('accounts')?.split(',');
    response.end(JSON.stringify({ sources: ids || accounts ? data.filter(item => ids?.includes(item.sourceId) || item.account && accounts?.includes(`${item.account.provider}:${item.account.id}`)) : data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const preferences = memoryStore();
  let token = null, corrupt = false;
  // OS keychain behavior belongs to CredentialStore tests. This UI fixture
  // simulates its port without opening or adding entries to a user's keychain.
  const credentials = {
    has: () => Boolean(token),
    get() {
      if (corrupt) throw Object.assign(new Error('Test credential unavailable'), { code: 'credential-unavailable' });
      return token;
    },
    set(value) { token = value; corrupt = false; },
    clear() { token = null; corrupt = false; }
  };
  const client = new MonitoringClient({ preferences, credentials, fetchImpl: (url, options) => fetch(origin + new URL(url).pathname + new URL(url).search, options) });
  const settings = new WorkspaceSettings(ports);
  const errors = [];
  const view = new WorkspaceWindow({ monitoring: client, settings, ...ports, reportError: error => { errors.push(error.message); } });
  settings.onSettingsChanged = () => view.notify('settings');
  function cleanup() {
    view.cleanup(); client.stop(); server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  app.once('before-quit', cleanup);
  await client.configure({ url: 'https://vibemon.io', token: TOKEN });
  view.open('overview');
  view.window.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  view.window.webContents.on('did-fail-load', (_event, code, description) => errors.push(`${code}: ${description}`));
  return { ports, state, client, settings, view, preferences, errors, cleanup, corruptCredential() { corrupt = true; } };
}
module.exports = { startFixture, TOKEN };
