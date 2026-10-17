import { $, text, hydrateIcons, connection, isConnectionStatus, choices, configureSprites, ago, providerName } from './dom.js';
import { renderCards, renderActivity, renderUsage, accountCard, needsAttention } from './views/cards.js';
import { setupPreferences } from './views/preferences.js';
import { setupSelection } from './views/selection.js';
import { setupDetail } from './views/detail.js';
import { t, locale, localizeDocument } from './i18n.js';

const api = window.workspace;
// Route → [title key, description key].
const pages = {
  overview: ['nav.overview', 'page.overview'],
  resources: ['nav.resources', 'page.resources'],
  agents: ['nav.agents', 'page.agents'],
  connections: ['nav.settings', 'page.settings'],
  companion: ['nav.settings', 'page.settings'],
  integrations: ['nav.settings', 'page.settings'],
  about: ['nav.settings', 'page.settings']
};
const settingsPages = new Set(['connections', 'companion', 'integrations', 'about']);
let frame = null;
let cloudAnchor = null;
const cloudTime = () => cloudAnchor.time + Math.max(0, window.performance.now() - cloudAnchor.received);
let toastTimer = null;
let visible = true;
let pageFocusPending = false;
let overviewAttention = false;
let preferences, selection, detail;
document.documentElement.dataset.platform = api.platform;
localizeDocument();
hydrateIcons();

async function request(command, ...args) {
  const response = await api.request(command, ...args);
  // A connection status code becomes its explanation; other errors are already sentences.
  if (!response.ok) throw new Error(isConnectionStatus(response.error) ? connection(response.error)[1] : response.error);
  if (command === 'settings') {
    accept(response.value.frame);
    return response.value.result;
  }
  return response.value;
}
function fail(error) {
  const message = error.message || t('error.requestIncomplete');
  const dialogError = document.querySelector('dialog[open] .dialog-error');
  if (dialogError) {
    text(dialogError, message);
    dialogError.hidden = false;
    dialogError.scrollIntoView({ block: 'nearest' });
  } else {
    text($('error-message'), message);
    $('error').hidden = false;
  }
}
async function run(control, action, onError = fail) {
  if (control?.dataset.busy) return;
  const hadFocus = control && document.activeElement === control;
  if (control) {
    control.dataset.busy = 'true';
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
  }
  $('error').hidden = true;
  for (const notice of document.querySelectorAll('.dialog-error')) notice.hidden = true;
  try {
    return await action();
  } catch (error) {
    onError(error);
  } finally {
    if (control) {
      delete control.dataset.busy;
      control.disabled = false;
      control.removeAttribute('aria-busy');
    }
    if (frame) render(frame);
    if (hadFocus && document.activeElement === document.body && control.checkVisibility() && !control.disabled) {
      control.focus({ preventScroll: true });
    }
  }
}
function notify(message) {
  if (toastTimer) clearTimeout(toastTimer);
  text($('toast'), message);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
    toastTimer = null;
  }, 2400);
}
async function navigate(route) {
  if (!pages[route]) return;
  detail.close();
  selection.close();
  preferences.leave();
  try {
    accept(await request('navigate', route));
    $('main').scrollTop = 0;
  } catch (error) {
    fail(error);
  }
}
const shared = { getFrame: () => frame, cloudTime, request, run, notify, navigate, fail };
preferences = setupPreferences(shared);
selection = setupSelection(shared);
detail = setupDetail(shared);

