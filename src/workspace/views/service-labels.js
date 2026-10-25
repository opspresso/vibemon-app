// How the workspace names a connected service and its state. Cards, details,
// and Settings → Connected services share these words and tones.
import { t, locale } from '../i18n.js';

// Product names; they are names, so they are not translated.
const SERVICE_NAMES = { claude: 'Claude', codex: 'Codex' };
// The App character of each service.
const SERVICE_CHARACTERS = { claude: 'clawd', codex: 'codex' };
export const SERVICES = Object.keys(SERVICE_NAMES);
export const serviceName = provider => SERVICE_NAMES[provider] ?? provider;
export const serviceCharacter = provider => SERVICE_CHARACTERS[provider] ?? 'vibemon';
export const connectionIdentity = connection => connection.label ? `${serviceName(connection.provider)} · ${connection.label}` : serviceName(connection.provider);
export const needsPerson = connection => connection.status !== 'ready' || connection.stale;

/** @returns {[label: string, tone: string]} the badge of a connection in Settings and Overview */
export function connectionBadge(connection) {
  if (connection.status === 'reconnect-required') return [t('services.status.reconnect'), 'danger'];
  if (connection.status === 'rate-limited') return [t('services.status.limited'), 'warning'];
  if (connection.status === 'unavailable') return [t('services.status.unavailable'), 'warning'];
  if (connection.stale) return [t('services.status.stale'), 'neutral'];
  return connection.observedAt ? [t('services.status.ready'), 'good'] : [t('services.status.waiting'), 'neutral'];
}

/** What happened to a connection that is not plainly up to date, or null. */
export function connectionMessage(connection) {
  const service = serviceName(connection.provider);
  switch (connection.status) {
    case 'rate-limited': {
      const time = connection.retryAt ? new Date(connection.retryAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : '—';
      return t('services.limitedHelp', { service, time });
    }
    case 'unavailable': return t(connection.observedAt ? 'services.unavailableHelp' : 'services.unavailableNoReading', { service });
    case 'reconnect-required': return t('services.reconnectHelp', { service });
    default:
      if (connection.stale) return t('services.staleHelp');
      return connection.observedAt && !connection.windows.length ? t('services.noWindows', { service }) : null;
  }
}

/**
 * The window a person looks for first: weekly usage, else a model-scoped
 * weekly limit, else the first window. A window after its reset is hidden
 * until the next reading; it never becomes 0 %.
 */
export function primaryWindow(connection, now) {
  const current = connection.windows.filter(window => !window.resetsAt || Date.parse(window.resetsAt) > now);
  return current.find(window => window.key === 'week') ?? current.find(window => window.kind === 'week') ?? current[0] ?? null;
}

/** A usage window as a built-in plan usage metric, with its shared label, gauge, tone, and reset time. */
export function windowMetric(window) {
  const key = window.kind === 'session' ? 'usageSessionPercent' : 'usageWeekPercent';
  const label = t(`metric.${key}`);
  return {
    key, label: window.model ? `${label} · ${window.model}` : label, unit: '%', display: 'gauge', min: 0, max: 100,
    resetAt: window.resetsAt ? Date.parse(window.resetsAt) : null
  };
}

/**
 * The chip of an agent account whose usage a connected service reads:
 * "Usage from Claude Max", with the state appended when it is not ready.
 * @returns {{ label: string, tone: string }}
 */
export function accountConnectionChip(provider, connection) {
  const label = t('services.cardChip', { name: [serviceName(provider), connection.plan].filter(Boolean).join(' ') });
  const state = {
    'rate-limited': ['services.status.limited', 'warning'],
    unavailable: ['services.status.unavailable', 'warning'],
    'reconnect-required': ['services.status.reconnect', 'danger']
  }[connection.status];
  return state ? { label: `${label} · ${t(state[0])}`, tone: state[1] } : { label, tone: 'active' };
}
