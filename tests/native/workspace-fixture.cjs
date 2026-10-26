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
const { attentionAreas, attentionNotices } = require('../../src/shared/attention.cjs');
const { TOKEN, memoryStore, connectedSources, usageConnections, createPorts, trend } = require('../fixtures/workspace.cjs');
const { setLocale, t } = require('../../src/shared/i18n/locale.cjs');

const directory = process.env.VIBEMON_TEST_USER_DATA;
if (!directory) throw new Error('Launch this fixture with pnpm test:workspace or pnpm preview:workspace');
app.setPath('userData', directory);
// Tests run in English. VIBEMON_LOCALE=ko or ja previews a translation.
setLocale(process.env.VIBEMON_LOCALE || 'en');
// The smoke test waits for animation frames and captures the window. Chromium
// stops painting a window that other windows hide, so keep it rendering.
for (const name of ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'disable-background-timer-throttling']) {
  app.commandLine.appendSwitch(name);
}
// The only credential the fixture accepts for cloud write checks.
const WRITE_TOKEN = 'vm_' + 'a'.repeat(60);
// The code that completes a fixture Claude sign-in; any other code is rejected.
const CLAUDE_CODE = 'fixture-code#fixture-state';

/**
 * The connected-service API of Web (`/api/v1/usage*`). `usage.scope` false
 * answers like a token without the `usage` permission. A Codex sign-in
 * connects on its second poll.
 */
function serveUsage(state, request, response, body) {
  const url = new URL(request.url, 'http://localhost');
  const usage = state.usage;
  const send = (status, value) => { response.writeHead(status); response.end(value === undefined ? '' : JSON.stringify(value)); };
  const managing = !(request.method === 'GET' || (request.method === 'POST' && url.pathname.startsWith('/api/v1/usage/connections/')));
  if (managing && !usage.scope) return send(403, { error: 'Usage permission required' });
  const [, , , , collection, id] = url.pathname.split('/');
  usage.requests.push(`${request.method} ${url.pathname}`);
  if (request.method === 'GET' && url.pathname === '/api/v1/usage') return send(200, { providers: ['claude', 'codex'], connections: usage.connections, serverTime: new Date().toISOString() });
  if (collection === 'authorizations' && request.method === 'POST' && !id) {
    const provider = body.provider;
    const authorization = {
      id: `0000000${++usage.started}-1111-4222-8333-444455556666`.slice(-36), provider, expiresAt: new Date(Date.now() + 600000).toISOString(),
      prompt: provider === 'claude' ? { kind: 'code', url: 'https://claude.ai/oauth/authorize?fixture=1' } : { kind: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'BCDF-GHJK', interval: 1 }
    };
    usage.authorizations.set(authorization.id, { ...authorization, polls: 0 });
    return send(201, { authorization });
  }
  if (collection === 'authorizations' && id) {
    const authorization = usage.authorizations.get(id);
    if (!authorization) return send(404, { error: 'Sign-in expired', code: 'usage-authorization-expired' });
    if (request.method === 'DELETE') { usage.authorizations.delete(id); return send(204); }
    if (authorization.provider === 'claude' && body.code !== CLAUDE_CODE) return send(400, { error: 'Invalid code', code: 'usage-authorization-code-invalid' });
    if (authorization.provider === 'codex' && ++authorization.polls < 2) return send(200, { status: 'pending', interval: 1 });
    usage.authorizations.delete(id);
    const connection = { ...usageConnections()[0], id: `9${id.slice(1)}`, provider: authorization.provider, accountId: `auto:new-${authorization.provider}`, label: `new-${authorization.provider}@example.com`, plan: 'Pro' };
    usage.connections = [...usage.connections, connection];
    return send(200, { status: 'connected', connection });
  }
  if (collection === 'connections' && id) {
    const connection = usage.connections.find(item => item.id === id);
    if (!connection) return send(404, { error: 'Not found' });
    if (request.method === 'DELETE') { usage.connections = usage.connections.filter(item => item.id !== id); return send(204); }
    const updated = { ...connection, checkedAt: new Date().toISOString(), refreshableAt: new Date(Date.now() + 60000).toISOString() };
    usage.connections = usage.connections.map(item => item.id === id ? updated : item);
    return send(200, { connection: updated });
  }
  return send(404, { error: 'Not found' });
}

