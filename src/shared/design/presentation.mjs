// Pure display rules shared by the Desktop renderer and the private Web client.
import states, { unitFractionDigits } from './monitoring-labels.mjs';
export const codingProviders = Object.freeze([
  { id: 'codex', name: 'Codex', character: 'codex' },
  { id: 'claude', name: 'Claude Code', character: 'clawd' },
  { id: 'kiro', name: 'Kiro', character: 'kiro' },
  { id: 'openclaw', name: 'OpenClaw', character: 'claw' },
  { id: 'opencode', name: 'OpenCode', character: 'vibemon' }
].map(Object.freeze));
export const providerLabel = provider => codingProviders.find(item => item.id === provider)?.name ?? provider;
// An account key is `provider:id`; people know the account by its ID.
export const accountName = accountKey => accountKey.slice(accountKey.indexOf(':') + 1);
export const statePresentation = state => Object.hasOwn(states, state) ? [...states[state]] : [state, 'neutral'];
export const stateLabel = state => statePresentation(state)[0];
export const stateTone = state => statePresentation(state)[1];
export const resourceType = source => source.resourceType || { host: 'Host', cluster: 'Kubernetes' }[source.kind] || 'Resource';
// Plan usage warns before a limit; other measurements have no thresholds.
export const metricTone = (key, value) => !key.startsWith('usage') || !(value >= 70) ? 'normal' : value >= 90 ? 'danger' : 'warning';

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
export function observationAge(timestamp, now = Date.now()) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return 'Not reported';
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 15) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Time left until a plan usage limit resets, in whole minutes: "now", "24m",
// "2h", "2h5m", "3d", or "3d4h". Zero means the window has already reset.
export function formatResetTime(minutes) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return null;
  if (minutes === 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const [large, small, unit, rest] = minutes < 1440
    ? [Math.floor(minutes / 60), minutes % 60, 'h', 'm']
    : [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), 'd', 'h'];
  return `${large}${unit}${small ? `${small}${rest}` : ''}`;
}
// The countdown text for a reset time in milliseconds (see usageResetAt), or
// null when the reset time is not reported.
export function resetCountdown(resetAt, now = Date.now()) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || !Number.isFinite(now)) return null;
  return formatResetTime(Math.max(0, Math.ceil((resetAt - now) / 60000)));
}

export function formatAxisValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  return absolute !== 0 && (absolute >= 1000000 || absolute < 0.001) ? value.toExponential(1) : formatMeasurement(value);
}
