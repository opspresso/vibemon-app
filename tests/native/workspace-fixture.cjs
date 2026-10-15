const { app, Menu } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { URL } = require('node:url');
const { MonitoringClient } = require('../../src/monitoring/client.cjs');
const { WorkspaceSettings } = require('../../src/workspace/settings.cjs');
const { WorkspaceWindow } = require('../../src/workspace/window.cjs');
const { installWorkspaceMenu } = require('../../src/workspace/menu.cjs');
const { HookCloudDelivery } = require('../../src/modules/hook-cloud-delivery.cjs');
const { TrayManager } = require('../../src/modules/tray-manager.cjs');
const { TOKEN, memoryStore, sources, createPorts, trend } = require('../fixtures/workspace.cjs');

const directory = process.env.VIBEMON_TEST_USER_DATA;
if (!directory) throw new Error('Launch this fixture with pnpm test:workspace or pnpm preview:workspace');
app.setPath('userData', directory);
// The only credential the fixture accepts for cloud write checks.
const WRITE_TOKEN = 'vm_' + 'a'.repeat(60);

async function startFixture() {
  await app.whenReady();
  const ports = createPorts();
  const state = { sources, status: 200, requests: [], trendStatus: 200, trendDelayMs: 0, sourceDelayMs: 0, trend };
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    state.requests.push(request.url);
    if (request.url === '/api/v1/connection?scope=write') {
      const accepted = request.headers.authorization === `Bearer ${WRITE_TOKEN}`;
      response.writeHead(accepted ? 200 : 403);
      response.end(JSON.stringify(accepted ? { connected: true, scope: 'write' } : { error: 'Write permission required' }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end('{}'); return; }
    if (state.status !== 200) { response.writeHead(state.status); response.end('{}'); return; }
    const url = new URL(request.url, 'http://localhost');
    const data = state.sources();
    if (url.pathname.endsWith('/trend')) {
      if (state.trendStatus !== 200) { response.writeHead(state.trendStatus); response.end('{}'); return; }
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const item = data.find(item => item.sourceId === id || item.account && `${item.account.provider}:${item.account.id}` === id);
      const payload = JSON.stringify(item ? state.trend(item) : { points: [] });
      if (state.trendDelayMs) setTimeout(() => response.end(payload), state.trendDelayMs);
      else response.end(payload);
      return;
    }
    const ids = url.searchParams.get('ids')?.split(','), accounts = url.searchParams.get('accounts')?.split(',');
    const payload = JSON.stringify({ sources: ids || accounts ? data.filter(item => ids?.includes(item.sourceId) || item.account && accounts?.includes(`${item.account.provider}:${item.account.id}`)) : data, serverTime: new Date().toISOString() });
    if (state.sourceDelayMs) setTimeout(() => response.end(payload), state.sourceDelayMs);
    else response.end(payload);
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
    set(value, url) { token = value; corrupt = false; if (url) preferences.set('url', url); },
    clear() { token = null; corrupt = false; }
  };
  const client = new MonitoringClient({ preferences, credentials, fetchImpl: (url, options) => fetch(origin + new URL(url).pathname + new URL(url).search, options) });
  const cloudDelivery = new HookCloudDelivery({ configManager: ports.vibemonConfigManager, fetchImpl: (url, options) => fetch(origin + new URL(url).pathname + new URL(url).search, options) });
  const settings = new WorkspaceSettings({ ...ports, cloudDelivery });
  const errors = [];
  const view = new WorkspaceWindow({ monitoring: client, settings, ...ports, reportError: error => { errors.push(error.message); } });
  settings.onSettingsChanged = () => view.notify('settings');
  cloudDelivery.onChange = () => settings.notifyChanged();
  ports.hookInstaller.onStateChanged = () => view.notify('settings');
  const trayManager = new TrayManager({ getProjectIds: () => [], getState: () => null }, app, client);
  trayManager.openDashboard = () => view.open('overview');
  trayManager.openSettings = page => view.open(page);
  trayManager.setShowCharacterHandler(ports.showCompanion);
  trayManager.createTray();
  trayManager.tray.setToolTip('VibeMon workspace preview');
  function cleanup() {
    trayManager.cleanup(); view.cleanup(); client.stop(); server.close();
  }
  app.once('before-quit', cleanup);
  await client.configure({ url: 'https://vibemon.io', token: TOKEN });
  installWorkspaceMenu({ open: page => view.open(page), showCompanion: ports.showCompanion });
  // Selecting the native menu action creates the workspace; the tray alone does not.
  const selectDashboard = () => Menu.buildFromTemplate(trayManager.buildMenuTemplate()).items.find(item => item.label === 'Dashboard').click();
  assert.equal(view.window, null, 'creating the tray does not open the workspace');
  selectDashboard();
  view.window.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  view.window.webContents.on('did-fail-load', (_event, code, description) => errors.push(`${code}: ${description}`));
  return { ports, state, client, settings, view, trayManager, selectDashboard, preferences, errors, cleanup, corruptCredential() { corrupt = true; } };
}
module.exports = { startFixture, TOKEN, WRITE_TOKEN };