/** `connections` are the connected services at start; the preview shows the sample ones. */
async function startFixture({ connections = usageConnections() } = {}) {
  await app.whenReady();
  const ports = createPorts();
  const state = { sources: () => connectedSources(Date.now(), state.usage.connections), status: 200, requests: [], trendStatus: 200, trendDelayMs: 0, sourceDelayMs: 0, trend,
    accountStatus: 200, accountDelayMs: 0, accountResponses: 0, accountProfile: { identities: [{ provider: 'google', label: 'viewer@example.com', primary: true }, { provider: 'email', label: 'viewer@example.com', primary: false }] },
    usage: { scope: true, connections, authorizations: new Map(), started: 0, requests: [] } };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    let body = {};
    if (request.method === 'POST') {
      let text = '';
      for await (const chunk of request) text += chunk;
      try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    }
    state.requests.push(request.url);
    if (request.url === '/api/v1/connection?scope=write') {
      const accepted = request.headers.authorization === `Bearer ${WRITE_TOKEN}`;
      response.writeHead(accepted ? 200 : 403);
      response.end(JSON.stringify(accepted ? { connected: true, scope: 'write', ownerId: 'fixture-owner' } : { error: 'Write permission required' }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401); response.end('{}'); return; }
    if (state.status !== 200) { response.writeHead(state.status); response.end('{}'); return; }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/v1/account') {
      response.writeHead(state.accountStatus);
      const payload = JSON.stringify(state.accountProfile);
      const respond = () => { response.end(payload); state.accountResponses++; };
      if (state.accountDelayMs) setTimeout(respond, state.accountDelayMs);
      else respond();
      return;
    }
    if (url.pathname.startsWith('/api/v1/usage')) { serveUsage(state, request, response, body); return; }
    if (url.pathname === '/api/v1/connection' && url.searchParams.get('scope') === 'read') { response.end(JSON.stringify({ connected: true, scope: 'read', ownerId: 'fixture-owner' })); return; }
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
  ports.getAccountProfiles = () => [
    { key: 'work', provider: 'codex', instance: 'Fixture Mac', root: '/fixture/codex-work', checkedAt: 1790000000, account: { id: 'work', displayName: 'Work account', kind: 'account' } },
    { key: 'personal', provider: 'claude', instance: 'Fixture Mac', root: '/fixture/claude-personal', checkedAt: 1790000000, usageRefreshFailed: true, account: { id: 'personal', displayName: 'Personal profile', kind: 'profile' } }
  ];
  const settings = new WorkspaceSettings({ ...ports, cloudDelivery });
  const errors = [];
  // The fixture records copied text instead of replacing the person's clipboard.
  const view = new WorkspaceWindow({ monitoring: client, settings, ...ports, writeClipboard: value => ports.calls.push(['clipboard', value]), reportError: error => { errors.push(error.message); } });
  const trayManager = new TrayManager({ getProjectIds: () => [], getState: () => null, isCompanionShown: () => false }, app);
  // The same composition as main.js: every issue source refreshes the tray.
  const refreshAttention = () => trayManager.setAttention(attentionNotices(attentionAreas(client.snapshot(), settings.getSnapshot())));
  settings.onSettingsChanged = () => { view.notify('settings'); refreshAttention(); };
  cloudDelivery.onChange = () => settings.notifyChanged();
  ports.hookInstaller.onStateChanged = () => { view.notify('settings'); refreshAttention(); };
  client.on('change', refreshAttention);
  trayManager.openDashboard = () => view.open('overview');
  trayManager.openSettings = page => view.open(page);
  trayManager.setCompanionVisibleHandler(ports.setCompanionVisible);
  trayManager.createTray();
  trayManager.tray.setToolTip('VibeMon workspace preview');
  function cleanup() {
    trayManager.cleanup(); view.cleanup(); client.stop(); server.close();
  }
  app.once('before-quit', cleanup);
  await client.configure({ url: 'https://vibemon.io', token: TOKEN });
  installWorkspaceMenu({ open: page => view.open(page), companionShown: false, setCompanionVisible: ports.setCompanionVisible });
  // Selecting the native menu action creates the workspace; the tray alone does not.
  const selectDashboard = () => Menu.buildFromTemplate(trayManager.buildMenuTemplate()).items.find(item => item.label.startsWith(t('nav.dashboard'))).click();
  assert.equal(view.window, null, 'creating the tray does not open the workspace');
  selectDashboard();
  view.window.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  view.window.webContents.on('did-fail-load', (_event, code, description) => errors.push(`${code}: ${description}`));
  return { ports, state, client, settings, view, trayManager, selectDashboard, preferences, errors, cleanup, corruptCredential() { corrupt = true; } };
}
module.exports = { startFixture, TOKEN, WRITE_TOKEN, CLAUDE_CODE };
