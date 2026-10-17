/**
 * Where each issue is shown.
 *
 * The tray menu, the workspace sidebar, and the settings tabs read the same
 * areas, so every badge names the place that resolves it. Inputs are the
 * workspace frame sections: the monitoring snapshot and the settings snapshot.
 */
const { t } = require('./i18n/locale.cjs');

const QUIET_CONNECTIONS = new Set(['connected', 'connecting', 'not-configured']);
const ACTIONABLE_UPDATES = new Set(['available', 'downloaded']);

/**
 * @param {{status: string, sources: Array<{kind: string, needsAttention: boolean}>, accounts: Array<{needsAttention: boolean}>}} cloud
 * @param {{hooks: Array<{name: string, present: boolean, broken: boolean, changed: boolean}>,
 *          vibemonConfig: {status: {error?: string}}, cloudDelivery: {status: string},
 *          update: {status: string|null, version: string|null}}} settings
 */
function attentionAreas(cloud, settings) {
  return {
    // A rejected or unreachable read connection; resolved on Connections.
    connection: QUIET_CONNECTIONS.has(cloud.status) ? null : cloud.status,
    // Selected cloud sources whose state needs the user; shown on Dashboard.
    resources: cloud.sources.filter(source => source.kind !== 'agent' && source.needsAttention).length,
    accounts: cloud.accounts.filter(account => account.needsAttention).length,
    // Local delivery problems; resolved on Integrations.
    integrations: {
      repairs: settings.hooks.filter(tool => tool.present && (tool.broken || tool.changed))
        .map(tool => ({ name: tool.name, broken: Boolean(tool.broken) })),
      config: Boolean(settings.vibemonConfig.status.error),
      delivery: settings.cloudDelivery.status === 'error'
    },
    // An update the user can download or install; resolved on About.
    update: ACTIONABLE_UPDATES.has(settings.update.status) ? { ...settings.update } : null
  };
}

const CONNECTION_NOTICES = {
  'token-expired': 'notice.tokenExpired',
  'permission-denied': 'notice.permissionDenied',
  'credential-unavailable': 'notice.credentialUnavailable',
  'secure-storage-unavailable': 'notice.secureStorageLocked'
};
const names = list => list.join(t('list.separator'));

/**
 * One short sentence per area that needs the user, or null when it is quiet,
 * in the App language (see i18n/locale.cjs). Web words these the same way
 * with the shared attention.* and count.* messages.
 * @param {ReturnType<typeof attentionAreas>} areas
 * `resources`, `accounts`, and `where` describe the parts of `dashboard`.
 * @returns {{dashboard: string|null, resources: string|null, accounts: string|null, where: string,
 *            connection: string|null, integrations: string|null, update: string|null}}
 */
function attentionNotices(areas) {
  const { resources, accounts } = areas;
  const { repairs, config, delivery } = areas.integrations;
  const broken = repairs.filter(tool => tool.broken).map(tool => tool.name);
  const outdated = repairs.filter(tool => !tool.broken).map(tool => tool.name);
  const integrations = [
    broken.length && t('notice.needsRepair', { count: broken.length, names: names(broken) }),
    outdated.length && t('notice.hasUpdates', { count: outdated.length, names: names(outdated) }),
    config && t('notice.configRepair'),
    delivery && t('notice.deliveryFailed')
  ].filter(Boolean);
  const resourceNotice = resources ? t('attention.resources', { count: resources }) : null;
  const accountNotice = accounts ? t('attention.accounts', { count: accounts }) : null;
  return {
    dashboard: resources && accounts
      ? t('attention.mixed', { resources: t('count.resources', { count: resources }), accounts: t('count.codingAccounts', { count: accounts }) })
      : resourceNotice || accountNotice,
    resources: resourceNotice,
    accounts: accountNotice,
    where: [resources && t('count.resources', { count: resources }), accounts && t('count.accounts', { count: accounts })].filter(Boolean).join(' · '),
    connection: areas.connection ? t(CONNECTION_NOTICES[areas.connection] || 'notice.connectionInterrupted') : null,
    integrations: integrations.length ? integrations.join(' · ') : null,
    update: areas.update ? t(areas.update.status === 'downloaded' ? 'notice.updateReady' : 'notice.updateAvailable', { version: areas.update.version }) : null
  };
}

module.exports = { attentionAreas, attentionNotices };
