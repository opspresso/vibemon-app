const { webOrigin, sameWebOrigin } = require('../shared/web-origin.cjs');
const { readJsonResponse } = require('../shared/json-response.cjs');
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
    return {
      url: current.vibemon_url, tokenConfigured: Boolean(current.vibemon_token), busy: this.busy,
      status: this.busy ? 'checking' : !current.vibemon_token ? 'not-configured' : result?.status || 'not-verified',
      checkedAt: result?.checkedAt || null, error: result?.error || ''
    };
  }

  async verify(url, token) {
    const origin = webOrigin(url, this.allowLocalHttp);
    if (typeof token !== 'string' || !/^vm_[a-f0-9]{60}$/.test(token)) throw new Error('Paste a generated write token from Web Account');
    let response;
    try {
      response = await this.fetchImpl(`${origin}/api/v1/connection?scope=write`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
      });
    } catch { throw new Error('Cannot reach Web. Check the address and your connection'); }
    if (!response.ok) {
      await response.body?.cancel();
      const messages = {
        401: 'Write token was rejected. Retrieve an active token from Web Account',
        403: 'This token cannot send data. Use a token with write permission',
        404: 'This Web server does not support connection checks. Update Web before connecting',
        429: 'Too many connection checks. Wait a minute and try again'
      };
      throw new Error(messages[response.status] || 'Web could not verify the connection. Try again when the service is available');
    }
    const value = await readJsonResponse(response, CLOUD_CONNECTION_MAX_RESPONSE_BYTES);
    if (value?.connected !== true || value.scope !== 'write') throw new Error('Unexpected connection response. Check the Web address');
    return origin;
  }

  async run(action) {
    if (this.busy) throw new Error('A cloud connection check is already in progress');
    this.busy = true;
    this.onChange?.();
    try { return await action(); }
    finally { this.busy = false; this.onChange?.(); }
  }

  async configure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || typeof value.token !== 'string' || Object.keys(value).some(key => !['url', 'token'].includes(key))) throw new Error('Enter a Web address and write token');
    const origin = webOrigin(value.url.trim(), this.allowLocalHttp);
    const current = this.configManager.read();
    const replacement = value.token.trim();
    if (!replacement && !sameWebOrigin(origin, current.vibemon_url, this.allowLocalHttp)) throw new Error('Enter a new write token when changing the Web address');
    const token = replacement || current.vibemon_token;
    return this.run(async () => {
      await this.verify(origin, token);
      if (!sameConnection(current, this.configManager.read())) throw new Error('Cloud settings changed while checking. Review them and try again');
      this.configManager.write({ vibemon_url: origin, vibemon_token: token });
      this.result = { vibemon_url: origin, vibemon_token: token, status: 'verified', checkedAt: new Date(this.now()).toISOString() };
      return true;
    });
  }

  async check() {
    const current = this.configManager.read();
    return this.run(async () => {
      try {
        await this.verify(current.vibemon_url, current.vibemon_token);
        if (!sameConnection(current, this.configManager.read())) throw new Error('Cloud settings changed while checking. Review them and try again');
        this.result = { vibemon_url: current.vibemon_url, vibemon_token: current.vibemon_token, status: 'verified', checkedAt: new Date(this.now()).toISOString() };
        return true;
      } catch (error) {
        this.result = { vibemon_url: current.vibemon_url, vibemon_token: current.vibemon_token, status: 'error', checkedAt: new Date(this.now()).toISOString(), error: error.message };
        throw error;
      }
    });
  }

  disconnect() {
    if (this.busy) throw new Error('Wait for the current connection check to finish');
    this.configManager.write({ vibemon_token: '' });
    this.result = null;
    this.onChange?.();
    return true;
  }
}
module.exports = { HookCloudDelivery };
