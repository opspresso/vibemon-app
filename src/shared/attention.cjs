/**
 * Where each issue is shown.
 *
 * The tray menu, the workspace sidebar, and the settings tabs read the same
 * areas, so every badge names the place that resolves it. Inputs are the
 * workspace frame sections: the monitoring snapshot and the settings snapshot.
 */
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

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const CONNECTION_NOTICES = {
  'token-expired': 'Read token rejected',
  'permission-denied': 'Read permission required',
  'credential-unavailable': 'Saved token unavailable',
  'secure-storage-unavailable': 'Secure storage is locked'
};

/**
 * One short sentence per area that needs the user, or null when it is quiet.
 * @param {ReturnType<typeof attentionAreas>} areas
 * @returns {{dashboard: string|null, connection: string|null, integrations: string|null, update: string|null}}
 */
function attentionNotices(areas) {
  const sources = [
    areas.resources && count(areas.resources, 'resource'),
    areas.accounts && count(areas.accounts, 'coding account')
  ].filter(Boolean);
  const total = areas.resources + areas.accounts;
  const { repairs, config, delivery } = areas.integrations;
  const broken = repairs.filter(tool => tool.broken).map(tool => tool.name);
  const outdated = repairs.filter(tool => !tool.broken).map(tool => tool.name);
  const integrations = [
    broken.length && `${broken.join(', ')} ${broken.length === 1 ? 'needs' : 'need'} repair`,
    outdated.length && `${outdated.join(', ')} ${outdated.length === 1 ? 'has an update' : 'have updates'}`,
    config && 'Local delivery settings need repair',
    delivery && 'Cloud delivery check failed'
  ].filter(Boolean);
  return {
    dashboard: total ? `${sources.join(' · ')} ${total === 1 ? 'needs' : 'need'} attention` : null,
    connection: areas.connection ? CONNECTION_NOTICES[areas.connection] || 'Cloud connection interrupted' : null,
    integrations: integrations.length ? integrations.join(' · ') : null,
    update: areas.update ? `Version ${areas.update.version} ${areas.update.status === 'downloaded' ? 'is ready to install' : 'is available'}` : null
  };
}

const integrationsNeedAttention = ({ integrations }) => integrations.repairs.length > 0 || integrations.config || integrations.delivery;
const settingsNeedAttention = areas => Boolean(areas.connection || areas.update) || integrationsNeedAttention(areas);

module.exports = { attentionAreas, attentionNotices, integrationsNeedAttention, settingsNeedAttention };
