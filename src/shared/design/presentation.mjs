// Pure display rules shared by the Desktop renderer and the private Web client.
// Functions that return text take an optional translator `t` (see
// ../i18n/translate.mjs); without one they return English.
import states, { measurementTones, unitFractionDigits } from './monitoring-labels.mjs';
import messages from '../i18n/shared-messages.mjs';
import { createTranslator } from '../i18n/translate.mjs';

const english = createTranslator('en', messages);
/** A translator for the shared display messages in `locale`. */
export const sharedTranslator = locale => createTranslator(locale, messages);
export const codingProviders = Object.freeze([
  { id: 'codex', name: 'Codex', character: 'codex' },
  { id: 'claude', name: 'Claude Code', character: 'clawd' },
  { id: 'kiro', name: 'Kiro', character: 'kiro' },
  { id: 'openclaw', name: 'OpenClaw', character: 'claw' },
  { id: 'opencode', name: 'OpenCode', character: 'vibemon' }
].map(Object.freeze));
export const providerLabel = provider => codingProviders.find(item => item.id === provider)?.name ?? provider;
// Compact labels never change the full identity used for selection or API calls.
export function accountName(accountKey) {
  const id = accountKey.slice(accountKey.indexOf(':') + 1);
  const generated = /^(?:auto|profile|credential):([a-f0-9]{64})$/.exec(id);
  if (generated) return generated[1].slice(0, 8);
  return id.length > 24 ? `${id.slice(0, 15)}…${id.slice(-6)}` : id;
}
export const statePresentation = (state, t = english) => Object.hasOwn(states, state)
  ? [t(`state.${state}`), states[state][1]] : [state, 'neutral'];
export const stateLabel = (state, t = english) => statePresentation(state, t)[0];
export const stateTone = state => statePresentation(state)[1];
// A reported resource type is the owner's own text and stays as reported.
export const resourceType = (source, t = english) => source.resourceType || t({ host: 'resource.host', cluster: 'resource.cluster' }[source.kind] ?? 'resource.other');
/**
 * The label of a metric. Built-in metrics keep their reported English label
 * on the wire; the label is translated only when it is that built-in text.
 */
export function metricLabel(key, label, t = english) {
  if (label === english(`metric.${key}`)) return t(`metric.${key}`);
  if (label === english('metric.unifiedMemory')) return t('metric.unifiedMemory');
  return label;
}
// Thresholds come from monitoring.json `measurements.tones`: plan usage warns
// before a limit, and other measurements have no thresholds. Bounds are inclusive.
export function metricTone(key, value) {
  const rule = measurementTones.find(({ keyPrefix }) => key.startsWith(keyPrefix));
  if (!rule || !(value >= rule.warningFrom)) return 'normal';
  return value >= rule.dangerFrom ? 'danger' : 'warning';
}

const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const unitFormats = new Map(Object.entries(unitFractionDigits).map(([unit, maximumFractionDigits]) => [unit, new Intl.NumberFormat(undefined, { maximumFractionDigits })]));
const small = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });
const precise = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 });
export const measurementUnit = unit => `${!unit || /^[%°]/.test(unit) ? '' : ' '}${unit}`;
export function formatMeasurement(value, unit = '', exact = false, unavailable = '—', includeUnit = true) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return unavailable;
  const formatter = unitFormats.get(unit) ?? (exact ? precise : value !== 0 && Math.abs(value) < 1 ? small : decimal);
  return `${formatter.format(value)}${includeUnit ? measurementUnit(unit) : ''}`;
}
export function observationAge(timestamp, now = Date.now(), t = english) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return t('age.notReported');
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 15) return t('age.justNow');
  if (seconds < 60) return t('age.seconds', { count: seconds });
  if (seconds < 3600) return t('age.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('age.hours', { count: Math.floor(seconds / 3600) });
  return t('age.days', { count: Math.floor(seconds / 86400) });
}

// Time left until a plan usage limit resets, in whole minutes. English:
// "now", "24m", "2h", "2h5m", "3d", or "3d4h". Zero means the window has
// already reset.
export function formatResetTime(minutes, t = english) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return null;
  if (minutes === 0) return t('duration.now');
  if (minutes < 60) return t('duration.minutes', { minutes });
  if (minutes < 1440) {
    const [hours, rest] = [Math.floor(minutes / 60), minutes % 60];
    return rest ? t('duration.hoursMinutes', { hours, minutes: rest }) : t('duration.hours', { hours });
  }
  const [days, hours] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60)];
  return hours ? t('duration.daysHours', { days, hours }) : t('duration.days', { days });
}
// Whole minutes until a reset time in milliseconds (see usageResetAt), or
// null when the reset time is not reported.
export function resetMinutes(resetAt, now = Date.now()) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.ceil((resetAt - now) / 60000));
}
// The countdown text for a reset time in milliseconds, or null.
export const resetCountdown = (resetAt, now = Date.now(), t = english) => formatResetTime(resetMinutes(resetAt, now), t);
// The countdown in `minutes` (see resetMinutes) as a sentence for labels and
// assistive technology.
export function describeReset(minutes, t = english) {
  const countdown = formatResetTime(minutes, t);
  return countdown === null ? null : minutes === 0 ? t('reset.now') : t('reset.in', { time: countdown });
}

export function formatAxisValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  return absolute !== 0 && (absolute >= 1000000 || absolute < 0.001) ? value.toExponential(1) : formatMeasurement(value);
}
