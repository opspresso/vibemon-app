// The presentation model for the macOS widgets (native/macos).
//
// Pure: the App decides every state, label, tone, and number format here, and
// the widget only lays the result out. One item is one resource or one coding
// agent account. Each item carries a timeline of its future display states,
// so a widget keeps aging correctly between App writes.
import { accountName, formatMeasurement, measurementUnit, metricTone, providerLabel, resourceType, stateLabel, stateTone } from '../shared/design/presentation.mjs';
import monitoring from '../shared/monitoring/state.cjs';
import clock from '../shared/monitoring/clock.cjs';
import constants from '../shared/constants.cjs';

const { accountActivity, agentTransition, groupAccounts, sourceState } = monitoring;
const { usageResetAt } = clock;

export const WIDGET_FEED_VERSION = 1;
// A small widget shows three metric rows.
const METRIC_LIMIT = 3;
// Every agent state chain ends within this window; resources turn stale sooner.
const HORIZON_MS = 60 * 60 * 1000;
const AGENT_METRICS = [
  { key: 'contextPercent', label: 'Context' },
  { key: 'usageSessionPercent', label: 'Session', usage: 'session' },
  { key: 'usageWeekPercent', label: 'Weekly', usage: 'week' }
];
const GAUGE = { unit: '%', display: 'gauge', min: 0, max: 100 };
const LINKS = { resource: 'vibemon://dashboard/resources', agent: 'vibemon://dashboard/agents' };

/**
 * @param {object} input
 * @param {object} input.cloud MonitoringClient.snapshot(); `evaluatedAt` is its report clock.
 * @param {Array<{id: string, since: number, status: object}>} [input.local] Local projects with an account.
 *   `since` is the wall-clock time at which `status.state` began.
 * @param {Object<string, {session?: {pct: number, resetsAt: number|null}, week?: {pct: number, resetsAt: number|null}}>} [input.usage]
 *   Plan usage on this device by account key (`provider:id`). `resetsAt` is in epoch seconds.
 * @param {(character: string) => string|undefined} [input.artwork] Character image file name.
 * @param {number} input.now Wall-clock time in milliseconds.
 * @param {boolean} [input.running] False for the last feed before the App quits.
 */
export function buildWidgetFeed({ cloud, local = [], usage = {}, artwork = () => undefined, now, running = true }) {
  // Cloud times follow the server clock. Widgets compare times with the wall
  // clock, so every time is moved by the current difference between the two.
  const reportNow = cloud.evaluatedAt;
  const offset = reportNow - now;
  const wall = time => new Date(time - offset).toISOString();
  const selected = new Set(cloud.selectedMetrics);
  const resources = cloud.sources
    .filter(source => source.kind !== 'agent')
    .map(source => resourceItem(source, selected, reportNow, wall));
  const agents = agentAccounts(cloud.sources, local, offset, now)
    .map(account => agentItem(account, usage[account.accountId], artwork, reportNow, wall));
  const byTitle = (a, b) => a.title.localeCompare(b.title) || a.subtitle.localeCompare(b.subtitle) || (a.id < b.id ? -1 : 1);
  return {
    version: WIDGET_FEED_VERSION,
    generatedAt: new Date(now).toISOString(),
    running,
    items: [...resources.sort(byTitle), ...agents.sort(byTitle)]
  };
}

function resourceItem(source, selected, now, wall) {
  const receivedAt = Date.parse(source.receivedAt);
  const symbol = source.kind === 'cluster' ? 'cluster' : source.memoryType === 'unified' ? 'unified' : source.kind;
  return {
    id: `resource:${source.sourceId}`,
    kind: 'resource',
    title: source.displayName,
    subtitle: resourceType(source),
    symbol,
    observedAt: wall(receivedAt),
    ...(source.statusMessage ? { message: source.statusMessage } : {}),
    metrics: source.displayMetrics
      .filter(metric => selected.has(metric.selectionKey))
      .slice(0, METRIC_LIMIT)
      .map(metric => metricEntry(metric, source.metrics[metric.key])),
    timeline: timeline([receivedAt + constants.CLOUD_STALE_MS], now, wall, time => status(sourceState(source, time))),
    link: LINKS.resource
  };
}

