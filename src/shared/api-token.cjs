/** Web API tokens: `vm_` followed by 60 lowercase hex digits. Read and write tokens share this format. */
const { CLOUD_REQUEST_TIMEOUT_MS } = require('./constants.cjs');

const API_TOKEN = /^vm_[a-f0-9]{60}$/;
const API_TOKEN_ANYWHERE = /vm_[a-f0-9]{60}/g;

const isApiToken = value => typeof value === 'string' && API_TOKEN.test(value);
const redactApiTokens = text => String(text).replace(API_TOKEN_ANYWHERE, '[redacted]');

/**
 * Deletes `token` on Web (`DELETE /api/v1/connection`). Web deletes the token
 * that sends the request, for read and write scope. Never throws.
 * @returns {Promise<boolean>} true when Web deleted the token or no longer accepts it
 */
async function revokeApiToken(fetchImpl, origin, token) {
  try {
    const response = await fetchImpl(`${origin}/api/v1/connection`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
    });
    await response.body?.cancel();
    return response.status === 204 || response.status === 401;
  } catch {
    return false;
  }
}

module.exports = { isApiToken, redactApiTokens, revokeApiToken };
