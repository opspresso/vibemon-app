import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWidgetFeed, WIDGET_FEED_VERSION } from '../src/widgets/feed.mjs';
import domain from '../src/monitoring/domain.cjs';
import constants from '../src/shared/constants.cjs';

const { displayMetrics } = domain;
const NOW = Date.parse('2026-10-16T09:00:00.000Z');
const iso = offset => new Date(NOW + offset).toISOString();
const minutes = count => count * 60000;

const host = (overrides = {}) => {
  const source = {
    sourceId: 'mac-studio', kind: 'host', displayName: 'Mac Studio', receivedAt: iso(-minutes(1)), observedAt: iso(-minutes(1)),
    health: 'ok', stale: false, memoryType: 'unified', agent: null, account: null,
    metrics: { cpuPercent: 42.345, memoryPercent: 71.5, gpuPercent: null, gpuTemperatureC: 61 },
    ...overrides
  };
  return { ...source, displayMetrics: displayMetrics(source) };
};
const agentSource = (overrides = {}) => ({
  sourceId: 'agent:remote', kind: 'agent', displayName: 'api', receivedAt: iso(-minutes(2)), observedAt: iso(-minutes(2)),
  health: 'ok', stale: false, memoryType: null,
  agent: { state: 'working', character: 'clawd', project: 'api' },
  account: { id: 'work', provider: 'claude', displayName: 'Work' },
  metrics: { contextPercent: 34, usageSessionPercent: 72.4, usageWeekPercent: 91 },
  ...overrides
});
const cloud = (sources, overrides = {}) => ({
  evaluatedAt: NOW, sources, selectedMetrics: ['cpuPercent', 'memoryPercent', 'gpuPercent', 'gpuTemperatureC', 'contextPercent', 'usageSessionPercent', 'usageWeekPercent'],
  ...overrides
});
const build = (input) => buildWidgetFeed({ now: NOW, artwork: name => `${name}.png`, ...input });

test('an empty workspace produces a versioned feed without items', () => {
  const feed = build({ cloud: cloud([], { selectedMetrics: [] }), running: false });
  assert.deepEqual(feed, { version: WIDGET_FEED_VERSION, generatedAt: iso(0), items: [] });
});

test('a resource shows its selected metrics, formatted by the shared rules, and goes on standby on time', () => {
  const [item] = build({ cloud: cloud([host()], { selectedMetrics: ['memoryPercent', 'gpuPercent', 'gpuTemperatureC'] }) }).items;
  assert.equal(item.id, 'resource:mac-studio');
  assert.equal(item.subtitle, 'Host');
  assert.equal(item.symbol, 'unified');
  assert.deepEqual(item.metrics, [
    { key: 'memoryPercent', label: 'Unified memory', value: '71.5', valueParts: { integer: '71', fraction: '.5' }, unit: '%', fraction: 0.715, tone: 'normal' },
    { key: 'gpuPercent', label: 'GPU', value: '—', valueParts: { integer: '—', fraction: '' }, unit: '', fraction: null, tone: 'normal' },
    { key: 'gpuTemperatureC', label: 'GPU temperature', value: '61', valueParts: { integer: '61', fraction: '' }, unit: '°C', fraction: null, tone: 'normal' }
  ]);
  assert.deepEqual(item.timeline, [
    { at: iso(0), state: 'ok', label: 'Healthy', tone: 'good' },
    { at: iso(constants.CLOUD_STALE_MS - minutes(1)), state: 'standby', label: 'Standby', tone: 'neutral' }
  ]);
});

test('the feed of a closed App keeps every item on standby without later changes', () => {
  const working = agentSource({ agent: { state: 'notification', character: 'clawd', project: 'web' } });
  const items = build({ cloud: cloud([host(), working]), running: false }).items;
  assert.deepEqual(items.map(item => item.timeline), [
    [{ at: iso(0), state: 'standby', label: 'Standby', tone: 'neutral', project: 'web' }],
    [{ at: iso(0), state: 'standby', label: 'Standby', tone: 'neutral' }]
  ]);
  // The order stays the reported one, so a widget without a choice keeps its item: the input request first.
  const live = build({ cloud: cloud([host(), working]) }).items;
  assert.deepEqual(items.map(item => item.id), live.map(item => item.id));
  assert.deepEqual(items.map(item => item.kind), ['agent', 'resource']);
  assert.equal(build({ cloud: cloud([host()]), running: false, locale: 'ko' }).items[0].timeline[0].label, '대기');
});

