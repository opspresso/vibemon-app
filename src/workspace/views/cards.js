import { compareCards } from '../../shared/design/card-order.mjs';
import { accountName, describeReset, formatResetTime, measurementUnit, metricLabel, metricTone, resetMinutes, resourceType, stateTone } from '../../shared/design/presentation.mjs';
import { t, locale } from '../i18n.js';
import { accountConnectionChip } from './service-labels.js';
import {
  el,
  text,
  icon,
  button,
  keyed,
  empty,
  reading,
  measurement,
  ago,
  sprite,
  providerName,
  badge
} from '../dom.js';

export const accountCard = (account) => ({
  ...account.latest,
  sourceId: account.accountId,
  displayName: account.displayProject,
  isAccount: true,
  provider: account.provider,
  displayState: account.displayState,
  needsAttention: account.needsAttention,
  members: account.sources
});
export const sourceState = source => source.displayState;
export const sourceType = source => source.isAccount ? `${providerName(source.provider)} · ${accountName(source.sourceId)}` : resourceType(source, t);
/** A metric label in the App language; reported custom labels stay as they are. */
export const metricName = metric => metricLabel(metric.key, metric.label, t);
export const needsAttention = source => source.needsAttention;
/** A source that only carries a connected service's reading, without hook reports. */
export const isUsageSource = source => source.sourceId.startsWith('usage:');
/** An account that only a connected service reports: no project activity yet. */
export const isConnectedOnly = source => Boolean(source.isAccount && source.members?.length && source.members.every(isUsageSource));
// A connected service reads plan usage only. A connected-only account never
// shows context, whatever the validated metrics contain.
const PLAN_USAGE_METRICS = new Set(['usageSessionPercent', 'usageWeekPercent']);
/** Whether `metric` belongs on `source`: a connected-only account shows plan usage only. */
export const showsMetric = (source, metric) => !isConnectedOnly(source) || PLAN_USAGE_METRICS.has(metric.key);
/** Apply an account's connected-service chip (account details); hidden without a connection. */
export function connectionChip(node, source) {
  const connection = source.isAccount ? source.account?.connection : null;
  node.hidden = !connection;
  if (!connection) return;
  const { label, tone } = accountConnectionChip(source.provider, connection);
  node.className = `chip ${tone} connection-chip`;
  if (node._label) text(node._label, label);
  else {
    node._label = el('span', label);
    node.replaceChildren(icon('link'), node._label);
  }
}

/**
 * Fills a card subtitle: "Claude Code · studio" for an account,
 * the resource type otherwise. An account whose usage a connected service
 * reads gets a link icon after the provider name. The icon is a button that
 * calls `openServices`. Its tooltip names the service and plan, such as
 * "Usage from Claude Max", with the state appended when the connection needs
 * attention; its tone follows that state.
 */
export function subtitle(node, source, openServices) {
  if (!node._subtitle) {
    const provider = el('span');
    const link = button('', event => {
      // The icon opens Connected services, never the card or its details.
      event.stopPropagation();
      node._openServices?.();
    }, 'connection-link');
    link.append(icon('link'));
    const account = el('span');
    node.replaceChildren(provider, link, account);
    node._subtitle = { provider, link, account };
  }
  node._openServices = openServices;
  const { provider, link, account } = node._subtitle;
  text(provider, source.isAccount ? providerName(source.provider) : sourceType(source));
  text(account, source.isAccount ? ` · ${accountName(source.sourceId)}` : '');
  const connection = source.isAccount ? source.account?.connection : null;
  link.hidden = !connection || !openServices;
  if (link.hidden) return;
  const { label, tone } = accountConnectionChip(source.provider, connection);
  link.dataset.tone = tone;
  link.title = label;
  link.setAttribute('aria-label', `${label} · ${t('services.manage')}`);
}

