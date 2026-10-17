/**
 * Desktop sign-in through VibeMon Web: OAuth authorization code with PKCE
 * (RFC 6749, RFC 7636) and a loopback redirect (RFC 8252).
 *
 * The App opens /authorize in the default browser. The person signs in with
 * Google or an invited email and selects Allow. Web then opens
 * http://127.0.0.1:{port}/auth/callback, which the App's local HTTP server
 * passes to complete(). The App exchanges the code with its verifier for an
 * API token. The verifier never leaves this process before the exchange.
 */

const { createHash, randomBytes } = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { webOrigin } = require('./domain.cjs');
const { CLOUD_REQUEST_TIMEOUT_MS, WEB_SIGN_IN_TIMEOUT_MS } = require('../shared/constants.cjs');

const CLIENT_ID = 'vibemon-desktop';
const TOKEN = /^vm_[a-f0-9]{60}$/;

// `reason` names the failure; the message is the sentence shown to people.
// (The workspace IPC shows `error.code` as a connection status, so it is not set.)
class SignInError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const base64url = buffer => buffer.toString('base64url');

class WebSignIn {
  /**
   * @param {object} options
   * @param {number} options.port - the local HTTP server port that receives the callback
   * @param {(url: string) => Promise<void>} options.openExternal
   * @param {typeof fetch} [options.fetchImpl]
   * @param {boolean} [options.allowLocalHttp] - development builds may use a loopback Web origin
   * @param {string} [options.deviceName] - shown in the token name on Web Account
   */
  constructor({ port, openExternal, fetchImpl = fetch, allowLocalHttp = false, deviceName = '', timeoutMs = WEB_SIGN_IN_TIMEOUT_MS }) {
    Object.assign(this, { port, openExternal, fetchImpl, allowLocalHttp, deviceName, timeoutMs });
    this.pending = null;
  }

  get redirectUri() {
    return `http://127.0.0.1:${this.port}/auth/callback`;
  }

  /**
   * Opens the browser and resolves with a token of `scope` for `url`.
   * A new sign-in replaces one that is still waiting.
   */
  async signIn(url, scope) {
    const origin = webOrigin(url, this.allowLocalHttp);
    if (!['read', 'write'].includes(scope)) throw new SignInError('invalid-scope', 'Unknown permission');
    this.cancel();
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const authorize = new URL('/authorize', origin);
    for (const [key, value] of Object.entries({
      client_id: CLIENT_ID, redirect_uri: this.redirectUri, scope, state, device_name: this.deviceName,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256'
    })) authorize.searchParams.set(key, value);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(state, new SignInError('timeout', 'Sign-in timed out. Try again.')), this.timeoutMs);
      this.pending = { state, resolve, reject, timer };
      Promise.resolve(this.openExternal(authorize.href)).catch(error => this.finish(state, new SignInError('browser', `Could not open the browser: ${error.message}`)));
    });
    return this.exchange(origin, code, verifier);
  }

  /** Stops a waiting sign-in. */
  cancel() {
    if (this.pending) this.finish(this.pending.state, new SignInError('cancelled', 'Sign-in was canceled.'));
  }

  /**
   * Handles the browser callback. Returns the text for the browser page.
   * Only a callback with the waiting state can finish a sign-in.
   * @param {URLSearchParams} params
   */
  complete(params) {
    const state = params.get('state');
    if (!this.pending || !state || state !== this.pending.state) {
      return { ok: false, message: 'This sign-in is not waiting anymore. Start it again in VibeMon.' };
    }
    if (params.get('error') === 'access_denied') {
      this.finish(state, new SignInError('denied', 'You selected Deny on VibeMon Web.'));
      return { ok: false, message: 'Sign-in was denied. You can close this tab.' };
    }
    const code = params.get('code');
    if (!code || code.length > 100) {
      this.finish(state, new SignInError('invalid-callback', 'The sign-in did not finish. Try again.'));
      return { ok: false, message: 'The sign-in did not finish. Start it again in VibeMon.' };
    }
    this.finish(state, null, code);
    return { ok: true, message: 'Signed in. Return to VibeMon; you can close this tab.' };
  }

  finish(state, error, code) {
    const pending = this.pending;
    if (!pending || pending.state !== state) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (error) pending.reject(error); else pending.resolve(code);
  }

  async exchange(origin, code, verifier) {
    let response;
    try {
      response = await this.fetchImpl(new URL('/api/oauth/token', origin), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: this.redirectUri })
      });
    } catch {
      throw new SignInError('unreachable', 'Cannot reach VibeMon Web. Check the network and try again.');
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body.access_token === 'string' && TOKEN.test(body.access_token)) return body.access_token;
    if (body.error === 'invalid_grant') throw new SignInError('expired', 'The sign-in expired. Try again.');
    throw new SignInError('rejected', `VibeMon Web did not finish the sign-in (HTTP ${response.status}).`);
  }
}

module.exports = { WebSignIn, SignInError, CLIENT_ID };