test('a resource shows at most three metrics and its collector message', () => {
  const [item] = build({ cloud: cloud([host({ statusMessage: 'Serving requests' })]) }).items;
  assert.deepEqual(item.metrics.map(metric => metric.key), ['cpuPercent', 'memoryPercent', 'gpuPercent']);
  assert.equal(item.metrics[0].value, '42.35');
  assert.equal(item.message, 'Serving requests');
});

test('automatic resource widgets choose attention before an alphabetically earlier healthy resource', () => {
  const healthy = host({ sourceId: 'healthy', displayName: 'Alpha healthy' });
  const failing = host({ sourceId: 'failing', displayName: 'Zeta failing', health: 'error' });
  const items = build({ cloud: cloud([healthy, failing]) }).items;
  assert.deepEqual(items.map(item => item.id), ['resource:failing', 'resource:healthy']);
  assert.equal(items[0].timeline[0].state, 'error');
});

test('automatic choices place an account needing input before a healthy resource', () => {
  const resource = host({ sourceId: 'healthy', displayName: 'Alpha healthy' });
  const waiting = agentSource({
    agent: { state: 'notification', character: 'clawd', project: 'Zeta input' }
  });
  const items = build({ cloud: cloud([resource, waiting]) }).items;
  assert.deepEqual(items.map(item => item.id), ['agent:claude:work', 'resource:healthy']);
});

test('timeline times follow the wall clock when the server clock differs', () => {
  const skew = minutes(3);
  const [item] = build({ cloud: cloud([host({ receivedAt: iso(skew - minutes(1)) })], { evaluatedAt: NOW + skew }) }).items;
  assert.equal(item.observedAt, iso(-minutes(1)));
  assert.equal(item.timeline[0].at, iso(0));
  assert.equal(item.timeline[1].at, iso(constants.CLOUD_STALE_MS - minutes(1)));
});

test('a coding account ages through idle to standby', () => {
  const [item] = build({ cloud: cloud([agentSource()]) }).items;
  assert.equal(item.id, 'agent:claude:work');
  assert.equal(item.title, 'api');
  assert.equal(item.subtitle, 'Claude Code · work');
  assert.equal(item.artwork, 'clawd.png');
  assert.deepEqual(item.timeline, [
    { at: iso(0), state: 'working', label: 'Working', tone: 'active', project: 'api' },
    { at: iso(constants.SLEEP_TIMEOUT_MS - minutes(2)), state: 'idle', label: 'Idle', tone: 'neutral', project: 'api' },
    { at: iso(2 * constants.SLEEP_TIMEOUT_MS - minutes(2)), state: 'standby', label: 'Standby', tone: 'neutral', project: 'api' }
  ]);
  assert.deepEqual(item.metrics.map(({ label, value, tone }) => [label, value, tone]), [['Context', '34', 'normal'], ['Session', '72.4', 'warning'], ['Weekly', '91', 'danger']]);
});

test('an input request from an older project outranks newer work on the same account', () => {
  const waiting = agentSource({ sourceId: 'agent:a', observedAt: iso(-minutes(3)), agent: { state: 'notification', character: 'clawd', project: 'web' } });
  const working = agentSource({ sourceId: 'agent:b', observedAt: iso(-minutes(1)), agent: { state: 'working', character: 'clawd', project: 'api' } });
  const [item] = build({ cloud: cloud([working, waiting]) }).items;
  assert.equal(item.title, 'web');
  assert.equal(item.subtitle, 'Claude Code · work');
  assert.deepEqual(item.timeline[0], { at: iso(0), state: 'notification', label: 'Needs input', tone: 'warning', project: 'web' });
  // The input request ages out first; the newer work is then shown.
  assert.deepEqual(item.timeline[1], { at: iso(constants.SLEEP_TIMEOUT_MS - minutes(3)), state: 'working', label: 'Working', tone: 'active', project: 'api' });
});

test('automatic coding widgets prioritize attention and put standby accounts last, newest first', () => {
  const account = (id, provider, project, state, age) => agentSource({
    sourceId: `agent:${id}`, observedAt: iso(-age),
    account: { id, provider, displayName: id }, agent: { state, character: provider === 'claude' ? 'clawd' : 'codex', project }
  });
  const standbyAge = 2 * constants.SLEEP_TIMEOUT_MS;
  const sources = [
    account('old', 'claude', 'Alpha old', 'working', standbyAge + minutes(10)),
    account('active', 'codex', 'Beta active', 'working', 1000),
    account('recent', 'claude', 'Zeta recent', 'working', standbyAge + minutes(1)),
    account('waiting', 'codex', 'Zeta input', 'notification', 1000)
  ];
  const items = build({ cloud: cloud(sources) }).items;
  assert.deepEqual(items.map(item => item.id), ['agent:codex:waiting', 'agent:codex:active', 'agent:claude:recent', 'agent:claude:old']);
  assert.deepEqual(items.map(item => item.timeline[0].state), ['notification', 'working', 'standby', 'standby']);
});

