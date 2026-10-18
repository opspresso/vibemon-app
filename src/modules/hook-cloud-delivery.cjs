const { webOrigin, sameWebOrigin } = require('../shared/web-origin.cjs');
const { readJsonResponse } = require('../shared/json-response.cjs');
const { t } = require('../shared/i18n/locale.cjs');
const { isApiToken, revokeApiToken } = require('../shared/api-token.cjs');
const { CLOUD_REQUEST_TIMEOUT_MS, CLOUD_CONNECTION_MAX_RESPONSE_BYTES } = require('../shared/constants.cjs');

const sameConnection = (a, b) => a.vibemon_url === b.vibemon_url && a.vibemon_token === b.vibemon_token;

class HookCloudDelivery {
  constructor({ configManager, fetchImpl = fetch, allowLocalHttp = false, now = Date.now }) {
    Object.assign(this, { configManager, fetchImpl, allowLocalHttp, now });
    this.busy = false;
    this.result = null;
    this.onChange = null;
  }

  snapshot() {
    const current = this.configManager.read();
    const result = this.result && sameConnection(this.result, current) ? this.result : null;
    let url = '', addressError = '';
    try { url = webOrigin(current.vibemon_url, this.allowLocalHttp); }
    catch { addressError = t('delivery.savedAddressInvalid'); }
    return {
      url, tokenConfigured: Boolean(current.vibemon_token), busy: this.busy,
      status: this.busy ? 'checking' : addressError ? 'error' : !current.vibemon_token ? 'not-configured' : result?.status || 'not-verified',
      checkedAt: result?.checkedAt || null, error: addressError || result?.error || ''
    };
  }

  async verify(url, token) {
    const origin = webOrigin(url, this.allowLocalHttp);
    if (!isApiToken(token)) throw new Error(t('delivery.tokenFormat'));
    let response;
    try {
      response = await this.fetchImpl(`${origin}/api/v1/connection?scope=write`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
      });
    } catch { throw new Error(t('delivery.unreachable')); }
    if (!response.ok) {
      await response.body?.cancel();
      const messages = { 401: 'delivery.rejected', 403: 'delivery.forbidden', 404: 'delivery.unsupported', 429: 'delivery.rateLimited' };
      throw new Error(t(messages[response.status] || 'delivery.unavailable'));
    }
    const value = await readJsonResponse(response, CLOUD_CONNECTION_MAX_RESPONSE_BYTES);
    if (value?.connected !== true || value.scope !== 'write') throw new Error(t('delivery.unexpected'));
    return origin;
  }

  async run(action) {
    if (this.busy) throw new Error(t('delivery.inProgress'));
    this.busy = true;
    this.onChange?.();
    try { return await action(); }
    finally { this.busy = false; this.onChange?.(); }
  }

  async configure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || typeof value.token !== 'string' || Object.keys(value).some(key => !['url', 'token'].includes(key))) throw new Error(t('delivery.missingFields'));
    const origin = webOrigin(value.url.trim(), this.allowLocalHttp);
    const current = this.configManager.read();
    const replacement = value.token.trim();
    if (!replacement && !sameWebOrigin(origin, current.vibemon_url, this.allowLocalHttp)) throw new Error(t('delivery.tokenForNewAddress'));
    const token = replacement || current.vibemon_token;
    return this.run(async () => {
      await this.verify(origin, token);
      if (!sameConnection(current, this.configManager.read())) throw new Error(t('delivery.changed'));
      this.configManager.write({ vibemon_url: origin, vibemon_token: token });
      this.result = { vibemon_url: origin, vibemon_token: token, status: 'verified', checkedAt: new Date(this.now()).toISOString() };
      if (current.vibemon_token && current.vibemon_token !== token) this.revoke(current);
      return true;
    });
  }

  async check() {
    const current = this.configManager.read();
    return this.run(async () => {
      try {
        await this.verify(current.vibemon_url, current.vibemon_token);
        if (!sameConnection(current, this.configManager.read())) throw new Error(t('delivery.changed'));
        this.result = { vibemon_url: current.vibemon_url, vibemon_token: current.vibemon_token, status: 'verified', checkedAt: new Date(this.now()).toISOString() };
        return true;
      } catch (error) {
        this.result = { vibemon_url: current.vibemon_url, vibemon_token: current.vibemon_token, status: 'error', checkedAt: new Date(this.now()).toISOString(), error: error.message };
        throw error;
      }
    });
  }

  /**
   * Removes the saved write token, then deletes it on Web.
   * `tokenDeleted` is false when Web could not delete it; the token then stays
   * valid until it is deleted on Web Account.
   */
  async disconnect() {
    if (this.busy) throw new Error(t('delivery.wait'));
    const current = this.configManager.read();
    this.configManager.write({ vibemon_token: '' });
    this.result = null;
    this.onChange?.();
    return { tokenDeleted: current.vibemon_token ? await this.revoke(current) : true };
  }

  /** Deletes a token that config.json no longer holds. A saved address that is invalid cannot be used. */
  revoke({ vibemon_url: url, vibemon_token: token }) {
    let origin;
    try { origin = webOrigin(url, this.allowLocalHttp); } catch { return Promise.resolve(false); }
    return revokeApiToken(this.fetchImpl, origin, token);
  }
}
module.exports = { HookCloudDelivery };
