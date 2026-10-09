const api = window.monitoring;
const $ = id => document.getElementById(id);
const descriptions = {
  connecting: 'Connecting…',
  connected: 'Connected · updates every 30 seconds',
  'not-configured': 'Not configured',
  'token-expired': 'Token expired or revoked — enter a new read token',
  'permission-denied': 'This token does not have read permission',
  'connection-error': 'Cannot reach Web — showing the last received values',
  'secure-storage-unavailable': 'Unlock the operating system secure storage'
};
let snapshot = null;
let selectedTrend = null;
let trendPoints = [];
let trendTimer = null;
let trendGeneration = 0;
let choicesDirty = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
async function call(method, value) {
  const response = await api[method](value);
  if (!response.ok) throw new Error(descriptions[response.error] || response.error);
  return response.value;
}
function fail(error) { $('error').textContent = error.message; $('error').hidden = false; }
function checkboxes(container, options, selected) {
  container.replaceChildren();
  for (const [value, label] of options) {
    const input = node('input'); input.type = 'checkbox'; input.value = value;
    input.checked = selected === null || selected.includes(value);
    input.addEventListener('change', () => { choicesDirty = true; });
    const field = node('label'); field.append(input, document.createTextNode(label)); container.append(field);
  }
}
function render(data) {
  snapshot = data;
  $('connection').textContent = descriptions[data.status] || data.status;
  if (document.activeElement !== $('web-url')) $('web-url').value = data.url;
  if (!choicesDirty) {
    checkboxes($('sources'), (data.catalog || data.sources).map(source => [source.sourceId, source.displayName]), data.selectedSources);
    checkboxes($('metrics'), Object.entries(data.metrics).map(([key, metric]) => [key, metric.label]), data.selectedMetrics);
  }
  const shown = data.sources.filter(source => data.selectedSources === null || data.selectedSources.includes(source.sourceId));
  $('cards').replaceChildren();
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = data.status === 'not-configured' ? 'Connect to Web to see your sources.' : data.selectedSources?.length === 0 ? 'No sources selected. Choose sources in display settings.' : data.status === 'connected' ? 'No data yet. Start a collector or a coding hook with a write token from the same account.' : 'No received data. Check the connection status above.';
  for (const source of shown) {
    const card = node('article', undefined, 'card');
    const heading = node('div', undefined, 'card-head');
    if (source.kind === 'agent') {
      const image = node('img');
      const character = /^[a-z0-9-]+$/.test(source.agent?.character) ? source.agent.character : 'vibemon';
      image.src = `../assets/characters/${character}.png`; image.alt = source.agent?.state || 'Agent';
      image.addEventListener('error', () => { image.src = '../assets/characters/vibemon.png'; }, { once: true });
      heading.append(image);
    }
    heading.append(node('h2', source.displayName)); card.append(heading);
    card.append(node('span', source.stale ? 'Stale — last received state' : source.agent?.state || source.health, `badge ${source.stale ? 'stale' : source.health}`));
    for (const key of data.selectedMetrics) {
      const value = source.metrics[key];
      const agentMetric = ['contextPercent', 'usageSessionPercent', 'usageWeekPercent'].includes(key);
      if ((source.kind === 'agent') !== agentMetric) continue;
      if (source.kind === 'host' && ['nodesReady', 'nodesTotal', 'podsUnhealthy'].includes(key)) continue;
      if (source.kind === 'cluster' && ['gpuPercent', 'gpuTemperatureC'].includes(key)) continue;
      const metric = data.metrics[key];
      const row = node('div', undefined, 'gauge'); const label = node('div', undefined, 'gauge-label');
      label.append(node('span', key === 'memoryPercent' && source.memoryType === 'unified' ? 'Unified memory' : metric.label), node('strong', value === null ? 'Unavailable' : `${Number(value.toFixed(1))}${metric.unit}`));
      row.append(label);
      if (value !== null && metric.unit === '%') { const gauge = node('progress'); gauge.max = 100; gauge.value = value; gauge.setAttribute('aria-label', metric.label); row.append(gauge); }
      card.append(row);
    }
    const received = node('time', `Received ${new Date(source.receivedAt).toLocaleTimeString()}`); received.dateTime = source.receivedAt; card.append(received);
    const button = node('button', 'View recent hour', 'secondary'); button.addEventListener('click', () => openTrend(source)); card.append(button);
    $('cards').append(card);
  }
}
function svg(tag, attributes, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}
function drawTrend() {
  const chart = $('chart'); chart.replaceChildren();
  const key = $('trend-metric').value;
  const now = Date.now(); const start = now - 3600000;
  const points = trendPoints.map(point => ({ time: Date.parse(point.timestamp), value: point.average?.[key] })).filter(point => Number.isFinite(point.time) && point.time >= start && point.time <= now);
  const values = points.filter(point => typeof point.value === 'number' && Number.isFinite(point.value));
  const maximum = key.endsWith('Percent') ? 100 : Math.max(1, ...values.map(point => point.value));
  chart.append(svg('line', { x1: 45, y1: 200, x2: 880, y2: 200 }));
  chart.append(svg('text', { x: 0, y: 20 }, `${maximum.toFixed(0)}${snapshot.metrics[key]?.unit || ''}`), svg('text', { x: 15, y: 200 }, '0'));
  for (const [minutes, x] of [[60, 45], [30, 450], [0, 845]]) chart.append(svg('text', { x, y: 225 }, minutes ? `−${minutes} min` : 'Now'));
  let path = ''; let previous = null;
  for (const point of points) {
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) { previous = null; continue; }
    const x = 45 + (point.time - start) / 3600000 * 835; const y = 200 - point.value / maximum * 180;
    path += `${previous !== null && point.time - previous <= 90000 ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
    const circle = svg('circle', { cx: x, cy: y, r: 3 }); circle.append(svg('title', {}, `${new Date(point.time).toLocaleTimeString()}: ${point.value.toFixed(1)}`)); chart.append(circle);
    previous = point.time;
  }
  chart.append(svg('path', { d: path }));
  $('trend-state').textContent = values.length ? `${values.length} recorded minutes` : 'No supported samples for this metric in the last hour.';
}
async function refreshTrend() {
  if (!selectedTrend || document.hidden) return;
  const generation = ++trendGeneration;
  try {
    const points = await call('trend', selectedTrend.sourceId);
    if (generation !== trendGeneration) return;
    trendPoints = points; drawTrend();
  } catch (error) { if (generation === trendGeneration) $('trend-state').textContent = error.message; }
}
function openTrend(source) {
  selectedTrend = source; trendPoints = [];
  $('trend').hidden = false; $('trend-title').textContent = `${source.displayName} · recent hour`;
  $('trend-metric').replaceChildren();
  for (const key of snapshot.selectedMetrics) {
    const metric = snapshot.metrics[key]; const option = node('option', metric.label); option.value = key; $('trend-metric').append(option);
  }
  if (!$('trend-metric').options.length) { $('trend-state').textContent = 'Select at least one metric in display settings.'; return; }
  refreshTrend();
  if (trendTimer) clearInterval(trendTimer);
  trendTimer = setInterval(refreshTrend, snapshot.trendRefreshMs);
  $('trend').scrollIntoView({ behavior: 'smooth' });
}
$('close-trend').addEventListener('click', () => { selectedTrend = null; trendGeneration++; $('trend').hidden = true; clearInterval(trendTimer); trendTimer = null; });
$('trend-metric').addEventListener('change', drawTrend);
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); $('error').hidden = true;
  const token = $('read-token').value.trim(); $('read-token').value = '';
  try { render(await call('configure', { url: $('web-url').value, token })); } catch (error) { fail(error); }
});
$('disconnect').addEventListener('click', async () => { $('close-trend').click(); try { render(await call('disconnect')); } catch (error) { fail(error); } });
$('discover').addEventListener('click', async () => { choicesDirty = false; try { render(await call('refresh')); } catch (error) { fail(error); } });
$('save-selection').addEventListener('click', async () => {
  const sources = [...$('sources').querySelectorAll('input:checked')].map(input => input.value);
  const metrics = [...$('metrics').querySelectorAll('input:checked')].map(input => input.value);
  choicesDirty = false;
  try { render(await call('select', { sources, metrics })); } catch (error) { fail(error); }
});
api.onChange(render);
call('snapshot').then(render).catch(fail);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTrend(); });
window.addEventListener('beforeunload', () => { if (trendTimer) clearInterval(trendTimer); });
