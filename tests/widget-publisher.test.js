const fs = require('fs');
const os = require('os');
const path = require('path');
const { WidgetPublisher, writeFeedFile, usageByAccount, widgetsSupported } = require('../src/widgets/publisher.cjs');
const { IDLE_TIMEOUT_MS, WIDGET_PUBLISH_DELAY_MS, WIDGET_RELOAD_MIN_MS, WIDGET_RELOAD_INTERVAL_MS } = require('../src/shared/constants.cjs');

const T0 = Date.parse('2026-10-16T09:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

function item({ id = 'resource:a', tone = 'good', state = 'ok', metric = '1', timeline, resetsAt } = {}) {
  return {
    id, kind: 'resource', title: 'A', subtitle: 'Host', observedAt: iso(T0), link: 'vibemon://dashboard/resources',
    metrics: [{ key: 'cpuPercent', label: 'CPU', value: metric, unit: '%', fraction: 0.01, tone: 'normal', ...(resetsAt ? { resetsAt } : {}) }],
    timeline: timeline ?? [{ at: iso(T0), state, label: state, tone }]
  };
}

function setup() {
  let now = T0;
  const timers = [];
  const writes = [];
  const reloads = [];
  const inputs = [];
  let items = [item()];
  let states = {};
  const publisher = new WidgetPublisher({
    collect: () => ({ cloud: { sources: [] }, states, usage: {} }),
    build: input => {
      inputs.push(input);
      return { version: 1, generatedAt: iso(input.now), running: input.running, items };
    },
    write: (file, text) => writes.push(JSON.parse(text)),
    reload: () => reloads.push(now),
    file: '/feed.json',
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => { const timer = { fn, due: now + ms }; timers.push(timer); return timer; },
      clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }
    }
  });
  // Fires each due timer at its own time, in order.
  const advance = ms => {
    const end = now + ms;
    for (let next; (next = timers.filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0]);) {
      timers.splice(timers.indexOf(next), 1);
      now = next.due;
      next.fn();
    }
    now = end;
  };
  return {
    publisher, writes, reloads, inputs, timers, advance,
    setItems: next => { items = next; },
    setStates: next => { states = next; },
    at: () => now
  };
}

