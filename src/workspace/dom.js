import { formatMeasurement, formatMeasurementParts, measurementUnit, observationAge, providerLabel, stateLabel as sharedStateLabel, stateTone } from '../shared/design/presentation.mjs';
import { t } from './i18n.js';
export { formatMeasurement as reading, providerLabel as providerName, stateTone };
export const ago = (timestamp, now) => observationAge(timestamp, now, t);
export const stateLabel = state => sharedStateLabel(state, t);

const paths = {
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  resources: ['M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M16 6.5h1M16 17.5h1'],
  agents: ['M8 4h8l1 3h3v12H4V7h3zM9 12h.01M15 12h.01M9 16h6M12 1v3'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  attention: ['m12 3 10 18H2zM12 9v5M12 17h.01'],
  settings: ['M4 7h16M4 17h16M8 4v6M16 14v6'],
  companion: ['M6 5h12l3 4v10H3V9zM8 11h.01M16 11h.01M9 15q3 3 6 0'],
  cloud: ['M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11z'],
  external: ['M14 3h7v7M21 3l-10 10M10 3H3v18h18v-7'],
  arrow: ['M4 12h16m-6-6 6 6-6 6'],
  chevron: ['m9 5 7 7-7 7'],
  refresh: ['M20 7a8 8 0 0 0-13-3L3 8m0-5v5h5M4 17a8 8 0 0 0 13 3l4-4m0 5v-5h-5'],
  close: ['m6 6 12 12M18 6 6 18'],
  plus: ['M12 4v16M4 12h16'],
  search: ['M17 17l4 4', 'M19 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  gauge: ['M4 19a10 10 0 1 1 16 0M12 13l5-6M4 19h16'],
  plug: ['M8 2v5M16 2v5M5 7h14M7 7v5a5 5 0 0 0 10 0V7M12 17v5'],
  lock: ['M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4M12 14v3'],
  book: ['M12 5C8 2 3 3 3 3v17s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2zM12 5v17'],
  globe: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3q7 9 0 18-7-9 0-18'],
  code: ['m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18']
};
export const $ = (id) => document.getElementById(id);
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function text(node, value) {
  const next = String(value ?? '');
  if (node.textContent !== next) node.textContent = next;
}
/** Update semantic number segments without replacing the metric's DOM on each poll. */
export function measurement(node, value, unit = '', exact = false, includeUnit = true) {
  if (!node._numberParts) {
    const integer = document.createTextNode('');
    const fraction = el('span', undefined, 'vm-metric-fraction');
    const suffix = document.createTextNode('');
    node.replaceChildren(integer, fraction, suffix);
    node._numberParts = { integer, fraction, suffix };
  }
  const parts = formatMeasurementParts(value, unit, exact);
  const { integer, fraction, suffix } = node._numberParts;
  if (integer.data !== parts.integer) integer.data = parts.integer;
  text(fraction, parts.fraction);
  const next = includeUnit && typeof value === 'number' && Number.isFinite(value) ? measurementUnit(unit) : '';
  if (suffix.data !== next) suffix.data = next;
}
export function svg(tag, attributes = {}, value) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, item] of Object.entries(attributes)) node.setAttribute(key, String(item));
  if (value !== undefined) node.textContent = value;
  return node;
}
export function icon(name) {
  const node = svg('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' });
  for (const d of paths[name] || paths.resources) node.append(svg('path', { d }));
  return node;
}
export function hydrateIcons(root = document) {
  for (const placeholder of root.querySelectorAll('[data-icon]')) {
    placeholder.replaceChildren(icon(placeholder.dataset.icon));
    placeholder.removeAttribute('data-icon');
  }
}
export function button(label, action, className = 'button secondary', symbol) {
  const node = el('button', undefined, className);
  node.type = 'button';
  if (symbol) node.append(icon(symbol));
  node.append(document.createTextNode(label));
  node.addEventListener('click', action);
  return node;
}
export function keyed(parent, items, keyOf, create, update) {
  const cache = parent._items || (parent._items = new Map());
  const active = new Set();
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    active.add(key);
    let node = cache.get(key);
    if (!node) {
      node = create(item);
      cache.set(key, node);
    }
    update(node, item);
    if (node !== cursor) {
      if (node.parentNode === parent && parent.isConnected) parent.moveBefore(node, cursor);
      else parent.insertBefore(node, cursor);
    }
    cursor = node.nextElementSibling;
  }
  for (const [key, node] of cache)
    if (!active.has(key)) {
      node.remove();
      cache.delete(key);
    }
}
export function empty(title, description, action, label, compact = false) {
  const node = el('div', undefined, `empty${compact ? ' compact' : ''}`);
  node.append(icon('resources'), el('h3', title), el('p', description));
  if (action) node.append(button(label, action, 'text-button', 'arrow'));
  return node;
}
export function choices(select, entries, selected) {
  const choice = document.activeElement === select || select.dataset.busy ? select.value : String(selected);
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) {
    select.replaceChildren(
      ...entries.map(([value, label]) => {
        const option = el('option', label);
        option.value = value;
        return option;
      })
    );
    select.dataset.options = signature;
  }
  // Keep active edits when options refresh; removed options use the caller's default.
  const next = entries.some(([value]) => String(value) === choice) ? choice : String(selected);
  if (select.value !== next) select.value = next;
}
let characterImages = new Map([['vibemon', 'vibemon-v2.png']]);
export function configureSprites(characters) {
  characterImages = new Map(
    characters
      .filter((item) => typeof item.image === 'string' && /^[a-z0-9_.-]+\.png$/i.test(item.image))
      .map((item) => [item.name, item.image])
  );
}
export function sprite(character) {
  return `../assets/characters/${characterImages.get(character) || characterImages.get('vibemon') || 'vibemon-v2.png'}`;
}
export function badge(node, state) {
  node.className = `chip ${stateTone(state)}`;
  text(node, stateLabel(state));
}
// Connection status → [message key, tone]; the key names connection.<key>.label and .description.
const CONNECTION = {
  connected: ['connected', 'good'],
  connecting: ['connecting', 'neutral'],
  'not-configured': ['notConfigured', 'neutral'],
  'token-expired': ['tokenExpired', 'danger'],
  'permission-denied': ['permissionDenied', 'danger'],
  'credential-unavailable': ['credentialUnavailable', 'warning'],
  'secure-storage-unavailable': ['secureStorageUnavailable', 'warning'],
  'connection-error': ['connectionError', 'warning']
};
export const isConnectionStatus = status => Object.hasOwn(CONNECTION, status);
/** @returns {[label: string, description: string, tone: string]} */
export function connection(status) {
  const [key, tone] = CONNECTION[status] || ['problem', 'warning'];
  return [t(`connection.${key}.label`), t(`connection.${key}.description`), tone];
}
