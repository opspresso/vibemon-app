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
  assert.deepEqual(feed, { version: WIDGET_FEED_VERSION, generatedAt: iso(0), running: false, items: [] });
});

test('a resource shows its selected metrics, formatted by the shared rules, and turns stale on time', () => {
  const [item] = build({ cloud: cloud([host()], { selectedMetrics: ['memoryPercent', 'gpuPercent', 'gpuTemperatureC'] }) }).items;
  assert.equal(item.id, 'resource:mac-studio');
  assert.equal(item.subtitle, 'Host');
  assert.equal(item.symbol, 'unified');
  assert.deepEqual(item.metrics, [
    { key: 'memoryPercent', label: 'Unified memory', value: '71.5', unit: '%', fraction: 0.715, tone: 'normal' },
    { key: 'gpuPercent', label: 'GPU', value: '—', unit: '', fraction: null, tone: 'normal' },
    { key: 'gpuTemperatureC', label: 'GPU temperature', value: '61', unit: '°C', fraction: null, tone: 'normal' }
  ]);
  assert.deepEqual(item.timeline, [
    { at: iso(0), state: 'ok', label: 'Healthy', tone: 'good' },
    { at: iso(constants.CLOUD_STALE_MS - minutes(1)), state: 'stale', label: 'Stale', tone: 'warning' }
  ]);
});

test('a resource shows at most three metrics and its collector message', () => {
  const [item] = build({ cloud: cloud([host({ statusMessage: 'Serving requests' })]) }).items;
  assert.deepEqual(item.metrics.map(metric => metric.key), ['cpuPercent', 'memoryPercent', 'gpuPercent']);
  assert.equal(item.metrics[0].value, '42.35');
  assert.equal(item.message, 'Serving requests');
});

test('timeline times follow the wall clock when the server clock differs', () => {
  const skew = minutes(3);
  const [item] = build({ cloud: cloud([host({ receivedAt: iso(skew - minutes(1)) })], { evaluatedAt: NOW + skew }) }).items;
  assert.equal(item.observedAt, iso(-minutes(1)));
  assert.equal(item.timeline[0].at, iso(0));
  assert.equal(item.timeline[1].at, iso(constants.CLOUD_STALE_MS - minutes(1)));
});

test('a coding account ages through idle to inactive', () => {
  const [item] = build({ cloud: cloud([agentSource()]) }).items;
  assert.equal(item.id, 'agent:claude:work');
  assert.equal(item.title, 'Claude Code');
  assert.equal(item.subtitle, 'work');
  assert.equal(item.artwork, 'clawd.png');
  assert.deepEqual(item.timeline, [
    { at: iso(0), state: 'working', label: 'Working', tone: 'active' },
    { at: iso(constants.SLEEP_TIMEOUT_MS - minutes(2)), state: 'idle', label: 'Idle', tone: 'neutral' },
    { at: iso(2 * constants.SLEEP_TIMEOUT_MS - minutes(2)), state: 'inactive', label: 'Inactive', tone: 'neutral' }
  ]);
  assert.deepEqual(item.metrics.map(({ label, value, tone }) => [label, value, tone]), [['Context', '34', 'normal'], ['Session', '72.4', 'warning'], ['Weekly', '91', 'danger']]);
});

test('an input request from an older project outranks newer work on the same account', () => {
  const waiting = agentSource({ sourceId: 'agent:a', observedAt: iso(-minutes(3)), agent: { state: 'notification', character: 'clawd', project: 'web' } });
  const working = agentSource({ sourceId: 'agent:b', observedAt: iso(-minutes(1)), agent: { state: 'working', character: 'clawd', project: 'api' } });
  const [item] = build({ cloud: cloud([working, waiting]) }).items;
  assert.deepEqual(item.timeline[0], { at: iso(0), state: 'notification', label: 'Needs input', tone: 'warning' });
  // The input request ages out first; the newer work is then shown.
  assert.deepEqual(item.timeline[1], { at: iso(constants.SLEEP_TIMEOUT_MS - minutes(3)), state: 'working', label: 'Working', tone: 'active' });
});

test('local delivery replaces the cloud copy of a source and fills usage from this device', () => {
  const local = [{
    id: 'local:agent:remote', since: NOW - 30000,
    status: { state: 'done', project: 'api', character: 'clawd', sourceId: 'agent:remote', memory: 12, account: { id: 'work', provider: 'claude', displayName: 'Work' } }
  }];
  const usage = { 'claude:work': { session: { pct: 55, resetsAt: NOW / 1000 + 3600 }, week: null } };
  const [item] = build({ cloud: cloud([agentSource()]), local, usage }).items;
  assert.deepEqual(item.timeline.map(entry => entry.state), ['done', 'idle', 'inactive']);
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

test('local projects appear without a cloud connection, sorted after resources', () => {
  const local = [
    { id: 'local:x', since: NOW, status: { state: 'thinking', project: 'x', character: 'codex', account: { id: 'default', provider: 'codex', displayName: 'codex default' } } },
    { id: 'local:y', since: NOW, status: { state: 'working', project: 'y', character: 'clawd', account: { id: 'default', provider: 'claude', displayName: 'claude default' } } }
  ];
  const feed = build({ cloud: cloud([host()]), local });
  assert.deepEqual(feed.items.map(item => item.id), ['resource:mac-studio', 'agent:claude:default', 'agent:codex:default']);
  assert.deepEqual(feed.items.map(item => item.link), ['vibemon://dashboard/resources', 'vibemon://dashboard/agents', 'vibemon://dashboard/agents']);
});
