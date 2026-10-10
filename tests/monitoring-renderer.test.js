const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate } = require('node:timers');
const { displayMetrics } = require('../src/monitoring/domain.cjs');
const { metricCatalog } = require('../src/shared/resource-schema.cjs');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; }
  append(...children) { this.children.push(...children); if (this.tag === 'select' && !this.value && children[0]) this.value = children[0].value; }
  replaceChildren(...children) { this.children = children; this.value = ''; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get options() { return this.children; }
  scrollIntoView() {}
}
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
test('shows credential recovery settings when the saved token is rejected', async () => {
  const snapshot = { url: 'https://web.example', tokenConfigured: true, status: 'token-expired', catalog: [], sources: [], accountCatalog: [], accounts: [], selectedSources: [], selectedAccounts: [], selectedMetrics: [], metrics: {} };
  const elements = new Map();
  const document = { hidden: false, activeElement: null, getElementById: id => {
    if (!elements.has(id)) { const element = new Element('div'); element.open = true; elements.set(id, element); }
    return elements.get(id);
  }, createElement: tag => new Element(tag), createTextNode: textContent => ({ textContent }), addEventListener() {} };
  let changed;
  const api = { onChange(callback) { changed = callback; }, snapshot: async () => ({ ok: true, value: snapshot }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/monitoring/renderer.js'), 'utf8'), { window: { monitoring: api, addEventListener() {} }, document, console, setInterval: jest.fn(), clearInterval: jest.fn(), Date });
  await new Promise(setImmediate);
  expect(elements.get('settings').open).toBe(true);
  elements.get('settings').open = false;
  changed({ ...snapshot, status: 'connected' });
  changed({ ...snapshot, status: 'permission-denied' });
  expect(elements.get('settings').open).toBe(true);
});
test('renders custom range, unit, message and negative trend without fixed CPU assumptions', async () => {
  const source = { sourceId: 'cold-room', kind: 'resource', resourceType: 'Refrigeration', displayName: 'Cold room', statusMessage: 'Cooling', health: 'ok', stale: false, receivedAt: new Date().toISOString(), metricDefinitions: { temperature: { label: 'Temperature', unit: '°C', display: 'gauge', min: -40, max: 20 } }, metrics: { temperature: -12 } };
  source.displayMetrics = displayMetrics(source);
  const catalog = metricCatalog([source]);
  const snapshot = { url: 'https://web.example', status: 'connected', catalog: [source], sources: [source], accountCatalog: [], accounts: [], selectedSources: null, selectedAccounts: null, selectedMetrics: Object.keys(catalog), metrics: catalog, trendRefreshMs: 60000 };
  const elements = new Map();
  const document = { hidden: false, activeElement: null, getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id === 'trend-metric' ? 'select' : 'div')); return elements.get(id); }, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), createTextNode: textContent => ({ textContent }), addEventListener() {} };
  const response = { points: [{ timestamp: new Date().toISOString(), average: { temperature: -12 } }], displayMetrics: source.displayMetrics };
  const api = { onChange() {}, snapshot: async () => ({ ok: true, value: snapshot }), trend: async () => ({ ok: true, value: response }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/monitoring/renderer.js'), 'utf8'), { window: { monitoring: api, addEventListener() {} }, document, console, setInterval: jest.fn(), clearInterval: jest.fn(), Date });
  await new Promise(setImmediate);
  const nodes = descendants(elements.get('cards'));
  const gauge = nodes.find(node => node.tag === 'progress');
  expect(gauge.max).toBe(60); expect(gauge.value).toBe(28);
  expect(gauge.attributes['aria-valuetext']).toBe('-12°C');
  expect(nodes.some(node => node.textContent === 'Refrigeration')).toBe(true);
  expect(nodes.some(node => node.textContent === 'Cooling')).toBe(true);
  nodes.find(node => node.tag === 'button').listeners.click();
  await new Promise(setImmediate);
  const chart = descendants(elements.get('chart'));
  expect(chart.some(node => node.textContent === '-40°C')).toBe(true);
  expect(chart.find(node => node.tag === 'circle').attributes.cy).toBeCloseTo(116);
  // Re-registering an ID can change meaning; history must use its own returned definition.
  response.displayMetrics = displayMetrics({ ...source, metricDefinitions: { temperature: { label: 'Voltage', unit: 'V', display: 'gauge', min: -20, max: 20 } } });
  nodes.find(node => node.tag === 'button').listeners.click();
  await new Promise(setImmediate);
  const changed = descendants(elements.get('chart'));
  expect(changed.some(node => node.textContent === '-20V')).toBe(true);
  expect(changed.some(node => node.textContent === '-40°C')).toBe(false);
  expect(changed.find(node => node.tag === 'circle').attributes.cy).toBeCloseTo(164);
});
