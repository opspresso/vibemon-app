import { $, text, hydrateIcons, connection, choices, configureSprites, ago, providerName } from './dom.js';
import { renderCards, renderActivity, renderUsage, accountCard, needsAttention } from './views/cards.js';
import { setupPreferences } from './views/preferences.js';
import { setupSelection } from './views/selection.js';
import { setupDetail } from './views/detail.js';

const api = window.workspace;
const pages = {
  overview: ['Overview', 'A clear view of your systems and coding activity.'],
  resources: ['Resources', 'Follow the systems that keep your work running.'],
  agents: ['Coding agents', 'Your accounts, usage, and local activity in one place.'],
  connections: ['Settings', 'A workspace that fits the way you work.'],
  companion: ['Settings', 'A workspace that fits the way you work.'],
  integrations: ['Settings', 'A workspace that fits the way you work.'],
  about: ['Settings', 'A workspace that fits the way you work.']
};
const settingsPages = new Set(['connections', 'companion', 'integrations', 'about']);
let frame = null;
let toastTimer = null;
let visible = true;
let pageFocusPending = false;
let preferences, selection, detail;
document.documentElement.dataset.platform = api.platform;
hydrateIcons();

async function request(command, ...args) {
  const response = await api.request(command, ...args);
  if (!response.ok) {
    const known = [
      'token-expired',
      'permission-denied',
      'credential-unavailable',
      'secure-storage-unavailable',
      'connection-error',
      'not-configured'
    ];
    throw new Error(known.includes(response.error) ? connection(response.error)[1] : response.error);
  }
  if (command === 'settings') {
    accept(response.value.frame);
    return response.value.result;
  }
  return response.value;
}
function fail(error) {
  const message = error.message || 'The request could not be completed.';
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
async function run(control, action) {
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
    fail(error);
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
const shared = { getFrame: () => frame, request, run, notify, navigate, fail };
preferences = setupPreferences(shared);
selection = setupSelection(shared);
detail = setupDetail(shared);

function accept(value) {
  const pageChanged = Boolean(frame && frame.route !== value.route);
  if (pageChanged) pageFocusPending = true;
  if (frame && frame.cloud.connectionRevision !== value.cloud.connectionRevision) {
    detail.close();
    selection.close();
    for (const id of ['overview-resources', 'overview-accounts', 'resource-cards', 'agent-cards']) {
      const container = $(id);
      container.replaceChildren();
      container._items = new Map();
      container._empty = false;
    }
  }
  if (frame && frame.route !== value.route) {
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

function render(value) {
  const { cloud, settings, activity, usage } = value;
  const route = pages[value.route] ? value.route : 'overview';
  document.documentElement.dataset.page = route;
  configureSprites(settings.options.characters);
  text($('page-title'), pages[route][0]);
  $('page-title').setAttribute('aria-label', settingsPages.has(route) ? `Settings: ${route.charAt(0).toUpperCase()}${route.slice(1)}` : pages[route][0]);
  text($('page-description'), pages[route][1]);
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
  const [label, description, tone] = connection(cloud.status);
  text($('connection-chip'), label);
  $('connection-chip').className = `chip ${tone}`;
  text($('sidebar-status'), label);
  $('sidebar-dot').className = `status-dot ${tone}`;
  let host = 'Your cloud workspace';
  try {
    host = new URL(cloud.url).host;
  } catch {
    host = 'Check Web address';
  }
  text($('sidebar-host'), host);
  $('connection-notice').hidden = cloud.status === 'connected' || route === 'connections';
  text(
    $('connection-notice-title'),
    cloud.status === 'not-configured' ? 'Connect your cloud workspace' : label
  );
  text($('connection-notice-description'), description);
  const resources = cloud.sources.filter((source) => source.kind !== 'agent');
  const accounts = cloud.accounts.map(accountCard);
  const active = activity.filter((item) =>
    ['working', 'thinking', 'planning', 'packing'].includes(item.state)
  );
  const attention =
    resources.filter(needsAttention).length +
    accounts.filter((account) => account.members.some(needsAttention)).length;
  text($('nav-resources'), resources.length);
  text($('nav-agents'), accounts.length);
  text($('summary-resources'), resources.length);
  text($('summary-accounts'), accounts.length);
  text($('summary-local'), activity.length);
  text($('summary-attention'), attention);
  text(
    $('summary-resource-note'),
    resources.length
      ? `${resources.filter((item) => !needsAttention(item) && item.health === 'ok').length} healthy · ${resources.filter(needsAttention).length} need attention`
      : 'Choose the systems you follow'
  );
  text(
    $('summary-account-note'),
    accounts.length
      ? `${new Set(accounts.map((item) => item.provider)).size} providers connected`
      : 'Connect an account to get started'
  );
  text($('summary-local-note'), `${active.length} active on this device`);
  text($('summary-attention-note'), attention ? 'Review highlighted sources' : 'No reported issues');
  $('settings-attention').hidden =
    !settings.vibemonConfig.status.error &&
    !settings.hooks.some((tool) => tool.present && (tool.broken || tool.changed)) &&
    !['available', 'downloaded'].includes(settings.update.status);
  text(
    $('last-sync'),
    cloud.lastSyncedAt
      ? `Cloud checked ${ago(cloud.lastSyncedAt).toLowerCase()} · local activity on this device`
      : 'Local activity works without a cloud connection.'
  );
  text($('footer-version'), settings.version);
  const selectedMetrics = new Set(cloud.selectedMetrics);
  const choose = () => (cloud.tokenConfigured ? selection.open() : navigate('connections'));
  const resourceEmpty = {
    emptyTitle:
      cloud.status === 'not-configured' ? 'Bring your resources into view' : 'No resources in this view',
    emptyDescription: cloud.tokenConfigured
      ? 'Select resources, or start a collector in this workspace.'
      : 'Connect your Web workspace to follow servers, clusters, and any custom resource.',
    emptyAction: cloud.tokenConfigured ? 'Choose resources' : 'Connect workspace'
  };
  const accountEmpty = {
    emptyTitle: 'No cloud accounts selected',
    emptyDescription: 'Connect provider accounts on Web, then choose the ones to follow here.',
    emptyAction: cloud.tokenConfigured ? 'Choose accounts' : 'Connect workspace'
  };
  if (route === 'overview') {
    renderCards($('overview-resources'), resources, selectedMetrics, detail.open, choose, {
      ...resourceEmpty,
      limit: 3,
      compact: true
    });
    renderCards($('overview-accounts'), accounts, selectedMetrics, detail.open, choose, {
      ...accountEmpty,
      limit: 3,
      compact: true
    });
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
    text($('resources-heading'), `Your resources · ${matches.length}`);
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
          emptyTitle: 'No matching resources',
          emptyDescription: 'Try a different name or status filter.',
          emptyAction: 'Clear filters'
        }
        : resourceEmpty
    );
  }
  if (route === 'agents') {
    const search = $('agent-search').value.trim().toLowerCase();
    const previous = $('agent-filter').value;
    const providers = [...new Set(accounts.map((item) => item.provider))].sort();
    choices(
      $('agent-filter'),
      [
        ['all', 'All providers'],
        ...providers.map((provider) => [provider, providerName(provider)])
      ],
      previous === 'all' || providers.includes(previous) ? previous : 'all'
    );
    const filter = $('agent-filter').value;
    const matches = accounts.filter(
      (item) =>
        (filter === 'all' || item.provider === filter) &&
        `${item.displayName} ${item.provider} ${item.members.map((member) => member.agent.project).join(' ')}`
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
          emptyTitle: 'No matching accounts',
          emptyDescription: 'Try a different account, project, or provider.',
          emptyAction: 'Clear filters'
        }
        : accountEmpty
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
$('refresh').addEventListener('click', () =>
  run($('refresh'), async () => {
    const cloud = await request('refresh');
    if (cloud.status === 'connected') notify('Workspace refreshed');
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