/** Cloud and local projects grouped by account. Local delivery owns a shared source. */
function agentAccounts(sources, local, offset, now) {
  const localIds = new Set(local.map(project => project.status.sourceId).filter(Boolean));
  const cloud = sources.filter(source => source.kind === 'agent' && !localIds.has(source.sourceId));
  return groupAccounts([...cloud, ...local.map(project => localSource(project, offset, now))]);
}

/** A local project in the cloud source shape, timed on the report clock. */
function localSource({ id, since, status }, offset, now) {
  const observedAt = new Date(since + offset).toISOString();
  // `since` is when the state began. Hooks measure reset countdowns when they
  // build a report, so those count from the report's own observation time.
  const resets = Object.fromEntries(AGENT_METRICS.map(({ key }) => {
    const resetAt = usageResetAt(key, status, status.observedAt, now);
    return [key, resetAt === null ? null : resetAt + offset];
  }));
  return {
    sourceId: id, kind: 'agent', displayName: status.project, health: 'ok',
    observedAt, receivedAt: observedAt, account: status.account,
    agent: { state: status.state, character: status.character, project: status.project },
    metrics: { contextPercent: status.memory ?? null, usageSessionPercent: status.usage5h ?? null, usageWeekPercent: status.usageWeek ?? null },
    resets
  };
}

function agentItem(account, usage, artwork, now, wall) {
  const latest = account.latest;
  const metrics = AGENT_METRICS.map(({ key, label, usage: bucket }) => {
    if (typeof latest.metrics[key] === 'number') {
      const resetAt = latest.resets ? latest.resets[key] : usageResetAt(key, latest.agent, latest.observedAt, now);
      return metricEntry({ key, label, ...GAUGE }, latest.metrics[key], resetAt === null ? null : wall(resetAt));
    }
    // Hooks omit usage between statusline refreshes; this device's cache has it.
    const cached = usage?.[bucket];
    return metricEntry({ key, label, ...GAUGE }, cached?.pct, Number.isFinite(cached?.resetsAt) ? new Date(cached.resetsAt * 1000).toISOString() : null);
  });
  const changes = account.sources.flatMap(source => agentChanges(source.agent.state, Date.parse(source.observedAt)));
  return {
    id: `agent:${account.accountId}`,
    kind: 'agent',
    title: providerLabel(account.provider),
    subtitle: accountName(account.accountId),
    artwork: artwork(latest.agent.character),
    observedAt: wall(Date.parse(latest.observedAt)),
    metrics,
    timeline: timeline(changes, now, wall, time => status(accountActivity(account, time).state)),
    link: LINKS.agent
  };
}

/** Times at which an agent state reported at `observedAt` ages to its next state. */
function agentChanges(state, observedAt) {
  const times = [];
  let time = observedAt;
  for (let transition = agentTransition(state); transition; transition = agentTransition(transition.state)) {
    time += transition.after;
    times.push(time);
  }
  return times;
}

/** Display states from `now` until the horizon, without consecutive repeats. */
function timeline(changes, now, wall, evaluate) {
  const times = [...new Set(changes)].filter(time => time > now && time <= now + HORIZON_MS).sort((a, b) => a - b);
  const entries = [];
  for (const time of [now, ...times]) {
    const entry = evaluate(time);
    const previous = entries.at(-1);
    if (previous && Object.keys(entry).every(key => entry[key] === previous[key])) continue;
    entries.push({ at: wall(time), ...entry });
  }
  return entries;
}

const status = state => ({ state, label: stateLabel(state), tone: stateTone(state) });

/** `resetsAt` is the wall-clock ISO time at which a plan usage limit resets; the widget counts down to it. */
function metricEntry(metric, value, resetsAt = null) {
  const available = typeof value === 'number' && Number.isFinite(value);
  return {
    key: metric.key,
    label: metric.label,
    value: formatMeasurement(value, metric.unit, false, '—', false),
    unit: available ? measurementUnit(metric.unit) : '',
    fraction: available && metric.display === 'gauge' ? Math.max(0, Math.min(1, (value - metric.min) / (metric.max - metric.min))) : null,
    tone: metricTone(metric.key, value),
    ...(available && resetsAt ? { resetsAt } : {})
  };
}