export function createMetric() {
  const node = el('div', undefined, 'metric');
  const label = el('div', undefined, 'metric-line');
  const name = el('span', undefined, 'metric-label');
  const value = el('strong');
  const amount = el('span');
  const unit = el('span', undefined, 'metric-unit');
  value.append(amount, unit);
  label.append(name, value);
  const bar = el('div', undefined, 'metric-bar');
  const fill = el('span');
  bar.append(fill);
  // Compact cards show the reset time only as a tooltip (see style.css).
  const reset = el('p', undefined, 'metric-reset');
  const resetPrefix = el('span');
  const resetTime = el('span');
  const resetSuffix = el('span');
  reset.append(icon('refresh'), resetPrefix, resetTime, resetSuffix);
  node.append(label, bar, reset);
  node._parts = { name, value, amount, unit, bar, fill, reset, resetPrefix, resetTime, resetSuffix };
  return node;
}
/** `metric.resetAt` is the time at which a plan usage limit resets, on the same clock as `now`. */
export function updateMetric(node, { metric, value, label, precise = false, now = Date.now() }) {
  const { name, value: output, amount, unit, bar, fill, reset, resetPrefix, resetTime, resetSuffix } = node._parts;
  text(name, label || metricName(metric));
  // Compact cards truncate a long label to one line; the tooltip keeps it readable.
  name.title = name.textContent;
  measurement(amount, value, metric.unit, precise, false);
  text(unit, typeof value === 'number' && Number.isFinite(value) ? measurementUnit(metric.unit) : '');
  output.title = reading(value, metric.unit, true);
  const available = typeof value === 'number' && Number.isFinite(value);
  bar.hidden = !available || metric.display !== 'gauge';
  if (!bar.hidden) {
    const percent = Math.max(0, Math.min(100, ((value - metric.min) / (metric.max - metric.min)) * 100));
    fill.style.width = `${percent}%`;
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', label || metricName(metric));
    bar.setAttribute('aria-valuemin', metric.min);
    bar.setAttribute('aria-valuemax', metric.max);
    bar.setAttribute('aria-valuenow', Math.max(metric.min, Math.min(metric.max, value)));
    bar.setAttribute('aria-valuetext', reading(value, metric.unit, precise));
    bar.dataset.tone = metricTone(metric.key, value);
  }
  const minutes = available ? resetMinutes(metric.resetAt, now) : null;
  const countdown = formatResetTime(minutes, t);
  reset.hidden = countdown === null;
  if (countdown === null) node.removeAttribute('title');
  else {
    // The countdown keeps its own element wherever the language places it.
    const sentence = describeReset(minutes, t);
    const at = sentence.indexOf(countdown);
    const parts = at < 0 ? [sentence, '', ''] : [sentence.slice(0, at), countdown, sentence.slice(at + countdown.length)];
    for (const [part, value] of [[resetPrefix, parts[0]], [resetTime, parts[1]], [resetSuffix, parts[2]]]) {
      text(part, value);
      part.hidden = !value.trim();
    }
    node.title = `${sentence} · ${new Date(Date.now() + metric.resetAt - now).toLocaleString(locale)}`;
  }
}

export function renderCards(
  container,
  sources,
  selectedMetrics,
  openDetail,
  navigate,
  {
    limit,
    compact = false,
    emptyTitle = t('empty.default.title'),
    emptyDescription = t('empty.default.description'),
    emptyAction = t('action.customize'),
    openServices
  } = {},
  now = Date.now()
) {
  const ordered = [...sources].sort(compareCards);
  const shown = limit ? ordered.slice(0, limit) : ordered;
  if (!shown.length) {
    container._emptyAction = navigate;
    if (!container._empty) {
      container.replaceChildren(
        empty(emptyTitle, emptyDescription, () => container._emptyAction?.(), emptyAction)
      );
      container._items = new Map();
      container._empty = true;
    } else {
      text(container.querySelector('h3'), emptyTitle);
      text(container.querySelector('p'), emptyDescription);
    }
    const action = container.querySelector('button');
    action.hidden = !navigate || !emptyAction;
    text(action, emptyAction);
    return;
  }
  if (container._empty) {
    container.replaceChildren();
    container._empty = false;
  }
  keyed(
    container,
    shown,
    (source) => `${source.isAccount ? 'account' : 'resource'}:${source.sourceId}`,
    () => {
      const card = el('article', undefined, 'card');
      const edge = el('span', undefined, 'vm-agent-edge');
      edge.setAttribute('aria-hidden', 'true');
      const heading = el('div', undefined, 'card-heading');
      const image = el('div', undefined, 'source-icon');
      const titles = el('div', undefined, 'card-title-group');
      const name = el('h3'),
        type = el('span', undefined, 'small muted');
      titles.append(name, type);
      const status = el('span', undefined, 'chip');
      heading.append(image, titles, status);
      const message = el('p', undefined, 'card-message');
      const metrics = el('div', undefined, 'metrics');
      const members = el('div', undefined, 'card-members');
      const footer = el('div', undefined, 'card-footer');
      const received = el('time');
      const details = button(t('cards.details'), () => openDetail(card._source), '');
      details.append(icon('arrow'));
      footer.append(received, details);
      card.append(edge, heading, message, metrics, members, footer);
      card._parts = { edge, name, type, image, status, message, metrics, members, received, details };
      return card;
    },
    (card, source) => {
      card._source = source;
      card.classList.toggle('compact-card', compact);
      card.classList.toggle('vm-agent-card', Boolean(source.isAccount));
      if (source.isAccount) {
        card.dataset.agentTone = stateTone(sourceState(source));
        card.dataset.agentState = sourceState(source);
      } else {
        delete card.dataset.agentTone;
        delete card.dataset.agentState;
      }
      card.setAttribute('aria-label', source.isAccount ? `${source.displayName} · ${sourceType(source)}` : source.displayName);
      const parts = card._parts;
      parts.edge.hidden = !source.isAccount;
      text(parts.name, source.displayName);
      subtitle(parts.type, source, openServices);
      parts.type.title = source.isAccount ? source.sourceId : '';
      const identity = source.isAccount ? source.agent?.character : source.kind;
      if (parts.image.dataset.identity !== identity) {
        if (source.isAccount) {
          const image = el('img');
          image.src = sprite(source.agent?.character);
          image.alt = '';
          parts.image.replaceChildren(image);
        } else
          parts.image.replaceChildren(
            icon(
              source.kind === 'cluster' ? 'resources' : source.memoryType === 'unified' ? 'gauge' : 'cloud'
            )
          );
        parts.image.dataset.identity = identity;
      }
      badge(parts.status, sourceState(source));
      const connectedOnly = isConnectedOnly(source);
      const message =
        source.statusMessage ||
        (source.isAccount
          ? connectedOnly ? t('services.connectedOnly') : t('cards.reporting', { count: source.members.length })
          : '');
      text(parts.message, message);
      parts.message.hidden = !message;
      parts.message.title = message;
      const visible = source.displayMetrics.filter((metric) => selectedMetrics.has(metric.selectionKey) && showsMetric(source, metric));
      const metrics = (compact ? visible.slice(0, 3) : visible).map((metric) => ({
        metric,
        value: source.metrics[metric.key],
        precise: !compact && metric.selectionKey.startsWith('resource:'),
        now
      }));
      keyed(parts.metrics, metrics, (entry) => entry.metric.key, createMetric, updateMetric);
      const projects = source.isAccount && !compact ? source.members.filter(member => !isUsageSource(member)).slice(0, 3) : [];
      keyed(
        parts.members,
        projects,
        (member) => member.sourceId,
        () => el('span', undefined, 'project-tag'),
        (node, member) => text(node, member.agent.project)
      );
      parts.members.hidden = !projects.length;
      text(parts.received, ago(source.receivedAt, now));
      parts.received.dateTime = source.receivedAt;
      parts.received.title = new Date(source.receivedAt).toLocaleString(locale);
      parts.details.setAttribute('aria-label', t('cards.viewDetails', { name: card.getAttribute('aria-label') }));
    }
  );
}