describe('WidgetPublisher', () => {
  test('coalesces scheduled publications and writes the first feed with a reload', () => {
    const { publisher, writes, reloads, advance } = setup();
    publisher.schedule();
    publisher.schedule();
    advance(WIDGET_PUBLISH_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect(reloads).toEqual([T0 + WIDGET_PUBLISH_DELAY_MS]);
  });

  test('skips the write when only the generation time changes', () => {
    const { publisher, writes, reloads, advance } = setup();
    publisher.publish();
    advance(60000);
    publisher.publish();
    expect(writes).toHaveLength(1);
    expect(reloads).toHaveLength(1);
  });

  test('reloads quickly when a current tone changes, but not twice within the minimum gap', () => {
    const { publisher, reloads, setItems, advance } = setup();
    publisher.publish();
    setItems([item({ tone: 'warning', state: 'warning' })]);
    advance(1000);
    publisher.publish();
    expect(reloads).toHaveLength(1);
    advance(WIDGET_RELOAD_MIN_MS);
    expect(reloads).toEqual([T0, T0 + WIDGET_RELOAD_MIN_MS]);
  });

  test('throttles metric-only changes to the reload interval', () => {
    const { publisher, reloads, writes, setItems, advance } = setup();
    publisher.publish();
    setItems([item({ metric: '2' })]);
    publisher.publish();
    setItems([item({ metric: '3' })]);
    advance(1000);
    publisher.publish();
    expect(writes).toHaveLength(3);
    expect(reloads).toEqual([T0]);
    advance(WIDGET_RELOAD_INTERVAL_MS);
    expect(reloads).toEqual([T0, T0 + WIDGET_RELOAD_INTERVAL_MS]);
  });

  test('reset time jitter needs no reload, but a moved reset does', () => {
    const { publisher, reloads, setItems, advance } = setup();
    setItems([item({ resetsAt: iso(T0 + 3600000) })]);
    publisher.publish();
    setItems([item({ resetsAt: iso(T0 + 3600000 + 500) })]);
    publisher.publish();
    advance(WIDGET_RELOAD_INTERVAL_MS);
    expect(reloads).toEqual([T0]);
    setItems([item({ resetsAt: iso(T0 + 7200000) })]);
    publisher.publish();
    expect(reloads).toEqual([T0, T0 + WIDGET_RELOAD_INTERVAL_MS]);
  });

  test('does not reload when the feed reaches a state that the previous feed predicted', () => {
    const { publisher, reloads, writes, setItems, advance } = setup();
    const aging = [{ at: iso(T0), state: 'ok', label: 'Healthy', tone: 'good' }, { at: iso(T0 + 120000), state: 'stale', label: 'Stale', tone: 'warning' }];
    setItems([item({ timeline: aging })]);
    publisher.publish();
    advance(120000);
    setItems([item({ timeline: [{ ...aging[1], at: iso(T0 + 120000) }] })]);
    publisher.publish();
    expect(writes).toHaveLength(2);
    expect(reloads).toEqual([T0]);
  });

  test('a timer transition keeps the predicted phase start; a new report starts a new phase', () => {
    const { publisher, inputs, setStates, advance, at } = setup();
    const account = { provider: 'claude', id: 'default', displayName: 'claude default' };
    setStates({ p: { state: 'done', project: 'app', account, observedAt: 'o1' }, 'cloud:x': { state: 'working', project: 'x', account } });
    publisher.publish();
    expect(inputs.at(-1).local).toEqual([{ id: 'p', since: T0, status: expect.objectContaining({ state: 'done' }) }]);
    advance(IDLE_TIMEOUT_MS + 15);
    setStates({ p: { state: 'idle', project: 'app', account, observedAt: 'o1' } });
    publisher.publish();
    expect(inputs.at(-1).local[0].since).toBe(T0 + IDLE_TIMEOUT_MS);
    setStates({ p: { state: 'idle', project: 'app', account, observedAt: 'o2' } });
    publisher.publish();
    expect(inputs.at(-1).local[0].since).toBe(at());
  });

  test('ignores local projects without an account or project name', () => {
    const { publisher, inputs, setStates } = setup();
    setStates({ a: { state: 'working', project: 'x' }, b: { state: 'working', project: ' ', account: {} } });
    publisher.publish();
    expect(inputs.at(-1).local).toEqual([]);
  });

  test('stop writes a final feed for a closed App and reloads at once', () => {
    const { publisher, writes, reloads, timers } = setup();
    publisher.publish();
    publisher.schedule();
    publisher.stop();
    expect(writes.at(-1).running).toBe(false);
    expect(reloads).toEqual([T0, T0]);
    expect(timers).toHaveLength(0);
    publisher.schedule();
    expect(timers).toHaveLength(0);
  });

  test('a failed write keeps the previous feed and requests no reload', () => {
    const { publisher, reloads } = setup();
    publisher.write = () => { throw new Error('disk full'); };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    publisher.publish();
    expect(reloads).toEqual([]);
    expect(publisher.published).toBeNull();
    expect(error).toHaveBeenCalledWith('Widget feed write failed:', 'disk full');
    error.mockRestore();
  });

  test('works without a reload port', () => {
    const { publisher, writes } = setup();
    publisher.reload = null;
    publisher.publish();
    expect(writes).toHaveLength(1);
  });

  test('a failing reload is reported without stopping publication', () => {
    const { publisher, setItems, writes } = setup();
    publisher.reload = () => { throw new Error('no service'); };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    publisher.publish();
    setItems([item({ metric: '9' })]);
    publisher.publish();
    expect(writes).toHaveLength(2);
    expect(error).toHaveBeenCalledWith('Widget reload failed:', 'no service');
    error.mockRestore();
  });
});

describe('widget feed helpers', () => {
  test('writeFeedFile replaces the file atomically with user-only permissions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-widgets-'));
    const file = path.join(directory, 'widgets', 'feed.json');
    writeFeedFile(file, '{"version":1}');
    writeFeedFile(file, '{"version":2}');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":2}');
    // Windows has no POSIX permission bits; the feed is read only on macOS.
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['feed.json']);
    fs.rmSync(directory, { recursive: true });
  });

  test('usage is keyed by account, with the default account for an unnamed cache key', () => {
    const snapshot = { claude: { session: { pct: 1 } }, codex: { session: null } };
    expect(usageByAccount(snapshot, provider => (provider === 'codex' ? 'codex:work' : provider))).toEqual({
      'claude:default': snapshot.claude, 'codex:work': snapshot.codex
    });
    expect(usageByAccount(snapshot, () => null)).toEqual({});
  });

  test('widgets need macOS 14 or later', () => {
    expect(widgetsSupported('darwin', '23.0.0')).toBe(true);
    expect(widgetsSupported('darwin', '22.6.0')).toBe(false);
    expect(widgetsSupported('win32', '23.0.0')).toBe(false);
  });
});