test('coding widget name ordering uses the project responsible for the account state', () => {
  const latest = agentSource({
    sourceId: 'agent:latest', observedAt: iso(-1000),
    agent: { state: 'working', character: 'clawd', project: 'Alpha latest' }
  });
  const waiting = agentSource({ sourceId: 'agent:waiting', agent: { state: 'notification', character: 'clawd', project: 'Zulu input' } });
  const other = agentSource({
    sourceId: 'agent:other', account: { id: 'other', provider: 'codex', displayName: 'Other' },
    agent: { state: 'notification', character: 'codex', project: 'Bravo input' }
  });
  const items = build({ cloud: cloud([latest, waiting, other]) }).items;
  assert.deepEqual(items.map(item => item.id), ['agent:codex:other', 'agent:claude:work']);
  assert.ok(items.every(item => item.timeline[0].state === 'notification'));
  assert.equal(items[1].selectionSubtitle, 'Work · Alpha latest · Zulu input');
});

test('automatic choices keep a stable identity when names match and report order changes', () => {
  const sources = [
    host({ sourceId: 'b', displayName: 'Same resource' }),
    host({ sourceId: 'a', displayName: 'Same resource' }),
    agentSource({ sourceId: 'agent:b', account: { provider: 'codex', id: 'b', displayName: 'B' } }),
    agentSource({ sourceId: 'agent:a', account: { provider: 'codex', id: 'a', displayName: 'A' } })
  ];
  const expected = ['agent:codex:a', 'agent:codex:b', 'resource:a', 'resource:b'];
  for (const input of [sources, [...sources].reverse()]) {
    assert.deepEqual(build({ cloud: cloud(input) }).items.map(item => item.id), expected);
  }
});

test('local delivery replaces the cloud copy of a source and fills usage from this device', () => {
  const local = [{
    id: 'local:agent:remote', since: NOW - 30000,
    status: { state: 'done', project: 'api', character: 'clawd', sourceId: 'agent:remote', memory: 12, account: { id: 'work', provider: 'claude', displayName: 'Work' } }
  }];
  const usage = { 'claude:work': { session: { pct: 55, resetsAt: NOW / 1000 + 3600 }, week: null } };
  const [item] = build({ cloud: cloud([agentSource()]), local, usage }).items;
  assert.deepEqual(item.timeline.map(entry => entry.state), ['done', 'idle', 'standby']);
  assert.equal(item.timeline[1].at, iso(constants.IDLE_TIMEOUT_MS - 30000));
  assert.deepEqual(item.metrics.map(metric => metric.value), ['12', '55', '—']);
  assert.equal(item.observedAt, iso(-30000));
});

test('plan usage carries the wall-clock time at which it resets', () => {
  const skew = minutes(3);
  const remote = agentSource({ observedAt: iso(skew - minutes(2)), agent: { state: 'working', character: 'clawd', project: 'api', usage5hResetsIn: 125, usageWeekResetsIn: 4381 } });
  const [item] = build({ cloud: cloud([remote], { evaluatedAt: NOW + skew }) }).items;
  assert.deepEqual(item.metrics.map(metric => metric.resetsAt), [undefined, iso(-minutes(2) + minutes(125)), iso(-minutes(2) + minutes(4381))]);
  // A missing value has no countdown, even when the reset time is known.
  const empty = agentSource({ metrics: { contextPercent: 34, usageSessionPercent: null, usageWeekPercent: null }, agent: { ...remote.agent } });
  assert.deepEqual(build({ cloud: cloud([empty]) }).items[0].metrics.map(metric => metric.resetsAt), [undefined, undefined, undefined]);
});

test('local reports count reset times from their own observation, and cached usage from its cache', () => {
  const local = [{
    id: 'local:agent:remote', since: NOW - minutes(10),
    status: { state: 'working', project: 'api', character: 'clawd', sourceId: 'agent:remote', usage5h: 40, usage5hResetsIn: 30, observedAt: iso(-minutes(1)), account: { id: 'work', provider: 'claude', displayName: 'Work' } }
  }];
  const usage = { 'claude:work': { session: null, week: { pct: 20, resetsAt: NOW / 1000 + 7200 } } };
  const [item] = build({ cloud: cloud([], { evaluatedAt: NOW + minutes(3) }), local, usage }).items;
  assert.deepEqual(item.metrics.map(metric => metric.resetsAt), [undefined, iso(minutes(29)), iso(minutes(120))]);
});

