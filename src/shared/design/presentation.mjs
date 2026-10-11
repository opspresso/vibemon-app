// Pure display rules shared by the Desktop renderer and the private Web client.
const attention = ['error', 'alert', 'notification', 'warning', 'stale'];
const states = {
  ok: ['Healthy', 'good'], warning: ['Attention', 'warning'], error: ['Collection error', 'danger'],
  unknown: ['Unknown health', 'neutral'], stale: ['Stale', 'warning'],
  working: ['Working', 'active'], thinking: ['Thinking', 'active'], planning: ['Planning', 'active'],
  packing: ['Compacting', 'active'], notification: ['Needs input', 'warning'], alert: ['Needs attention', 'danger'],
  idle: ['Idle', 'neutral'], sleep: ['Resting', 'neutral'], done: ['Done', 'good'], start: ['Starting', 'active']
};
export const codingProviders = Object.freeze([
  { id: 'codex', name: 'Codex', character: 'codex' },
  { id: 'claude', name: 'Claude Code', character: 'clawd' },
  { id: 'kiro', name: 'Kiro', character: 'kiro' },
  { id: 'openclaw', name: 'OpenClaw', character: 'claw' },
  { id: 'opencode', name: 'OpenCode', character: 'vibemon' }
].map(Object.freeze));
export const providerLabel = provider => codingProviders.find(item => item.id === provider)?.name ?? provider;
export const needsAttention = state => attention.includes(state);
export const dominantState = (observations, fallback = 'unknown') => attention.find(state => observations.includes(state)) ?? fallback;
export const statePresentation = state => Object.hasOwn(states, state) ? [...states[state]] : [state, 'neutral'];
export const stateLabel = state => statePresentation(state)[0];
export const stateTone = state => statePresentation(state)[1];

const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const small = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });
const precise = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 });
export const measurementUnit = unit => `${!unit || /^[%°]/.test(unit) ? '' : ' '}${unit}`;
export function formatMeasurement(value, unit = '', exact = false, unavailable = '—') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return unavailable;
  const formatter = exact ? precise : value !== 0 && Math.abs(value) < 1 ? small : decimal;
  return `${formatter.format(value)}${measurementUnit(unit)}`;
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

export function formatAxisValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  return absolute !== 0 && (absolute >= 1000000 || absolute < 0.001) ? value.toExponential(1) : formatMeasurement(value);
}
