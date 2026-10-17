import { describeReset, formatAxisValue, resetMinutes } from '../../shared/design/presentation.mjs';
import { $, el, text, choices, keyed, svg, reading, badge, stateLabel, ago } from '../dom.js';
import { accountCard, metricName, sourceState, sourceType } from './cards.js';
import { t, locale } from '../i18n.js';

export function setupDetail({ getFrame, cloudTime, request, run }) {
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
  // Keep the chosen metric when it is still offered; otherwise choose the first.
  function chooseMetric(options, choice) {
    choices(
      $('trend-metric'),
      options.map((metric) => [metric.key, metric.unit ? t('detail.metricUnit', { metric: metricName(metric), unit: metric.unit }) : metricName(metric)]),
      options.some((metric) => metric.key === choice) ? choice : options[0]?.key || ''
    );
  }
  function draw() {
    const key = $('trend-metric').value;
    const metric = (historyMetrics || selected.displayMetrics).find((item) => item.key === key);
    const chart = $('chart');
    chart.replaceChildren();
    if (!metric) {
      chart.hidden = true;
      $('chart-legend').hidden = true;
      text($('trend-state'), t('detail.chooseMetric'));
      return;
    }
    const precise = metric.selectionKey.startsWith('resource:');
    const now = cloudTime(),
      start = now - 3600000;
    const samples = points
      .map(point => ({ time: Date.parse(point.timestamp), average: point.average?.[key], maximum: point.maximum?.[key] }))
      .filter(point => Number.isFinite(point.time) && point.time >= start && point.time <= now);
    const values = samples.filter(point => typeof point.average === 'number' && Number.isFinite(point.average));
    chart.hidden = !values.length;
    $('chart-legend').hidden = !values.length;
    if (!values.length) {
      text($('trend-state'), t('detail.noMeasurements'));
      return;
    }
    const minimum = Math.min(metric.display === 'gauge' ? metric.min : 0, ...values.map(point => point.average));
    const top = Math.max(metric.display === 'gauge' ? metric.max : 0, ...values.map(point => point.maximum));
    const maximum = top === minimum ? minimum + 1 : top;
    for (const y of [30, 110, 190]) chart.append(svg('line', { x1: 72, y1: y, x2: 582, y2: y, class: 'grid' }));
    chart.append(svg('text', { x: 0, y: 25 }, formatAxisValue(maximum)), svg('text', { x: 0, y: 195 }, formatAxisValue(minimum)));
    for (const [label, x] of [[t('detail.minutesAgo', { minutes: 60 }), 72], [t('detail.minutesAgo', { minutes: 30 }), 300], [t('detail.now'), 560]]) chart.append(svg('text', { x, y: 225 }, label));
    for (const [series, label] of [['average', t('detail.average')], ['maximum', t('detail.maximum')]]) {
      let path = '', previous = null;
      for (const point of samples) {
        const value = point[series];
        if (typeof value !== 'number' || !Number.isFinite(value)) { previous = null; continue; }
        const x = 72 + ((point.time - start) / 3600000) * 510;
        const y = 190 - ((value - minimum) / (maximum - minimum)) * 160;
        path += `${previous !== null && point.time - previous <= 90000 ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
        const circle = svg('circle', { cx: x, cy: y, r: 2.5, class: series });
        circle.append(svg('title', {}, t('detail.point', { time: new Date(point.time).toLocaleTimeString(locale), series: label, value: reading(value, metric.unit, precise) })));
        chart.append(circle);
        previous = point.time;
      }
      chart.append(svg('path', { d: path, class: series }));
    }
    text($('trend-state'), t('detail.summary', {
      count: values.length,
      average: reading(values.at(-1).average, metric.unit, precise),
      peak: reading(Math.max(...values.map(point => point.maximum)), metric.unit, precise)
    }));
  }
  async function refresh() {
    if (!selected || !metrics(selected).length || !dialog.open || !visible || document.hidden) return;
    const requestGeneration = ++generation;
    $('retry-trend').disabled = true;
    try {
      const result = await request('trend', {
        kind: selected.isAccount ? 'account' : 'source',
        id: selected.sourceId
      });
      if (requestGeneration !== generation || !dialog.open) return;
      const choice = $('trend-metric').value;
      historyMetrics = result.displayMetrics;
      chooseMetric(metrics({ displayMetrics: historyMetrics }), choice);
      points = result.points;
      $('trend-error').hidden = true;
      $('retry-trend').hidden = true;
      draw();
    } catch (error) {
      if (requestGeneration === generation && dialog.open) {
        text($('trend-error'), error.message);
        $('trend-error').hidden = false;
        $('retry-trend').hidden = false;
      }
    } finally {
      if (requestGeneration === generation) $('retry-trend').disabled = false;
    }
  }
  function stop() {
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
  }
  function start() {
    if (!selected || !dialog.open || !visible || document.hidden) return;
    if (!metrics(selected).length) { draw(); return; }
    refresh();
    timer = setInterval(refresh, getFrame().cloud.trendRefreshMs);
  }
  function renderSource(source) {
    const now = cloudTime();
    text($('detail-title'), source.displayName);
    text($('detail-type'), sourceType(source));
    $('detail-type').title = source.isAccount ? source.sourceId : '';
    const status = el('span');
    badge(status, sourceState(source));
    $('detail-status').replaceChildren(status);
    text($('detail-message'), source.statusMessage || '');
    $('detail-message').hidden = !source.statusMessage;
    text($('detail-received'), t('detail.received', { age: ago(source.receivedAt, now).toLocaleLowerCase(locale) }));
    const selectedMetrics = metrics(source);
    keyed(
      $('detail-readings'),
      selectedMetrics,
      (metric) => metric.key,
      () => {
        const node = el('div', undefined, 'detail-reading');
        node.append(el('span'), el('strong'), el('small'));
        return node;
      },
      (node, metric) => {
        const value = source.metrics[metric.key];
        text(node.children[0], metricName(metric));
        text(node.children[1], reading(value, metric.unit, metric.selectionKey.startsWith('resource:')));
        const reset = typeof value === 'number' ? describeReset(resetMinutes(metric.resetAt, now), t) : null;
        text(node.children[2], reset);
        node.children[2].hidden = reset === null;
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
        text(row.children[1], stateLabel(sourceState(member)));
      }
    );
    const choice = $('trend-metric').value;
    chooseMetric(historyMetrics ? metrics({ displayMetrics: historyMetrics }) : selectedMetrics, choice);
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
    $('chart').hidden = true;
    $('chart-legend').hidden = true;
    $('trend-error').hidden = true;
    $('retry-trend').hidden = true;
    text($('trend-state'), t('detail.loading'));
    if (!dialog.open) dialog.showModal();
    start();
  }
  $('trend-metric').addEventListener('change', draw);
  $('retry-trend').addEventListener('click', refresh);
  $('edit-resource').addEventListener('click', () =>
    run($('edit-resource'), () => request('open-web', 'edit-resource', selected.sourceId))
  );
  $('remove-monitor').addEventListener('click', () =>
    run($('remove-monitor'), () => request('remove-monitor', { kind: selected.isAccount ? 'account' : 'source', id: selected.sourceId }))
  );
  dialog.addEventListener('close', () => {
    // A queued close event can arrive after this dialog has reopened.
    if (dialog.open) return;
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
        const previousMetric = $('trend-metric').value;
        renderSource(source);
        if ($('trend-metric').value !== previousMetric) draw();
        if (!metrics(source).length) stop();
        else if (!timer) start();
      }
    }
  };
}