test('reset times outside the Date range do not stop the feed', () => {
  const remote = agentSource({ agent: { state: 'working', character: 'clawd', project: 'api', usage5hResetsIn: Number.MAX_SAFE_INTEGER } });
  const usage = { 'claude:work': { session: null, week: { pct: 20, resetsAt: Number.MAX_SAFE_INTEGER } } };
  const [item] = build({ cloud: cloud([{ ...remote, metrics: { ...remote.metrics, usageWeekPercent: null } }]), usage }).items;
  assert.deepEqual(item.metrics.map(metric => [metric.value, metric.resetsAt]), [['34', undefined], ['72.4', undefined], ['20', undefined]]);
});

test('cached usage without a reset time has no countdown', () => {
  const remote = agentSource();
  const usage = { 'claude:work': { session: null, week: { pct: 20, resetsAt: null } } };
  const [item] = build({ cloud: cloud([{ ...remote, metrics: { ...remote.metrics, usageWeekPercent: null } }]), usage }).items;
  assert.deepEqual(item.metrics.map(metric => [metric.value, metric.resetsAt]), [['34', undefined], ['72.4', undefined], ['20', undefined]]);
});

test('local projects appear without a cloud connection and keep their links', () => {
  const local = [
    { id: 'local:x', since: NOW, status: { state: 'thinking', project: 'x', character: 'codex', account: { id: 'default', provider: 'codex', displayName: 'codex default' } } },
    { id: 'local:y', since: NOW, status: { state: 'working', project: 'y', character: 'clawd', account: { id: 'default', provider: 'claude', displayName: 'claude default' } } }
  ];
  const feed = build({ cloud: cloud([host()]), local });
  assert.deepEqual(feed.items.map(item => item.id), ['agent:codex:default', 'agent:claude:default', 'resource:mac-studio']);
  assert.deepEqual(feed.items.map(item => item.link), ['vibemon://dashboard/agents', 'vibemon://dashboard/agents', 'vibemon://dashboard/resources']);
});

test('labels follow the App language', () => {
  const feed = build({ cloud: cloud([host(), agentSource()]), locale: 'ko' });
  const resource = feed.items.find(item => item.kind === 'resource');
  const agent = feed.items.find(item => item.kind === 'agent');
  assert.deepEqual(feed.items.map(item => item.kind), ['agent', 'resource']);
  assert.equal(resource.subtitle, '호스트');
  assert.deepEqual(resource.metrics.map(metric => metric.label), ['CPU', '통합 메모리', 'GPU']);
  assert.equal(resource.timeline[0].label, '정상');
  assert.deepEqual(agent.metrics.map(metric => metric.label), ['컨텍스트', '세션', '주간']);
  assert.equal(agent.timeline[0].label, '작업 중');
  assert.equal(build({ cloud: cloud([agentSource()]) }).items[0].metrics[1].label, 'Session');
});


test('widget choices identify accounts of the same provider and show their projects', () => {
  const work = agentSource({ account: { provider: 'codex', id: `auto:27e702a8${'a'.repeat(56)}`, displayName: 'Work' }, agent: { state: 'working', character: 'codex', project: 'dockpad' } });
  const personal = agentSource({ sourceId: 'agent:personal', account: { provider: 'codex', id: `auto:396c8f1c${'b'.repeat(56)}`, displayName: 'Personal' }, agent: { state: 'working', character: 'codex', project: 'opspresso' } });
  const items = build({ cloud: cloud([work, personal]) }).items;
  assert.deepEqual(items.map(item => item.selectionTitle).sort(), ['Codex · 27e702a8', 'Codex · 396c8f1c']);
  assert.equal(items.find(item => item.selectionTitle.endsWith('27e702a8')).selectionSubtitle, 'Work · dockpad');
  assert.equal(items.find(item => item.selectionTitle.endsWith('396c8f1c')).selectionSubtitle, 'Personal · opspresso');
  assert.equal(items.find(item => item.selectionTitle.endsWith('27e702a8')).title, 'dockpad');
  assert.equal(items.find(item => item.selectionTitle.endsWith('27e702a8')).subtitle, 'Codex · 27e702a8');
  assert.equal(items.find(item => item.selectionTitle.endsWith('27e702a8')).id, `agent:codex:auto:27e702a8${'a'.repeat(56)}`);
  assert.equal(new Set(items.map(item => item.id)).size, 2);
  assert.ok(items.every(item => item.id.includes('auto:') && item.id.length > 64));
});
