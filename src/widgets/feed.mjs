// The presentation model for the macOS widgets (native/macos).
//
// Pure: the App decides every state, label, tone, and number format here, and
// the widget only lays the result out. One item is one resource or one coding
// agent account. Each item carries a timeline of its future display states,
// so a widget keeps aging correctly between App writes. The last feed before
// the App quits shows every item on standby: nothing updates it any more.
import { accountName, formatMeasurementParts, measurementUnit, metricLabel, metricTone, providerLabel, resourceIcon, resourceType, sharedTranslator, stateLabel, stateTone } from '../shared/design/presentation.mjs';
import { compareCards } from '../shared/design/card-order.mjs';
import monitoring from '../shared/monitoring/state.cjs';
import clock from '../shared/monitoring/clock.cjs';
import constants from '../shared/constants.cjs';

const { accountActivity, agentTransition, groupAccounts, needsAttention, sourceState } = monitoring;
const { usageResetAt } = clock;

export const WIDGET_FEED_VERSION = 2;
// A small widget shows three metric rows.
const METRIC_LIMIT = 3;
// Every agent state chain ends within this window; resources go on standby sooner.
const HORIZON_MS = 60 * 60 * 1000;
// `label` is a shared message key; agent rows use the short usage labels.
const AGENT_METRICS = [
  { key: 'contextPercent', label: 'metric.contextPercent' },
  { key: 'usageSessionPercent', label: 'metric.short.usageSessionPercent', usage: 'session' },
  { key: 'usageWeekPercent', label: 'metric.short.usageWeekPercent', usage: 'week' }
];
const GAUGE = { unit: '%', display: 'gauge', min: 0, max: 100 };
const LINKS = { resource: 'vibemon://dashboard/resources', agent: 'vibemon://dashboard/agents' };

/**
 * @param {object} input
 * @param {object} input.cloud MonitoringClient.snapshot(); `evaluatedAt` is its report clock.
 * @param {Array<{id: string, since: number, status: object}>} [input.local] Local projects with an account.
 *   `since` is the wall-clock time at which `status.state` began.
 * @param {Object<string, {session?: {pct: number, resetsAt: number|null, updatedAt: number}, week?: {pct: number, resetsAt: number|null, updatedAt: number}}>} [input.usage]
 *   Plan usage on this device by account key (`provider:id`). Times are in epoch seconds.
 * @param {(character: string) => string|undefined} [input.artwork] Character image file name.
 * @param {number} input.now Wall-clock time in milliseconds.
 * @param {boolean} [input.running] False for the last feed before the App quits.
 * @param {string} [input.locale] The App language ('en', 'ko', or 'ja') of every label.
 */
export function buildWidgetFeed({ cloud, local = [], usage = {}, artwork = () => undefined, now, running = true, locale = 'en' }) {
  const t = sharedTranslator(locale);
  // Cloud times follow the server clock. Widgets compare times with the wall
  // clock, so every time is moved by the current difference between the two.
  const reportNow = cloud.evaluatedAt;
  const offset = reportNow - now;
  const wall = time => new Date(time - offset).toISOString();
  const selected = new Set(cloud.selectedMetrics);
  const resources = cloud.sources
    .filter(source => source.kind !== 'agent')
    .map(source => card(source, time => sourceState(source, time), reportNow, {
      sourceId: source.sourceId, displayName: source.displayName, receivedAt: source.receivedAt
    }));
  // The server resolves plan usage across every project and connected service
  // of an account. Keep that result, including missing values, before local
  // delivery replaces project activity and context.
  const cloudAccounts = new Map(groupAccounts(cloud.sources).map(account => [account.accountId, account.latest]));
  const agents = agentAccounts(cloud.sources, local, offset, now)
    .map(account => card(account, time => accountActivity(account, time).state, reportNow, {
      sourceId: account.accountId, isAccount: true, displayName: accountActivity(account, reportNow).project, observedAt: account.latest.observedAt
    }));
  // The order follows the reported states, so a widget without a choice keeps
  // its item after the App quits. Only the display changes: nothing updates
  // the widgets any more, so every item stays on standby.
  const shown = entry => running ? entry.stateAt : () => 'standby';
  const items = [...resources, ...agents].sort(compareCards).map(entry => entry.isAccount
    ? agentItem(entry.subject, shown(entry), cloudAccounts.get(entry.subject.accountId), usage[entry.subject.accountId], artwork, reportNow, wall, offset, t, running)
    : resourceItem(entry.subject, shown(entry), selected, reportNow, wall, t));
  return {
    version: WIDGET_FEED_VERSION,
    generatedAt: new Date(now).toISOString(),
    items
  };
}

/** The card-order fields of a resource or account, with its reported state at a report-clock time. */
function card(subject, stateAt, now, fields) {
  const displayState = stateAt(now);
  return { subject, stateAt, ...fields, displayState, needsAttention: needsAttention(displayState) };
}

