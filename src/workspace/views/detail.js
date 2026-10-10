import { $, el, text, choices, keyed, svg, reading, badge, providerName, stateLabel, ago } from '../dom.js';
import { resourceType, accountCard } from './cards.js';

export function setupDetail({ getFrame, request, run }) {
  const dialog = $('detail-dialog');
  let selected = null;
  let points = [];
  let historyMetrics = null;
  let generation = 0;
  let timer = null;
  let visible = true;
  function metrics(source) {
    const selectedKeys = new Set(getFrame().cloud.selectedMetrics);
    return source.displayMetrics.filter((metric) => selectedKeys.has(metric.selectionKey));
  }
  function draw() {
    const key = $('trend-metric').value;
    const metric = (historyMetrics || selected.displayMetrics).find((item) => item.key === key);
    const chart = $('chart');
    chart.replaceChildren();
    if (!metric) {
      text($('trend-state'), 'Choose a visible metric in Customize view.');
      return;
    }
    const precise = metric.selectionKey.startsWith('resource:');
    const now = Date.now(),
      start = now - 3600000;
    const samples = points
      .map((point) => ({ time: Date.parse(point.timestamp), value: point.average?.[key] }))
      .filter((point) => Number.isFinite(point.time) && point.time >= start && point.time <= now);
    const values = samples.filter((point) => typeof point.value === 'number' && Number.isFinite(point.value));
    const minimum = Math.min(
      metric.display === 'gauge' ? metric.min : 0,
      ...values.map((point) => point.value)
    );
    const top = Math.max(metric.display === 'gauge' ? metric.max : 0, ...values.map((point) => point.value));
    const maximum = top === minimum ? minimum + 1 : top;
    for (const y of [30, 110, 190])
      chart.append(svg('line', { x1: 48, y1: y, x2: 582, y2: y, class: 'grid' }));
    chart.append(
      svg('text', { x: 0, y: 25 }, reading(maximum, metric.unit, precise)),
      svg('text', { x: 0, y: 195 }, reading(minimum, metric.unit, precise))
    );
    for (const [label, x] of [
      ['−60 min', 48],
      ['−30 min', 300],
      ['Now', 560]
    ])
      chart.append(svg('text', { x, y: 225 }, label));
    let path = '',
      previous = null;
    for (const point of samples) {
      if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
        previous = null;
        continue;
      }
      const x = 48 + ((point.time - start) / 3600000) * 534;
      const y = 190 - ((point.value - minimum) / (maximum - minimum)) * 160;
      path += `${previous !== null && point.time - previous <= 90000 ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
      const circle = svg('circle', { cx: x, cy: y, r: 3 });
      circle.append(
        svg(
          'title',
          {},
          `${new Date(point.time).toLocaleTimeString()} · ${reading(point.value, metric.unit, precise)}`
        )
      );
      chart.append(circle);
      previous = point.time;
    }
    chart.append(svg('path', { d: path }));
    text(
      $('trend-state'),
      values.length
        ? `${values.length} recorded ${values.length === 1 ? 'minute' : 'minutes'} · latest ${reading(values.at(-1).value, metric.unit, precise)}`
        : 'No measurements recorded for this metric in the last hour.'
    );
  }
  async function refresh() {
    if (!selected || !dialog.open || !visible || document.hidden) return;
    const requestGeneration = ++generation;
    try {
      const result = await request('trend', {
        kind: selected.isAccount ? 'account' : 'source',
        id: selected.sourceId
      });
      if (requestGeneration !== generation || !dialog.open) return;
      const choice = $('trend-metric').value;
      historyMetrics = result.displayMetrics;
      const options = metrics({ displayMetrics: historyMetrics });
      choices(
        $('trend-metric'),
        options.map((metric) => [metric.key, metric.label]),
        options.some((metric) => metric.key === choice) ? choice : options[0]?.key || ''
      );
      points = result.points;
      draw();
    } catch (error) {
      if (requestGeneration === generation && dialog.open) text($('trend-state'), error.message);
    }
  }
  function stop() {
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
  }
  function start() {
    if (!selected || !selected.displayMetrics.length || !dialog.open || !visible || document.hidden) return;
    refresh();
    timer = setInterval(refresh, getFrame().cloud.trendRefreshMs);
  }
  function renderSource(source) {
    text($('detail-title'), source.displayName);
    text(
      $('detail-type'),
      source.isAccount ? `${providerName(source.provider)} · ${source.sourceId.slice(source.provider.length + 1)}` : resourceType(source)
    );
    const status = el('span');
    badge(status, source.stale ? 'stale' : source.agent?.state || source.health);
    $('detail-status').replaceChildren(status);
    text($('detail-message'), source.statusMessage || '');
    $('detail-message').hidden = !source.statusMessage;
    text($('detail-received'), `Received ${ago(source.receivedAt).toLowerCase()}`);
    const selectedMetrics = metrics(source);
    keyed(
      $('detail-readings'),
      selectedMetrics,
      (metric) => metric.key,
      () => {
        const node = el('div', undefined, 'detail-reading');
        node.append(el('span'), el('strong'));
        return node;
      },
      (node, metric) => {
        text(node.children[0], metric.label);
        text(node.children[1], reading(source.metrics[metric.key], metric.unit, metric.selectionKey.startsWith('resource:')));
      }
    );
    keyed(
      $('detail-members'),
      source.members || [],
      (member) => member.sourceId,
      () => {
        const row = el('div', undefined, 'detail-member');
        row.append(el('span'), el('span', undefined, 'muted'));
        return row;
      },
      (row, member) => {
        text(row.children[0], member.agent.project);
        text(row.children[1], member.stale ? 'Stale' : stateLabel(member.agent.state));
      }
    );
    const choice = $('trend-metric').value;
    const options = historyMetrics ? metrics({ displayMetrics: historyMetrics }) : selectedMetrics;
    choices(
      $('trend-metric'),
      options.map((metric) => [metric.key, metric.label]),
      options.some((metric) => metric.key === choice) ? choice : options[0]?.key || ''
    );
    $('detail-history').hidden = !source.displayMetrics.length;
    $('edit-resource').hidden = source.isAccount;
  }
  function open(source) {
    stop();
    selected = source;
    points = [];
    historyMetrics = null;
    dialog.querySelector('.dialog-error').hidden = true;
    renderSource(source);
    $('chart').replaceChildren();
    text($('trend-state'), 'Loading recorded measurements…');
    if (!dialog.open) dialog.showModal();
    start();
  }
  $('trend-metric').addEventListener('change', draw);
  $('edit-resource').addEventListener('click', () =>
    run($('edit-resource'), () => request('open-web', 'edit-resource', selected.sourceId))
  );
  dialog.addEventListener('close', () => {
    stop();
    selected = null;
    points = [];
    historyMetrics = null;
    for (const id of ['detail-readings', 'detail-members', 'chart']) {
      $(id).replaceChildren();
      $(id)._items = new Map();
    }
  });
  document.addEventListener('visibilitychange', () => {
    stop();
    if (!document.hidden) start();
  });
  return {
    open,
    close() {
      stop();
      selected = null;
      if (dialog.open) dialog.close();
    },
    visibility(value) {
      visible = value;
      stop();
      if (value) start();
    },
    changed(frame) {
      if (!selected) return;
      const source = selected.isAccount
        ? frame.cloud.accounts.map(accountCard).find((account) => account.sourceId === selected.sourceId)
        : frame.cloud.sources.find((source) => source.sourceId === selected.sourceId);
      if (!source) {
        stop();
        selected = null;
        dialog.close();
        return;
      }
      selected = source;
      if (visible && dialog.open) {
        renderSource(source);
        if (points.length) draw();
      }
    }
  };
}