function accept(value) {
  // Local activity can republish the same cached cloud frame. Only a new cloud
  // evaluation may reset this renderer's monotonic anchor.
  if (cloudAnchor?.time !== value.cloud.evaluatedAt) cloudAnchor = { time: value.cloud.evaluatedAt, received: window.performance.now() };
  const pageChanged = Boolean(frame && frame.route !== value.route);
  if (pageChanged) pageFocusPending = true;
  if (frame && frame.cloud.connectionRevision !== value.cloud.connectionRevision) {
    overviewAttention = false;
    detail.close();
    selection.close();
    for (const id of ['overview-resources', 'overview-accounts', 'resource-cards', 'agent-cards']) {
      const container = $(id);
      container.replaceChildren();
      container._items = new Map();
      container._empty = false;
    }
  }
  if (pageChanged) {
    detail.close();
    selection.close();
    preferences.leave();
    $('main').scrollTop = 0;
  }
  frame = value;
  if (visible) {
    render(value);
    focusPage();
  }
  detail.changed(value);
}

function focusPage() {
  if (pageFocusPending && visible && document.hasFocus()) {
    pageFocusPending = false;
    $('page-title').focus({ preventScroll: true });
  }
}
window.addEventListener('focus', focusPage);

// Each dot names its issue, so a reader knows which page resolves it.
function markAttention({ notices }) {
  const reasons = {
    resources: notices.resources,
    agents: notices.accounts,
    connections: notices.connection,
    integrations: notices.integrations,
    about: notices.update
  };
  reasons.settings = [reasons.connections, reasons.integrations, reasons.about].filter(Boolean).join(' · ') || null;
  for (const dot of document.querySelectorAll('[data-attention]')) {
    const reason = reasons[dot.dataset.attention];
    dot.hidden = !reason;
    dot.title = reason || '';
    if (reason) dot.setAttribute('aria-label', reason);
    else dot.removeAttribute('aria-label');
  }
}
function render(value) {
  const { cloud, settings, activity, usage } = value;
  const route = pages[value.route] ? value.route : 'overview';
  document.documentElement.dataset.page = route;
  configureSprites(settings.options.characters);
  const title = t(pages[route][0]);
  text($('page-title'), title);
  $('page-title').setAttribute('aria-label', settingsPages.has(route) ? t('page.settingsLabel', { page: t(`nav.${route}`) }) : title);
  text($('page-description'), t(pages[route][1]));
  for (const section of document.querySelectorAll('[data-page]'))
    section.hidden = section.dataset.page !== route;
  for (const button of document.querySelectorAll('[data-page-link]')) {
    const active = button.hasAttribute('data-settings-nav')
      ? settingsPages.has(route)
      : button.dataset.pageLink === route;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('settings-tabs').hidden = !settingsPages.has(route);
  $('header-customize').hidden = route !== 'overview';
  const [label, description, tone] = connection(cloud.status);
  text($('connection-chip'), label);
  $('connection-chip').className = `chip ${tone}`;
  text($('sidebar-status'), label);
  $('sidebar-dot').className = `status-dot ${tone}`;
  let host = t('sidebar.host');
  try {
    host = new URL(cloud.url).host;
  } catch {
    host = t('sidebar.checkAddress');
  }
  text($('sidebar-host'), host);
  $('connection-notice').hidden = cloud.status === 'connected' || route === 'connections';
  text(
    $('connection-notice-title'),
    cloud.status === 'not-configured' ? t('connection.notice') : label
  );
  text($('connection-notice-description'), description);
  const resources = cloud.sources.filter((source) => source.kind !== 'agent');
  const accounts = cloud.accounts.map(accountCard);
  const active = activity.filter((item) => item.running);
  const attention = cloud.attentionCount;
  const receivedCloudData = Boolean(cloud.lastSyncedAt) || !cloud.tokenConfigured;
  text($('nav-resources'), receivedCloudData ? resources.length : '—');
  text($('nav-agents'), receivedCloudData ? accounts.length : '—');
  text($('summary-resources'), receivedCloudData ? resources.length : '—');
  text($('summary-accounts'), receivedCloudData ? accounts.length : '—');
  text($('summary-local'), activity.length);
  text($('summary-attention'), receivedCloudData ? attention : '—');
  text(
    $('summary-resource-note'),
    resources.length
      ? t('summary.resourcesNote', {
        healthy: resources.filter((item) => !needsAttention(item) && item.health === 'ok').length,
        attention: resources.filter(needsAttention).length
      })
      : t('summary.resourcesEmpty')
  );
  text(
    $('summary-account-note'),
    accounts.length
      ? t('summary.providers', { count: new Set(accounts.map((item) => item.provider)).size })
      : t('summary.accountsEmpty')
  );
  text($('summary-local-note'), t('summary.localActive', { count: active.length }));
  // The tile already says "Need attention"; its note names where.
  text($('summary-attention-note'), overviewAttention ? t('summary.reviewing') : value.attention.notices.where || t('summary.noIssues'));
  $('overview-attention').setAttribute('aria-pressed', String(overviewAttention));
  document.documentElement.dataset.overviewFilter = overviewAttention ? 'attention' : 'all';
  markAttention(value.attention);
  text(
    $('last-sync'),
    cloud.lastSyncedAt
      ? t('footer.checked', { age: ago(cloud.lastSyncedAt).toLocaleLowerCase(locale) })
      : t('footer.localOnly')
  );
  text($('footer-version'), settings.version);
  const selectedMetrics = new Set(cloud.selectedMetrics);
  const canChoose = cloud.status === 'connected' || cloud.catalog.length > 0;
  const choose = () => (canChoose ? selection.open() : navigate('connections'));
  const resourceEmpty = {
    emptyTitle: t(cloud.status === 'not-configured' ? 'empty.resources.welcome' : 'empty.resources.title'),
    emptyDescription: t(cloud.tokenConfigured ? 'empty.resources.description' : 'empty.resources.connect'),
    emptyAction: t(cloud.tokenConfigured ? 'empty.resources.action' : 'empty.connect')
  };
  const accountEmpty = {
    emptyTitle: t('empty.accounts.title'),
    emptyDescription: t('empty.accounts.description'),
    emptyAction: t(cloud.tokenConfigured ? 'empty.accounts.action' : 'empty.connect')
  };
  if (!canChoose && cloud.tokenConfigured) {
    for (const emptyState of [resourceEmpty, accountEmpty]) Object.assign(emptyState, {
      emptyTitle: t(cloud.status === 'connecting' ? 'empty.connecting' : 'empty.unavailable'),
      emptyDescription: connection(cloud.status)[1],
      emptyAction: t('action.connectionSettings')
    });
  }
  if (route === 'overview') {
    const clearAttention = () => { overviewAttention = false; render(frame); };
    const attentionEmpty = (kind) => ({
      emptyTitle: t(`empty.attention.${kind}`),
      emptyDescription: t('empty.attention.description'),
      emptyAction: t('empty.attention.action')
    });
    renderCards($('overview-resources'), overviewAttention ? resources.filter(needsAttention) : resources, selectedMetrics, detail.open, overviewAttention ? clearAttention : choose, {
      ...(overviewAttention ? attentionEmpty('resources') : resourceEmpty),
      limit: overviewAttention ? undefined : 3,
      compact: !overviewAttention
    }, cloudTime());
    renderCards($('overview-accounts'), overviewAttention ? accounts.filter(needsAttention) : accounts, selectedMetrics, detail.open, overviewAttention ? clearAttention : choose, {
      ...(overviewAttention ? attentionEmpty('accounts') : accountEmpty),
      limit: overviewAttention ? undefined : 3,
      compact: !overviewAttention
    }, cloudTime());
    renderActivity($('overview-activity'), activity, true);
    renderUsage($('overview-usage'), usage);
  }
  if (route === 'resources') {
    const search = $('resource-search').value.trim().toLowerCase(),
      filter = $('resource-filter').value;
    const matches = resources.filter(
      (item) =>
        `${item.displayName} ${item.resourceType || item.kind}`.toLowerCase().includes(search) &&
        (filter === 'all' ||
          (filter === 'attention' ? needsAttention(item) : !needsAttention(item) && item.health === 'ok'))
    );
    text($('resources-heading'), t('resources.headingCount', { count: matches.length }));
    const filtered = search || filter !== 'all';
    const clear = () => {
      $('resource-search').value = '';
      $('resource-filter').value = 'all';
      render(frame);
    };
    renderCards(
      $('resource-cards'),
      matches,
      selectedMetrics,
      detail.open,
      filtered ? clear : choose,
      filtered
        ? {
          emptyTitle: t('empty.noResourceMatch'),
          emptyDescription: t('empty.noResourceMatchHelp'),
          emptyAction: t('empty.clearFilters')
        }
        : resourceEmpty,
      cloudTime()
    );
  }
  if (route === 'agents') {
    const search = $('agent-search').value.trim().toLowerCase();
    const previous = $('agent-filter').value;
    const providers = [...new Set(accounts.map((item) => item.provider))].sort();
    choices(
      $('agent-filter'),
      [
        ['all', t('agents.allProviders')],
        ...providers.map((provider) => [provider, providerName(provider)])
      ],
      previous === 'all' || providers.includes(previous) ? previous : 'all'
    );
    const filter = $('agent-filter').value;
    const matches = accounts.filter(
      (item) =>
        (filter === 'all' || item.provider === filter) &&
        `${item.displayName} ${item.account.displayName} ${item.account.id} ${item.provider} ${item.members.map((member) => member.agent.project).join(' ')}`
          .toLowerCase()
          .includes(search)
    );
    const filtered = search || filter !== 'all';
    const clear = () => {
      $('agent-search').value = '';
      $('agent-filter').value = 'all';
      render(frame);
    };
    renderCards(
      $('agent-cards'),
      matches,
      selectedMetrics,
      detail.open,
      filtered ? clear : choose,
      filtered
        ? {
          emptyTitle: t('empty.noAccountMatch'),
          emptyDescription: t('empty.noAccountMatchHelp'),
          emptyAction: t('empty.clearFilters')
        }
        : accountEmpty,
      cloudTime()
    );
    renderActivity(
      $('agent-activity'),
      activity.filter((item) => `${item.project} ${item.model || ''}`.toLowerCase().includes(search))
    );
    renderUsage($('agent-usage'), usage);
  }
  if (settingsPages.has(route)) preferences.render(value);
}
for (const button of document.querySelectorAll('[data-page-link]'))
  button.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(button.dataset.pageLink);
  });
