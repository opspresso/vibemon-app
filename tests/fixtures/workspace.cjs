const TOKEN = 'vm_' + 'f'.repeat(60);
const { localActivity } = require('../../src/workspace/activity.cjs');
function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { get: key => data.get(key), set: (key, value) => data.set(key, value), delete: key => data.delete(key) };
}
function sources(now = Date.now()) {
  const base = { health: 'ok', stale: false, observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString() };
  const resource = (id, displayName, kind, metrics, extra = {}) => ({ ...base, sourceId: id, displayName, kind, metrics, ...extra });
  const resources = [
    resource('production', 'Production cluster', 'cluster', { cpuPercent: 32, memoryPercent: 61, nodesReady: 8, nodesTotal: 8, podsUnhealthy: 0 }),
    resource('gpu-workstation', 'GPU workstation', 'host', { cpuPercent: 46, memoryPercent: 68, gpuPercent: 82, gpuTemperatureC: 64 }, { memoryType: 'unified' }),
    resource('cache', 'Cache service', 'resource', { latency: 12.4, throughput: 1420, connections: 182 }, { resourceType: 'Redis', health: 'warning', statusMessage: 'Latency is above its usual range', metricDefinitions: { latency: { label: 'Response time', unit: 'ms', display: 'gauge', min: 0, max: 50 }, throughput: { label: 'Throughput', unit: 'req/s', display: 'number', min: 0 }, connections: { label: 'Connections', unit: '', display: 'number', min: 0 } }, metricOrder: ['latency', 'throughput', 'connections'] }),
    resource('build-runner', 'Build runner', 'host', { cpuPercent: null, memoryPercent: 42 }, { stale: true, receivedAt: new Date(now - 240000).toISOString() })
  ];
  // Reset countdowns are minutes at the observation; Kiro reports no plan usage.
  for (const [provider, id, displayName, project, session, week, state, resets] of [
    ['codex', 'team', 'Engineering', 'web-console', 38, 62, 'working', { usage5hResetsIn: 125, usageWeekResetsIn: 4381 }],
    ['codex', 'personal', 'Personal projects', 'api-gateway', 16, 24, 'idle', { usage5hResetsIn: 42, usageWeekResetsIn: 8640 }],
    ['claude', 'studio', 'Design studio', 'web-console', 48, 84, 'thinking', { usage5hResetsIn: 18, usageWeekResetsIn: 1500 }],
    ['kiro', 'lab', 'Research lab', 'experiments', null, null, 'notification', {}]
  ]) {
    resources.push(resource(`${provider}-${id}`, project, 'agent', { contextPercent: 34, usageSessionPercent: session, usageWeekPercent: week }, { agent: { state, character: provider === 'claude' ? 'clawd' : provider, project, model: provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Kiro', ...resets }, account: { provider, id, displayName } }));
  }
  return resources;
}
function createPorts() {
  const appearance = { CharacterLock: 'auto', RenderMode: '3d', AlwaysOnTopMode: 'active-only', SpeechBubbleFields: { status: true, project: true, model: true, memory: true, usage5h: false, usageWeek: true, usageWeekModel: false }, CharacterScale: 70, DockAutoScale: true, EdgeMargin: 8, DevMode: false };
  const companion = {};
  for (const key of Object.keys(appearance)) {
    companion[`get${key}`] = () => appearance[key];
    companion[`set${key}`] = value => { appearance[key] = value; };
  }
  companion.setSpeechBubbleField = (field, enabled) => { appearance.SpeechBubbleFields[field] = enabled; };
  let companionVisible = true;
  companion.isCompanionVisible = () => companionVisible;
  companion.isCompanionShown = () => false;
  let login = false;
  const config = { debug: false, auto_launch: true, http_urls: ['http://127.0.0.1:19280'], serial_port: '', vibemon_url: 'https://vibemon.io', vibemon_token: 'fixture-secret-must-not-cross-IPC' };
  const hooks = [
    { name: 'Claude Code', flag: '--claude', present: true, hasHook: true, changed: false },
    { name: 'Codex CLI', flag: '--codex', present: true, hasHook: true, changed: true },
    { name: 'Kiro', flag: '--kiro', present: true, hasHook: false, changed: false },
    { name: 'OpenClaw', flag: '--openclaw', present: false, hasHook: false },
    { name: 'OpenCode', flag: '--opencode', present: false, hasHook: false },
    { name: 'VibeMon Scripts', flag: '--vibemon', present: true, hasHook: true }
  ];
  const update = { status: null, version: null };
  const calls = [];
  return {
    calls, appearance, config,
    windowManager: companion,
    app: { getVersion: () => require('../../package.json').version, isPackaged: false, getLoginItemSettings: () => ({ openAtLogin: login }), setLoginItemSettings: settings => { login = settings.openAtLogin; } },
    hookInstaller: {
      getCachedStatuses: () => hooks,
      clearDismissed() { for (const hook of hooks) hook.dismissed = false; },
      async checkForChanges() {},
      async installByFlag(flag) { calls.push(['install', flag]); const hook = hooks.find(item => item.flag === flag); if (!hook) return []; hook.hasHook = true; hook.changed = false; return [{ result: { ok: true } }]; }
    },
    vibemonConfigManager: {
      read: () => ({ ...config }), getStatus: () => ({ exists: true, hasDesktopUrl: true }),
      write(partial) { Object.assign(config, partial); }, ensureDesktopUrl() {},
      addHttpUrl(url) { config.http_urls.push(url); }, removeHttpUrl(url) { config.http_urls = config.http_urls.filter(value => value !== url); }
    },
    cloudDelivery: {
      snapshot: () => ({ url: config.vibemon_url, tokenConfigured: Boolean(config.vibemon_token), busy: false, status: config.vibemon_token ? 'not-verified' : 'not-configured', checkedAt: null, error: '' }),
      configure: async () => { throw new Error('Cloud delivery is unavailable in this fixture'); },
      check: async () => { throw new Error('Cloud delivery is unavailable in this fixture'); },
      disconnect: () => { config.vibemon_token = ''; }
    },
    updateChecker: { getState: () => update, async checkForUpdates() {}, async downloadUpdate() {}, installDownloaded() {} },
    openExternal: async url => { calls.push(['external', url]); },
    getActivity: () => localActivity({
      console: { project: 'web-console', state: 'working', character: 'codex', model: 'Codex', tool: 'Editing files' },
      api: { project: 'api-gateway', state: 'thinking', character: 'clawd', model: 'Claude', tool: 'Reviewing changes' }
    }, 'console'),
    getUsage: () => ({ codex: { session: { pct: 38, resetsAt: Date.now() / 1000 + 7200 }, week: { pct: 62, resetsAt: Date.now() / 1000 + 240000 }, modelWeek: null }, claude: { session: { pct: 48, resetsAt: Date.now() / 1000 + 5400 }, week: { pct: 84, resetsAt: Date.now() / 1000 + 180000 }, modelWeek: null } }),
    showCompanion: () => calls.push(['show-companion']),
    setCompanionVisible: visible => { companionVisible = visible; calls.push(['set-companion-visible', visible]); }
  };
}
function trend(item, now = Date.now()) {
  const entries = [];
  for (let index = 50; index >= 0; index--) {
    const metrics = Object.fromEntries(Object.entries(item.metrics).map(([key, value]) => [key, value === null ? null : value === 0 ? 0 : value * (0.82 + 0.15 * Math.sin(index / 7))]));
    entries.push({ timestamp: new Date(Math.floor(now / 60000) * 60000 - index * 60000).toISOString(), samples: 1, expiresAt: now / 1000 + 86400, average: metrics, maximum: metrics });
  }
  return { points: entries, ...(item.metricDefinitions ? { metricDefinitions: item.metricDefinitions, metricOrder: item.metricOrder } : {}) };
}
module.exports = { TOKEN, memoryStore, sources, createPorts, trend };
