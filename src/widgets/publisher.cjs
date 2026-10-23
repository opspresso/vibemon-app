/**
 * Publishes the widget feed for the macOS widgets.
 *
 * The publisher collects the monitoring snapshot, local activity, and plan
 * usage, builds the feed, and writes it to ~/.vibemon/widgets/feed.json. The
 * widget extension reads only that file.
 *
 * WidgetKit limits how often widgets refresh, so a reload is requested only
 * when the rendering differs from what the previous feed already predicted:
 * - immediately (at most every WIDGET_RELOAD_MIN_MS) when items or a current
 *   state tone change, for example a project starts to wait for input;
 * - at most every WIDGET_RELOAD_INTERVAL_MS for other changes, such as a new
 *   metric value or a label change between two active states.
 */
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../shared/atomic-file.cjs');
const { agentTransition } = require('../shared/monitoring/state.cjs');
const { WIDGET_PUBLISH_DELAY_MS, WIDGET_RELOAD_MIN_MS, WIDGET_RELOAD_INTERVAL_MS } = require('../shared/constants.cjs');

const FEED_PATH = path.join(os.homedir(), '.vibemon', 'widgets', 'feed.json');
// Times are recomputed from two clocks on every build; ignore jitter below this.
const TIME_TOLERANCE_MS = 2000;

/** The feed names resources, accounts, and collector messages, so only the user can read it. */
const writeFeedFile = (file, text) => writeFileAtomic(file, text, { mode: 0o600, directoryMode: 0o700 });

/** The display state of an item at an ISO time: the last entry that started by then. */
function current(item, at) {
  return item.timeline.findLast(entry => entry.at <= at) ?? item.timeline[0];
}

/** Items, titles, artwork, and current tones: changes the user must see now. */
function urgentKey(feed, at) {
  return JSON.stringify(feed.items.map(item => [
    item.id, item.kind, current(item, at).project ?? item.title, item.subtitle, item.selectionTitle, item.selectionSubtitle,
    item.symbol, item.artwork, item.link, current(item, at).tone
  ]));
}

const sameTime = (a, b) => a === b || (Boolean(a) && Boolean(b) && Math.abs(Date.parse(a) - Date.parse(b)) < TIME_TOLERANCE_MS);
const sameMetrics = (a, b) => a.length === b.length && a.every(({ resetsAt, ...metric }, index) => {
  const { resetsAt: next, ...other } = b[index];
  return sameTime(resetsAt, next) && JSON.stringify(metric) === JSON.stringify(other);
});

/** Everything else that a widget renders after `at`. */
function sameRendering(previous, next, at) {
  if (previous.items.length !== next.items.length) return false;
  return previous.items.every((before, index) => {
    const after = next.items[index];
    const plan = item => item.timeline.filter(entry => entry.at > at);
    const [old, upcoming] = [plan(before), plan(after)];
    const state = entry => JSON.stringify([entry.state, entry.label, entry.project]);
    return state(current(before, at)) === state(current(after, at))
      && before.message === after.message
      && sameMetrics(before.metrics, after.metrics)
      && sameTime(before.observedAt, after.observedAt)
      && old.length === upcoming.length
      && old.every((entry, step) => state(entry) === state(upcoming[step]) && sameTime(entry.at, upcoming[step].at));
  });
}

class WidgetPublisher {
  /**
   * @param {object} ports
   * @param {() => {cloud: object, states: Object<string, object>, usage: object}} ports.collect
   * @param {(input: object) => object} ports.build buildWidgetFeed from feed.mjs
   * @param {(file: string, text: string) => void} [ports.write]
   * @param {(() => void)|null} [ports.reload] WidgetCenter reload; null when unavailable
   * @param {(character: string) => string|undefined} [ports.artwork]
   */
  constructor({ collect, build, write = writeFeedFile, reload = null, artwork, file = FEED_PATH, now = Date.now, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { collect, build, write, reload, artwork, file, now, timers });
    this.published = null;
    this.lastReloadAt = -Infinity;
    this.publishTimer = null;
    this.reloadTimer = null;
    this.phases = new Map();
    this.stopped = false;
  }