function resourceItem(source, stateAt, selected, now, wall, t) {
  const receivedAt = Date.parse(source.receivedAt);
  const symbol = resourceIcon(source);
  return {
    id: `resource:${source.sourceId}`,
    kind: 'resource',
    title: source.displayName,
    subtitle: resourceType(source, t),
    symbol,
    observedAt: wall(receivedAt),
    ...(source.statusMessage ? { message: source.statusMessage } : {}),
    metrics: source.displayMetrics
      .filter(metric => selected.has(metric.selectionKey))
      .slice(0, METRIC_LIMIT)
      .map(metric => metricEntry({ ...metric, label: metricLabel(metric.key, metric.label, t) }, source.metrics[metric.key])),
    timeline: timeline([receivedAt + constants.CLOUD_STALE_MS], now, wall, time => status(stateAt(time), t)),
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
    // A heartbeat's report time is activity, not a new usage measurement.
    usageMeasuredAt: Date.parse(status.usageObservedAt ?? (status.heartbeat ? undefined : status.observedAt)) + offset,
    resets
  };
}

function agentItem(account, stateAt, cloudUsage, usage, artwork, now, wall, offset, t, running) {
  const latest = account.latest;
  const project = accountActivity(account, now).project;
  // A connected service (`usage:` sources) reads plan usage only: an account
  // that only it reports has no context, as on every other client.
  const connectedOnly = account.sources.every(source => source.sourceId.startsWith('usage:'));
  const metrics = AGENT_METRICS.filter(metric => !connectedOnly || metric.usage).map(({ key, label: message, usage: bucket }) => {
    const label = t(message);
    if (!bucket) return metricEntry({ key, label, ...GAUGE }, latest.metrics[key]);
    if (cloudUsage) {
      const resetAt = usageResetAt(key, cloudUsage.agent, cloudUsage.observedAt, now);
      return metricEntry({ key, label, ...GAUGE }, cloudUsage.metrics[key], resetAt === null ? null : isoTime(resetAt - offset));
    }
    const reading = localUsage(account.sources, key, usage?.[bucket], now, offset);
    return metricEntry({ key, label, ...GAUGE }, reading?.value, reading?.resetsAt == null ? null : isoTime(reading.resetsAt - offset));
  });
  const changes = account.sources.flatMap(source => agentChanges(source.agent.state, Date.parse(source.observedAt)));
  return {
    id: `agent:${account.accountId}`,
    kind: 'agent',
    title: project,
    subtitle: `${providerLabel(account.provider)} · ${accountName(account.accountId)}`,
    selectionTitle: `${providerLabel(account.provider)} · ${accountName(account.accountId)}`,
    selectionSubtitle: [...new Set([account.displayName, ...account.sources.map(source => source.agent?.project || source.displayName)])].slice(0, 4).join(' · '),
    artwork: artwork(latest.agent.character),
    observedAt: wall(Date.parse(latest.observedAt)),
    metrics,
    timeline: timeline(changes, now, wall, time => ({
      ...status(stateAt(time), t),
      project: running ? accountActivity(account, time).project : project
    })),
    link: LINKS.agent
  };
}

/** Local-only accounts use the newest unexpired measurement of each window. */
function localUsage(sources, key, cached, now, offset) {
  const candidates = sources.map(source => ({ value: source.metrics[key], measuredAt: source.usageMeasuredAt, resetsAt: source.resets[key] }));
  if (cached) candidates.push({
    value: cached.pct,
    measuredAt: cached.updatedAt * 1000 + offset,
    resetsAt: typeof cached.resetsAt === 'number' ? cached.resetsAt * 1000 + offset : null
  });
  let chosen;
  for (const reading of candidates) {
    if (!Number.isFinite(reading.value) || !Number.isFinite(reading.measuredAt)
      || reading.measuredAt > now + constants.OBSERVATION_CLOCK_SKEW_MS
      || now - reading.measuredAt > constants.USAGE_CACHE_STALE_SECONDS * 1000
      || (reading.resetsAt !== null && reading.resetsAt <= now)) continue;
    if (!chosen || reading.measuredAt > chosen.measuredAt) chosen = reading;
  }
  return chosen;
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

const status = (state, t) => ({ state, label: stateLabel(state, t), tone: stateTone(state) });
// An ISO time, or null when `time` is not a finite number of milliseconds that a Date can represent.
// `new Date(null)` is the epoch, so null must not reach the Date constructor.
const isoTime = time => typeof time === 'number' && !Number.isNaN(new Date(time).getTime()) ? new Date(time).toISOString() : null;

/** `resetsAt` is the wall-clock ISO time at which a plan usage limit resets; the widget counts down to it. */
function metricEntry(metric, value, resetsAt = null) {
  const available = typeof value === 'number' && Number.isFinite(value);
  const valueParts = formatMeasurementParts(value, metric.unit);
  return {
    key: metric.key,
    label: metric.label,
    value: valueParts.integer + valueParts.fraction,
    valueParts,
    unit: available ? measurementUnit(metric.unit) : '',
    fraction: available && metric.display === 'gauge' ? Math.max(0, Math.min(1, (value - metric.min) / (metric.max - metric.min))) : null,
    tone: metricTone(metric.key, value),
    ...(available && resetsAt ? { resetsAt } : {})
  };
}