export function renderActivity(container, activity, compact = false) {
  const items = compact ? activity.slice(0, 3) : activity;
  if (!items.length) {
    if (!container._empty) {
      container.replaceChildren(
        empty(
          t('empty.activity.title'),
          t('empty.activity.description'),
          null,
          null,
          true
        )
      );
      container._items = new Map();
      container._empty = true;
    }
    return;
  }
  if (container._empty) {
    container.replaceChildren();
    container._empty = false;
  }
  keyed(
    container,
    items,
    (item) => item.id,
    () => {
      const row = el('div', undefined, 'activity-row');
      const avatar = el('div', undefined, 'activity-avatar');
      const image = el('img');
      image.alt = '';
      avatar.append(image);
      const content = el('div', undefined, 'activity-content');
      const title = el('strong'),
        subtitle = el('span', undefined, 'small muted');
      content.append(title, subtitle);
      const status = el('span', undefined, 'chip');
      row.append(avatar, content, status);
      row._parts = { image, title, subtitle, status };
      return row;
    },
    (row, item) => {
      const { image, title, subtitle, status } = row._parts;
      const path = sprite(item.character);
      if (image.getAttribute('src') !== path) image.src = path;
      text(title, item.project || item.id);
      text(
        subtitle,
        [item.account ? `${providerName(item.account.provider)} · ${item.account.displayName}` : null, item.model, item.tool, item.focused ? t('activity.following') : null].filter(Boolean).join(' · ') ||
          t('activity.local')
      );
      badge(status, item.state || 'idle');
    }
  );
}

export function renderUsage(container, usage) {
  const providers = Object.entries(usage || {}).filter(([, buckets]) => ['session', 'week', 'modelWeek'].some(key => buckets[key]));
  if (!providers.length) {
    if (!container._empty) {
      container.replaceChildren(
        empty(
          t('empty.usage.title'),
          t('empty.usage.description'),
          null,
          null,
          true
        )
      );
      container._items = new Map();
      container._empty = true;
    }
    return;
  }
  if (container._empty) {
    container.replaceChildren();
    container._empty = false;
  }
  keyed(
    container,
    providers,
    ([provider]) => provider,
    () => {
      const row = el('div', undefined, 'usage-provider');
      const title = el('h3'),
        values = el('div');
      row.append(title, values);
      row._parts = { title, values };
      return row;
    },
    (row, [provider, buckets]) => {
      text(row._parts.title, t('usage.thisDevice', { provider: buckets.account?.displayName || providerName(provider) }));
      const entries = ['session', 'week', 'modelWeek'].filter(key => buckets[key]).map(key => [key, buckets[key]]);
      keyed(
        row._parts.values,
        entries,
        ([key]) => key,
        () => {
          const item = createMetric();
          item.classList.add('usage-bucket');
          return item;
        },
        (item, [key, value]) => {
          updateMetric(item, {
            metric: {
              key: `usage-${key}`,
              label: key === 'session' ? t('metric.short.usageSessionPercent') : key === 'week' ? t('metric.short.usageWeekPercent') : value.label || t('usage.modelLimit'),
              unit: '%',
              display: 'gauge',
              min: 0,
              max: 100,
              // The usage cache records reset times in epoch seconds on this device's clock.
              resetAt: value.resetsAt === null ? null : value.resetsAt * 1000
            },
            value: value.pct
          });
        }
      );
    }
  );
}
