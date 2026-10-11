import { dominantState, measurementUnit, needsAttention as attentionState } from '../../shared/design/presentation.mjs';
import {
  el,
  text,
  icon,
  button,
  keyed,
  empty,
  reading,
  ago,
  sprite,
  providerName,
  badge,
  remaining
} from '../dom.js';

export const resourceType = (source) =>
  source.resourceType ||
  { host: 'Host', cluster: 'Kubernetes', resource: 'Resource' }[source.kind] ||
  'Resource';
export const accountCard = (account) => ({
  ...account.latest,
  sourceId: account.accountId,
  displayName: account.displayName,
  isAccount: true,
  provider: account.provider,
  members: account.sources
});
export function sourceState(source) {
  const states = (source.members || [source]).flatMap(member =>
    member.stale ? ['stale'] : [member.health, member.agent?.state]
  );
  return dominantState(states, source.agent?.state || source.health);
}
export const needsAttention = source => attentionState(sourceState(source));

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
  node.append(label, bar);
  node._parts = { name, value, amount, unit, bar, fill };
  return node;
}
export function updateMetric(node, { metric, value, label, precise = false }) {
  const { name, value: output, amount, unit, bar, fill } = node._parts;
  text(name, label || metric.label);
  text(amount, reading(value, '', precise));
  text(unit, typeof value === 'number' && Number.isFinite(value) ? measurementUnit(metric.unit) : '');
  output.title = reading(value, metric.unit, true);
  const available = typeof value === 'number' && Number.isFinite(value);
  bar.hidden = !available || metric.display !== 'gauge';
  if (!bar.hidden) {
    const percent = Math.max(0, Math.min(100, ((value - metric.min) / (metric.max - metric.min)) * 100));
    fill.style.width = `${percent}%`;
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', label || metric.label);
    bar.setAttribute('aria-valuemin', metric.min);
    bar.setAttribute('aria-valuemax', metric.max);
    bar.setAttribute('aria-valuenow', Math.max(metric.min, Math.min(metric.max, value)));
    bar.setAttribute('aria-valuetext', reading(value, metric.unit, precise));
    bar.dataset.tone =
      metric.key.startsWith('usage') && value >= 90
        ? 'danger'
        : metric.key.startsWith('usage') && value >= 70
          ? 'warning'
          : 'normal';
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
    emptyTitle = 'Nothing to show yet',
    emptyDescription = 'Choose sources from your workspace to see their latest readings.',
    emptyAction = 'Customize view'
  } = {}
) {
  const ordered = [...sources].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.displayName.localeCompare(b.displayName));
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
      const details = button('Details', () => openDetail(card._source), '');
      details.append(icon('arrow'));
      footer.append(received, details);
      card.append(heading, message, metrics, members, footer);
      card._parts = { name, type, image, status, message, metrics, members, received, details };
      return card;
    },
    (card, source) => {
      card._source = source;
      card.classList.toggle('compact-card', compact);
      card.setAttribute('aria-label', source.displayName);
      const parts = card._parts;
      text(parts.name, source.displayName);
      text(parts.type, source.isAccount ? `${providerName(source.provider)} · ${source.sourceId.slice(source.provider.length + 1)}` : resourceType(source));
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
      const message =
        source.statusMessage ||
        (source.isAccount
          ? `${source.members.length} reporting ${source.members.length === 1 ? 'project' : 'projects'}`
          : '');
      text(parts.message, message);
      parts.message.hidden = !message;
      parts.message.title = message;
      const visible = source.displayMetrics.filter((metric) => selectedMetrics.has(metric.selectionKey));
      const metrics = (compact ? visible.slice(0, 3) : visible).map((metric) => ({
        metric,
        value: source.metrics[metric.key],
        precise: !compact && metric.selectionKey.startsWith('resource:')
      }));
      keyed(parts.metrics, metrics, (entry) => entry.metric.key, createMetric, updateMetric);
      const projects = source.isAccount && !compact ? source.members.slice(0, 3) : [];
      keyed(
        parts.members,
        projects,
        (member) => member.sourceId,
        () => el('span', undefined, 'project-tag'),
        (node, member) => text(node, member.agent.project)
      );
      parts.members.hidden = !projects.length;
      text(parts.received, ago(source.receivedAt));
      parts.received.dateTime = source.receivedAt;
      parts.received.title = new Date(source.receivedAt).toLocaleString();
      parts.details.setAttribute('aria-label', `View ${source.displayName} details`);
    }
  );
}

export function renderActivity(container, activity, compact = false) {
  const items = compact ? activity.slice(0, 3) : activity;
  if (!items.length) {
    if (!container._empty) {
      container.replaceChildren(
        empty(
          'Ready when you are',
          'Local coding activity appears here when an integration reports a project.',
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
        [item.model, item.tool, item.focused ? 'Following on desktop' : null].filter(Boolean).join(' · ') ||
          'Local project'
      );
      badge(status, item.state || 'idle');
    }
  );
}

export function renderUsage(container, usage) {
  const providers = Object.entries(usage || {}).filter(([, buckets]) => Object.values(buckets).some(Boolean));
  if (!providers.length) {
    if (!container._empty) {
      container.replaceChildren(
        empty(
          'No usage reported',
          'Available plan limits appear after your local tools refresh their usage.',
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
      text(row._parts.title, `${providerName(provider)} · this device`);
      const entries = Object.entries(buckets).filter(([, value]) => value);
      keyed(
        row._parts.values,
        entries,
        ([key]) => key,
        () => {
          const item = el('div', undefined, 'usage-bucket');
          item._metric = createMetric();
          item._reset = el('p', undefined, 'usage-reset');
          item.append(item._metric, item._reset);
          return item;
        },
        (item, [key, value]) => {
          updateMetric(item._metric, {
            metric: {
              key: `usage-${key}`,
              label: key === 'session' ? 'Session' : key === 'week' ? 'Weekly' : value.label || 'Model limit',
              unit: '%',
              display: 'gauge',
              min: 0,
              max: 100
            },
            value: value.pct
          });
          text(
            item._reset,
            value.resetsAt ? `Resets in ${remaining(value.resetsAt)}` : 'Reset time not reported'
          );
        }
      );
    }
  );
}
