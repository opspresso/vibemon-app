const { validText } = require('../shared/resource-schema.cjs');
const { t } = require('../shared/i18n/locale.cjs');

const PROVIDERS = new Set(['google', 'apple', 'email']);

/** Only displayable sign-in metadata crosses the renderer boundary. */
function validateAccountProfile(value) {
  if (!value || !Array.isArray(value.identities) || value.identities.length > 64) throw new Error(t('account.invalidResponse'));
  return {
    identities: value.identities.map(identity => {
      if (!identity || !PROVIDERS.has(identity.provider) || !validText(identity.label, 320) || typeof identity.primary !== 'boolean') {
        throw new Error(t('account.invalidResponse'));
      }
      return { provider: identity.provider, label: identity.label, primary: identity.primary };
    })
  };
}

async function accountProfile(monitoring) {
  const revision = monitoring.generation;
  const value = await monitoring.request('/api/v1/account');
  if (revision !== monitoring.generation) throw new Error(t('error.connectionChanged'));
  return validateAccountProfile(value);
}

module.exports = { accountProfile, validateAccountProfile };
