// Connected services: the Claude and Codex accounts whose plan usage the
// VibeMon server reads. Every request goes through the main process; this page
// never sees the read token or a service sign-in.
import { $, el, text, icon, button, keyed, sprite, ago, usageError } from '../dom.js';
import { t, locale } from '../i18n.js';
import { accountCard, createMetric, updateMetric } from './cards.js';
import { UsageStore, UsageConnectFlow } from '../services-store.js';
import {
  serviceName, serviceCharacter, connectionIdentity, connectionBadge, connectionMessage,
  needsPerson, primaryWindow, windowMetric
} from './service-labels.js';

// The pages that show connections or their attention.
const PAGES = new Set(['overview', 'agents', 'services']);

export function setupServices({ getFrame, request, run, notify, navigate, openDetail }) {
  let visible = true;
  let refreshTimer = null;
  let shownRoute = null;
  const rerender = () => { if (getFrame()) render(getFrame()); };
  const store = new UsageStore({ request, onChange: rerender });
  const dialog = $('service-dialog');
  const flow = new UsageConnectFlow({
    request, describe: usageError,
    onChange: () => { if (dialog.open) renderFlow(); },
    onConnected: connection => { store.accept(connection); rerender(); }
  });

  // ---- One connection row (Settings and the Agents page share it) ----
  function createRow() {
    const row = el('article', undefined, 'service-row');
    const heading = el('div', undefined, 'service-heading');
    const glyph = el('div', undefined, 'source-icon');
    const image = el('img');
    image.alt = '';
    glyph.append(image);
    const titles = el('div', undefined, 'card-title-group');
    const titleLine = el('div', undefined, 'service-title');
    const name = el('h3');
    const plan = el('span', undefined, 'chip active service-plan');
    titleLine.append(name, plan);
    const label = el('span', undefined, 'small muted');
    titles.append(titleLine, label);
    const status = el('span', undefined, 'chip');
    heading.append(glyph, titles, status);
    const message = el('p', undefined, 'service-message');
    const metric = createMetric();
    metric.classList.add('service-metric');
    const updated = el('p', undefined, 'small muted service-updated');
    const failure = el('p', undefined, 'notice danger service-error');
    failure.setAttribute('role', 'alert');
    const actions = el('div', undefined, 'service-actions');
    const signInAgain = button(t('services.signInAgain'), () => openConnect(row._connection.provider), 'button small-button');
    // A token from before the usage permission: sign in to VibeMon again, then read the list again.
    const vibemonSignIn = button(t('services.signInAgain'), () => run(vibemonSignIn, async () => {
      await request('sign-in', getFrame().cloud.url);
      store.actionErrors.delete(row._connection.id);
      await store.load();
    }, error => { store.actionErrors.set(row._connection.id, { message: error.message, code: error.code ?? null }); rerender(); }), 'button small-button');
    vibemonSignIn.setAttribute('aria-label', t('services.signInVibeMon'));
    const refresh = button(t('services.refresh'), () => store.refresh(row._connection.id), 'button secondary small-button', 'refresh');
    const showAgent = button(t('services.showAgent'), () => showAgentCard(row._connection), 'text-button', 'arrow');
    const disconnect = button(t('services.disconnect'), () => confirmDisconnect(row._connection), 'button quiet-danger small-button');
    actions.append(vibemonSignIn, signInAgain, refresh, showAgent, disconnect);
    row.append(heading, message, metric, updated, failure, actions);
    row._parts = { image, name, plan, label, status, message, metric, updated, failure, vibemonSignIn, signInAgain, refresh, showAgent, disconnect };
    return row;
  }
  function accountFor(connection) {
    const key = `${connection.provider}:${connection.accountId}`;
    return getFrame()?.cloud.accounts.find(account => account.accountId === key) ?? null;
  }
  function updateRow(row, connection) {
    row._connection = connection;
    const time = store.now();
    const parts = row._parts;
    const path = sprite(serviceCharacter(connection.provider));
    if (parts.image.getAttribute('src') !== path) parts.image.src = path;
    text(parts.name, serviceName(connection.provider));
    text(parts.plan, connection.plan || '');
    parts.plan.hidden = !connection.plan;
    text(parts.label, connection.label || t('services.unnamedAccount'));
    parts.label.title = connection.label || '';
    const [badge, tone] = connectionBadge(connection);
    text(parts.status, badge);
    parts.status.className = `chip ${tone}`;
    const message = connectionMessage(connection);
    text(parts.message, message || '');
    parts.message.hidden = !message;
    const window = connection.status === 'reconnect-required' ? null : primaryWindow(connection, time);
    parts.metric.hidden = !window;
    if (window) {
      const metric = windowMetric(window);
      updateMetric(parts.metric, { metric, value: window.usedPercent, label: metric.label, now: time });
    }
    text(parts.updated, connection.observedAt ? t('services.updated', { age: ago(connection.observedAt, time).toLocaleLowerCase(locale) }) : t('services.notRead'));
    parts.updated.title = connection.observedAt ? new Date(connection.observedAt).toLocaleString(locale) : '';
    const failure = store.actionErrors.get(connection.id);
    text(parts.failure, failure?.message || '');
    parts.failure.hidden = !failure;
    parts.vibemonSignIn.hidden = failure?.code !== 'usage-sign-in-required';
    const reconnect = connection.status === 'reconnect-required';
    const working = store.busy.has(connection.id);
    parts.signInAgain.hidden = !reconnect;
    parts.refresh.hidden = reconnect;
    const refreshable = time >= Date.parse(connection.refreshableAt);
    parts.refresh.disabled = working || !refreshable;
    parts.refresh.title = refreshable ? '' : t('services.refreshWait');
    const identity = connectionIdentity(connection);
    parts.refresh.setAttribute('aria-label', t('services.refreshNamed', { name: identity }));
    parts.showAgent.hidden = !accountFor(connection);
    parts.showAgent.setAttribute('aria-label', t('services.showAgentNamed', { name: identity }));
    parts.disconnect.disabled = working;
    parts.disconnect.setAttribute('aria-label', t('services.disconnectNamed', { name: identity }));
  }
  function renderList(container) {
    const frame = getFrame();
    const items = store.connections;
    let state = null;
    if (!frame.cloud.tokenConfigured) state = [t('connection.notConfigured.label'), t('connection.notConfigured.description')];
    else if (!store.snapshot) state = store.error ? [t('empty.unavailable'), store.error] : [t('services.loading'), ''];
    else if (!items.length) state = [t('services.emptyTitle'), t('services.emptyBody')];
    if (!container._parts) {
      const empty = el('div', undefined, 'service-empty');
      const settings = button(t('action.connectionSettings'), () => navigate('connections'), 'text-button', 'arrow');
      empty.append(el('h3'), el('p', undefined, 'muted'), settings);
      const rows = el('div', undefined, 'service-rows');
      const connect = el('div', undefined, 'service-connect');
      container.replaceChildren(empty, rows, connect);
      container._parts = { empty, settings, rows, connect };
    }
    const { empty, settings, rows, connect } = container._parts;
    empty.hidden = !state;
    if (state) {
      text(empty.children[0], state[0]);
      text(empty.children[1], state[1]);
      empty.children[1].hidden = !state[1];
      settings.hidden = frame.cloud.tokenConfigured;
    }
    keyed(rows, items, connection => connection.id, createRow, updateRow);
    renderConnect(connect, frame.cloud.tokenConfigured && store.snapshot ? store.providers : []);
  }
  /** One Connect button per service that this VibeMon address can connect. */
  function renderConnect(container, providers) {
    keyed(container, providers, provider => provider, provider => {
      const control = button('', () => openConnect(provider), 'button secondary');
      const image = el('img');
      image.src = sprite(serviceCharacter(provider));
      image.alt = '';
      control.replaceChildren(image, document.createTextNode(t('services.connectNamed', { service: serviceName(provider) })));
      return control;
    }, () => {});
    container.hidden = !providers.length;
  }
  // Overview invites a first connection, as Web and iPhone do, once the list is known to be empty.
  function renderOnboarding(container, frame) {
    const show = frame.cloud.tokenConfigured && Boolean(store.snapshot) && !store.connections.length;
    container.hidden = !show;
    if (show) renderConnect($('overview-services-connect'), store.providers);
  }
  function renderAttention(container) {
    const connection = store.connections.find(needsPerson);
    container.hidden = !connection;
    if (!connection) return;
    if (!container._parts) {
      const image = el('img');
      image.alt = '';
      const glyph = el('span', undefined, 'source-icon');
      glyph.append(image);
      const content = el('span', undefined, 'service-attention-content');
      const title = el('strong'), message = el('span', undefined, 'small muted');
      content.append(title, message);
      const status = el('span', undefined, 'chip');
      container.replaceChildren(glyph, content, status, icon('chevron'));
      container._parts = { image, title, message, status };
    }
    const { image, title, message, status } = container._parts;
    const path = sprite(serviceCharacter(connection.provider));
    if (image.getAttribute('src') !== path) image.src = path;
    text(title, `${t('services.attentionTitle')} · ${serviceName(connection.provider)}`);
    text(message, connectionMessage(connection) || '');
    const [badge, tone] = connectionBadge(connection);
    text(status, badge);
    status.className = `chip ${tone}`;
  }
  // Enable Refresh once the server allows it, without waiting for the next poll.
  function scheduleRefreshable() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!store.active) return;
    const time = store.now();
    const next = Math.min(...store.connections.map(connection => Date.parse(connection.refreshableAt)).filter(at => at > time));
    if (Number.isFinite(next)) refreshTimer = setTimeout(rerender, next - time + 250);
  }
  function render(frame) {
    store.follow(frame.cloud.connectionRevision);
    const wasActive = store.active;
    store.setActive(visible && PAGES.has(frame.route) && frame.cloud.tokenConfigured);
    // Opening another page that shows connections reads them again, like a screen appearing on iPhone.
    if (wasActive && store.active && frame.route !== shownRoute) store.load();
    shownRoute = frame.route;
    if (frame.route === 'services') renderList($('service-list'));
    if (frame.route === 'agents') renderList($('agent-services'));
    if (frame.route === 'overview') {
      renderAttention($('overview-services'));
      renderOnboarding($('overview-services-onboarding'), frame);
    } else {
      $('overview-services').hidden = true;
      $('overview-services-onboarding').hidden = true;
    }
    scheduleRefreshable();
  }
  $('overview-services').addEventListener('click', () => navigate('services'));

  function showAgentCard(connection) {
    const account = accountFor(connection);
    if (account) openDetail(accountCard(account));
  }
  const disconnectDialog = $('service-disconnect-dialog');
  let disconnecting = null;
  function confirmDisconnect(connection) {
    disconnecting = connection;
    text($('service-disconnect-body'), t('services.disconnectBody', { name: connectionIdentity(connection) }));
    disconnectDialog.showModal();
  }
  $('service-disconnect-confirm').addEventListener('click', () => {
    const connection = disconnecting;
    if (!connection) return;
    disconnectDialog.close();
    store.disconnect(connection.id).then(done => {
      if (done) notify(t('services.disconnected', { name: connectionIdentity(connection) }));
    });
  });
  disconnectDialog.addEventListener('close', () => { disconnecting = null; });

  // ---- Connect flow ----
  function openConnect(provider) {
    flow.open(provider);
    $('service-code').value = '';
    renderFlow();
    if (!dialog.open) dialog.showModal();
  }
  function renderFlow() {
    const name = serviceName(flow.provider);
    const step = flow.phase === 'authorize' ? flow.authorization.prompt.kind : flow.phase === 'starting' ? 'choose' : flow.phase;
    text($('service-dialog-title'), t('services.connectNamed', { service: name }));
    for (const node of dialog.querySelectorAll('[data-service-phase]')) node.hidden = node.dataset.servicePhase !== step;
    for (const choice of dialog.querySelectorAll('[name="service-provider"]')) {
      choice.checked = choice.value === flow.provider;
      choice.disabled = flow.phase !== 'choose';
    }
    text($('service-plan-help'), t(`services.provider.${flow.provider}`));
    text($('service-disclosure'), t(`services.disclosure.${flow.provider}`));
    text($('service-start'), t(flow.phase === 'starting' ? 'services.starting' : 'services.connectNamed', { service: name }));
    $('service-start').disabled = flow.phase !== 'choose';
    $('service-submit').disabled = flow.submitting;
    text($('service-submit'), t(flow.checking ? 'services.checking' : flow.submitting ? 'services.connecting' : 'services.connect'));
    if (step === 'device') {
      text($('service-user-code'), flow.authorization.prompt.userCode);
      $('service-user-code').setAttribute('aria-label', `${t('services.codex.codeLabel')} ${flow.authorization.prompt.userCode}`);
      $('service-waiting').hidden = !flow.waiting;
    }
    if (step === 'connected') {
      const connection = flow.connection;
      text($('service-connected'), t('services.connected', { service: serviceName(connection.provider) }));
      text($('service-connected-label'), connection.label || '');
      $('service-connected-label').hidden = !connection.label;
      const time = store.now();
      const window = primaryWindow(connection, time);
      const container = $('service-connected-metric');
      if (!container.firstElementChild) container.replaceChildren(createMetric());
      container.hidden = !window;
      if (window) {
        const metric = windowMetric(window);
        updateMetric(container.firstElementChild, { metric, value: window.usedPercent, label: metric.label, now: time });
      }
    }
    text($('service-dialog-error'), flow.error?.message || '');
    $('service-dialog-error').hidden = !flow.error;
    $('service-vibemon-sign-in').hidden = flow.error?.code !== 'usage-sign-in-required';
    text($('service-dialog-close'), t(flow.phase === 'connected' ? 'services.done' : 'common.cancel'));
  }
  // Errors of the dialog's own controls stay in the dialog.
  const showError = error => { flow.fail(error); renderFlow(); };
  for (const choice of dialog.querySelectorAll('[name="service-provider"]')) {
    choice.addEventListener('change', () => { if (choice.checked) flow.choose(choice.value); });
  }
  $('service-start').addEventListener('click', async () => {
    await flow.start();
    if (flow.phase === 'authorize') (flow.authorization.prompt.kind === 'code' ? $('service-open-claude') : $('service-copy')).focus();
  });
  $('service-open-claude').addEventListener('click', () => run($('service-open-claude'), () => request('usage-open', flow.authorization.id), showError));
  $('service-code-form').addEventListener('submit', async event => {
    event.preventDefault();
    const connection = await flow.submit($('service-code').value);
    if (connection) $('service-code').value = '';
    else if (flow.phase === 'authorize') $('service-code').focus();
  });
  $('service-copy').addEventListener('click', () => run($('service-copy'), async () => {
    await request('usage-copy', flow.authorization.id);
    notify(t('services.codex.copied'));
  }, showError));
  $('service-open-codex').addEventListener('click', () => run($('service-open-codex'), async () => {
    const { id } = flow.authorization;
    await request('usage-copy', id);
    await request('usage-open', id);
    if (flow.authorization?.id === id) flow.approvalOpened();
  }, showError));
  // A token from before the usage permission: sign in to VibeMon again, then start over.
  $('service-vibemon-sign-in').addEventListener('click', () => run($('service-vibemon-sign-in'), async () => {
    text($('service-dialog-error'), t('services.signInHelp'));
    await request('sign-in', getFrame().cloud.url);
    flow.open(flow.provider);
    renderFlow();
  }, showError));
  $('service-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    // A queued close event can arrive after the dialog reopened.
    if (dialog.open) return;
    $('service-code').value = '';
    flow.close();
  });

  return {
    render,
    visibility(value) {
      visible = value;
      if (!value) {
        store.setActive(false);
        // A hidden window keeps no sign-in open: stop polling and cancel it on the
        // server now, because a hidden page may deliver the dialog's close event late.
        if (dialog.open) dialog.close();
        flow.close();
        if (disconnectDialog.open) disconnectDialog.close();
      }
      rerender();
    }
  };
}