  /** Publishes after a short delay; repeated calls within the delay coalesce. */
  schedule() {
    if (this.stopped || this.publishTimer) return;
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, WIDGET_PUBLISH_DELAY_MS);
  }

  publish(running = true) {
    const now = this.now();
    const { cloud, states, usage } = this.collect();
    const feed = this.build({ cloud, local: this.localProjects(states, now), usage, artwork: this.artwork, now, running });
    const previous = this.published;
    // The generation time alone is not a change.
    if (previous && JSON.stringify({ ...previous, generatedAt: null }) === JSON.stringify({ ...feed, generatedAt: null })) return;
    try {
      this.write(this.file, JSON.stringify(feed));
    } catch (error) {
      console.error('Widget feed write failed:', error.message);
      return;
    }
    this.published = feed;
    const at = new Date(now).toISOString();
    if (!previous || urgentKey(previous, at) !== urgentKey(feed, at)) this.requestReload(WIDGET_RELOAD_MIN_MS);
    else if (!sameRendering(previous, feed, at)) this.requestReload(WIDGET_RELOAD_INTERVAL_MS);
  }

  /**
   * Local projects with the time their state began. A report starts a new
   * phase. A timer transition continues the predicted chain, so its start
   * equals the time that the previous feed already predicted.
   */
  localProjects(states, now) {
    const projects = [];
    const seen = new Set();
    for (const [id, status] of Object.entries(states)) {
      if (id.startsWith('cloud:') || !status.account || typeof status.project !== 'string' || !status.project.trim()) continue;
      seen.add(id);
      const phase = this.phases.get(id);
      let since = now;
      if (phase && phase.observedAt === status.observedAt) {
        const transition = agentTransition(phase.state);
        if (phase.state === status.state) since = phase.since;
        else if (transition?.state === status.state) since = phase.since + transition.after;
      }
      this.phases.set(id, { state: status.state, observedAt: status.observedAt, since });
      projects.push({ id, since, status });
    }
    for (const id of this.phases.keys()) if (!seen.has(id)) this.phases.delete(id);
    return projects;
  }

  /** Requests a reload no sooner than `interval` after the previous one. */
  requestReload(interval) {
    if (!this.reload) return;
    const wait = this.lastReloadAt + interval - this.now();
    if (wait <= 0) {
      this.reloadNow();
      return;
    }
    // An earlier pending reload already covers this change.
    if (this.reloadTimer && this.reloadTimer.due <= this.now() + wait) return;
    this.timers.clearTimeout(this.reloadTimer?.handle);
    this.reloadTimer = { due: this.now() + wait, handle: this.timers.setTimeout(() => this.reloadNow(), wait) };
  }

  reloadNow() {
    this.timers.clearTimeout(this.reloadTimer?.handle);
    this.reloadTimer = null;
    this.lastReloadAt = this.now();
    try {
      this.reload();
    } catch (error) {
      console.error('Widget reload failed:', error.message);
    }
  }

  /** Writes a final feed that tells widgets the App has quit. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.clearTimeout(this.publishTimer);
    this.timers.clearTimeout(this.reloadTimer?.handle);
    this.publishTimer = null;
    this.reloadTimer = null;
    this.publish(false);
    if (this.reloadTimer) this.reloadNow();
  }
}

/** Plan usage from usage-cache-reader, keyed by account (`provider:id`). A bare provider key is its default account. */
function usageByAccount(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([key, buckets]) => [key.includes(':') ? key : `${key}:default`, buckets]));
}

/** WidgetKit widgets need macOS 14 (Darwin 23) or later. */
function widgetsSupported(platform = process.platform, release = os.release()) {
  return platform === 'darwin' && Number.parseInt(release, 10) >= 23;
}

module.exports = { WidgetPublisher, writeFeedFile, usageByAccount, widgetsSupported };
