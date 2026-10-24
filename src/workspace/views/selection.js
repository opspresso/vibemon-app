import { accountName, metricLabel } from '../../shared/design/presentation.mjs';
import { $, el, keyed, text, providerName, connection } from '../dom.js';
import { t } from '../i18n.js';

export function setupSelection({ getFrame, request, navigate, run, notify, fail }) {
  const dialog = $('selection-dialog');
  let opening = 0;
  const isCurrent = value => value === opening && dialog.open;
  function values(id) {
    return [...$(id).querySelectorAll('input:checked')].map((input) => input.value);
  }
  function draft() {
    return {
      sources: values('source-choices'),
      accounts: values('account-choices'),
      metrics: values('metric-choices')
    };
  }
  function count() {
    const selected = draft();
    text($('selection-count'), `${t('count.accounts', { count: selected.accounts.length })} · ${t('count.resources', { count: selected.sources.length })}`);
  }
  function checkbox(entry) {
    const label = el('label', undefined, 'choice');
    const input = el('input');
    input.type = 'checkbox';
    input.value = entry.id;
    const copy = el('span');
    label.append(input, copy);
    label._parts = { input, copy };
    input.addEventListener('change', count);
    return label;
  }
  function renderList(id, entries, chosen) {
    keyed(
      $(id),
      entries,
      (item) => item.id,
      checkbox,
      (node, entry) => {
        node._parts.input.checked = chosen === null || chosen.includes(entry.id);
        text(node._parts.copy, entry.label);
        node._parts.input.setAttribute('aria-label', entry.label);
      }
    );
  }
  function render(cloud, saved) {
    renderList(
      'source-choices',
      cloud.catalog
        .filter((source) => source.kind !== 'agent')
        .map((source) => ({ id: source.sourceId, label: source.displayName })),
      saved.sources
    );
    renderList(
      'account-choices',
      cloud.accountCatalog.map((account) => ({
        id: account.accountId,
        label: `${providerName(account.provider)} · ${account.displayName} (${accountName(account.accountId)})`
      })),
      saved.accounts
    );
    renderList(
      'metric-choices',
      Object.entries(cloud.metrics).map(([id, metric]) => ({ id, label: metricLabel(id, metric.label, t) })),
      saved.metrics
    );
    count();
  }
  function open() {
    opening++;
    dialog.querySelector('.dialog-error').hidden = true;
    const cloud = getFrame().cloud;
    if (!cloud.tokenConfigured) {
      navigate('connections');
      return;
    }
    render(cloud, {
      sources: cloud.selectedSources,
      accounts: cloud.selectedAccounts,
      metrics: cloud.selectedMetrics
    });
    if (!dialog.open) dialog.showModal();
  }
  function mark(ids, checked) {
    for (const id of ids) for (const input of $(id).querySelectorAll('input[type=checkbox]')) input.checked = checked;
    count();
  }
  $('select-all').addEventListener('click', () => mark(['source-choices', 'account-choices'], true));
  $('select-none').addEventListener('click', () => mark(['source-choices', 'account-choices'], false));
  $('all-metrics').addEventListener('click', () => mark(['metric-choices'], true));
  $('clear-metrics').addEventListener('click', () => mark(['metric-choices'], false));
  $('discover').addEventListener('click', () => {
    const current = opening;
    run($('discover'), async () => {
      const cloud = await request('refresh');
      if (!isCurrent(current)) return;
      if (cloud.status !== 'connected') throw new Error(connection(cloud.status)[1]);
      render(cloud, draft());
    }, error => { if (isCurrent(current)) fail(error); });
  });
  $('selection-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const current = opening;
    run($('save-selection'), async () => {
      await request('select', draft());
      if (isCurrent(current)) dialog.close();
      notify(t('toast.selectionSaved'));
    }, error => { if (isCurrent(current)) fail(error); });
  });
  dialog.addEventListener('close', () => {
    // A queued close event belongs to the previous opening.
    if (dialog.open) return;
    opening++;
    for (const id of ['source-choices', 'account-choices', 'metric-choices']) {
      $(id).replaceChildren();
      $(id)._items = new Map();
    }
  });
  return {
    open,
    close: () => {
      if (dialog.open) dialog.close();
    }
  };
}