for (const button of document.querySelectorAll('[data-web]'))
  button.addEventListener('click', () => run(button, () => request('open-web', button.dataset.web)));
for (const button of document.querySelectorAll('[data-selection]'))
  button.addEventListener('click', () => {
    detail.close();
    selection.open();
  });
for (const button of document.querySelectorAll('[data-close-dialog]'))
  button.addEventListener('click', () => $(button.dataset.closeDialog).close());
for (const id of ['resource-search', 'resource-filter', 'agent-search', 'agent-filter'])
  $(id).addEventListener('input', () => {
    if (frame) render(frame);
  });
$('overview-attention').addEventListener('click', () => {
  overviewAttention = !overviewAttention;
  if (frame) render(frame);
});
$('refresh').addEventListener('click', () =>
  run($('refresh'), async () => {
    const cloud = await request('refresh');
    if (cloud.status === 'connected') notify(t('toast.refreshed'));
  })
);
$('show-companion').addEventListener('click', () =>
  run($('show-companion'), () => request('show-companion'))
);
$('dismiss-error').addEventListener('click', () => {
  $('error').hidden = true;
});
const stopChanges = api.onChange(accept);
const stopVisibility = api.onVisibility((value) => {
  visible = value;
  detail.visibility(value);
  if (value && frame) render(frame);
  else preferences.leave();
  if (value) focusPage();
});
request('snapshot').then(accept).catch(fail);
window.addEventListener('beforeunload', () => {
  stopChanges();
  stopVisibility();
  detail.close();
  if (toastTimer) clearTimeout(toastTimer);
});
