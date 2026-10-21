/**
 * Desktop sign-in through VibeMon Web: OAuth authorization code with PKCE
 * (RFC 6749, RFC 7636) and a loopback redirect (RFC 8252).
 *
 * The App opens /authorize in the default browser. The person signs in with
 * Google, Apple, or an email account and selects Allow. Web then opens
 * http://127.0.0.1:{port}/auth/callback, which the App's local HTTP server
 * passes to complete(). The App exchanges the code with its verifier for an
 * API token. The verifier never leaves this process before the exchange.
 */

const { createHash, randomBytes } = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { webOrigin } = require('./domain.cjs');
const { CLOUD_REQUEST_TIMEOUT_MS, CLOUD_CONNECTION_MAX_RESPONSE_BYTES, WEB_SIGN_IN_TIMEOUT_MS } = require('../shared/constants.cjs');
const { readJsonResponse } = require('../shared/json-response.cjs');
const { t } = require('../shared/i18n/locale.cjs');
const { isApiToken, revokeApiToken } = require('../shared/api-token.cjs');

const CLIENT_ID = 'vibemon-desktop';

// `reason` names the failure; the message is the sentence shown to people, in the App language.
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
   * @param {() => boolean} [options.canReceive] - whether the local HTTP server listens for the callback
   */
  constructor({ port, openExternal, fetchImpl = fetch, allowLocalHttp = false, deviceName = '', timeoutMs = WEB_SIGN_IN_TIMEOUT_MS, canReceive = () => true }) {
    Object.assign(this, { port, openExternal, fetchImpl, allowLocalHttp, deviceName, timeoutMs, canReceive });
    this.pending = null;
    this.active = null;
  }

  get redirectUri() {
    return `http://127.0.0.1:${this.port}/auth/callback`;
  }

  /**
   * Opens the browser, gets a token of `scope` for `url`, and resolves with
   * the result of `adopt(token, signal)`. The adopter must check `signal`
   * before saving the connection. When `adopt` fails, nothing keeps the new
   * token, so it is deleted on Web before the error returns.
   * A new sign-in cancels the previous attempt, including exchange and verification.
   */
  async signIn(url, scope, adopt) {
    const origin = webOrigin(url, this.allowLocalHttp);
    if (!['read', 'write'].includes(scope)) throw new SignInError('invalid-scope', t('signIn.unknownScope'));
    // Without the callback server, the browser cannot return and the sign-in could only time out.
    if (!this.canReceive()) throw new SignInError('no-callback', t('signIn.noCallback', { port: this.port }));
    this.cancel();
    const controller = new globalThis.AbortController();
    this.active = controller;
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const authorize = new URL('/authorize', origin);
    for (const [key, value] of Object.entries({
      client_id: CLIENT_ID, redirect_uri: this.redirectUri, scope, state, device_name: this.deviceName,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256'
    })) authorize.searchParams.set(key, value);
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.finish(state, new SignInError('timeout', t('signIn.timeout'))), this.timeoutMs);
        this.pending = { state, resolve, reject, timer };
        Promise.resolve(this.openExternal(authorize.href)).catch(error => this.finish(state, new SignInError('browser', t('signIn.browser', { error: error.message }))));
      });
      controller.signal.throwIfAborted();
      // Let the bounded exchange finish so a cancelled attempt can delete any issued token.
      const token = await this.exchange(origin, code, verifier);
      try {
        controller.signal.throwIfAborted();
        return await adopt(token, controller.signal);
      } catch (error) {
        await revokeApiToken(this.fetchImpl, origin, token);
        throw error;
      }
    } catch (error) {
      // Aborted fetch bodies can report a transport error instead of the signal's reason.
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      if (this.active === controller) this.active = null;
    }
  }

  /** Cancels the current sign-in through its final connection verification. */
  cancel() {
    const error = new SignInError('cancelled', t('signIn.cancelled'));
    this.active?.abort(error);
    if (this.pending) this.finish(this.pending.state, error);
  }

  /**
   * Handles the browser callback. Returns the text for the browser page.
   * Only a callback with the waiting state can finish a sign-in.
   * @param {URLSearchParams} params
   */
  complete(params) {
    const state = params.get('state');
    if (!this.pending || !state || state !== this.pending.state) {
      return { ok: false, message: t('signIn.page.notWaiting') };
    }
    if (params.get('error') === 'access_denied') {
      this.finish(state, new SignInError('denied', t('signIn.denied')));
      return { ok: false, message: t('signIn.page.denied') };
    }
    const code = params.get('code');
    if (!code || code.length > 100) {
      this.finish(state, new SignInError('invalid-callback', t('signIn.unfinished')));
      return { ok: false, message: t('signIn.page.unfinished') };
    }
    this.finish(state, null, code);
    return { ok: true, message: t('signIn.page.done') };
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
      throw new SignInError('unreachable', t('signIn.unreachable'));
    }
    // An unreadable or oversized body is a rejected sign-in, reported by status below.
    const body = await readJsonResponse(response, CLOUD_CONNECTION_MAX_RESPONSE_BYTES).catch(() => ({}));
    if (response.ok && isApiToken(body.access_token)) return body.access_token;
    if (body.error === 'invalid_grant') throw new SignInError('expired', t('signIn.expired'));
    throw new SignInError('rejected', t('signIn.rejected', { status: response.status }));
  }
}

module.exports = { WebSignIn, SignInError };
