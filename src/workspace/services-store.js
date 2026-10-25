// Connected-service state without the DOM, so its rules can be tested alone.
// `request(command, ...args)` is the workspace IPC request: it resolves with
// the value or throws an Error whose `code` is Web's usage failure code.

// The server reads a service at most every 5 minutes, so a minute only picks up its newest reading.
export const USAGE_POLL_MS = 60000;
// Web ends a Claude sign-in after its fifth rejected code.
export const MAX_CODES = 5;
// These failures end the sign-in in progress; it must start again.
const ENDS_SIGN_IN = new Set(['usage-authorization-expired', 'usage-authorization-denied', 'usage-sign-in-required', 'usage-connection-limit']);
export const endsSignIn = code => ENDS_SIGN_IN.has(code);
const SERVICES = ['claude', 'codex'];

/**
 * The connections of the current VibeMon connection. Results of an earlier
 * connection are discarded. Polling runs only while a page shows them.
 */
export class UsageStore {
  constructor({ request, onChange = () => {}, clock = () => globalThis.performance.now(), timers = globalThis, pollMs = USAGE_POLL_MS }) {
    Object.assign(this, { request, onChange, clock, timers, pollMs });
    this.revision = null;
    this.active = false;
    this.timer = null;
    this.loading = null;
    this.reset();
  }

  reset() {
    this.snapshot = null;
    this.anchor = null;
    this.error = null;
    this.busy = new Set();
    this.actionErrors = new Map();
  }

  /** The server time now; the device clock before the first answer. */
  now() {
    return this.anchor ? this.anchor.time + Math.max(0, this.clock() - this.anchor.received) : Date.now();
  }

  get connections() { return this.snapshot?.connections ?? []; }
  /** The services that this VibeMon address can connect. */
  get providers() { return this.snapshot?.providers?.length ? this.snapshot.providers : SERVICES; }

  /** Follows the VibeMon connection: a new revision forgets the previous connection's data. */
  follow(revision) {
    if (revision === this.revision) return;
    this.revision = revision;
    this.reset();
    if (this.active) this.load();
  }

  /** Polls every `pollMs` while `active`; becoming active loads at once. */
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
    if (!active) return;
    this.load();
    this.timer = this.timers.setInterval(() => this.load(), this.pollMs);
  }

  /** Reads the connections once; a load of the same connection already running is shared. */
  load() {
    if (this.loading?.revision === this.revision) return this.loading.promise;
    const revision = this.revision;
    const promise = (async () => {
      try {
        const value = await this.request('usage');
        if (revision !== this.revision) return;
        this.snapshot = value;
        this.anchor = { time: Date.parse(value.serverTime), received: this.clock() };
        this.error = null;
      } catch (error) {
        if (revision === this.revision) this.error = error.message;
      } finally {
        if (this.loading?.promise === promise) this.loading = null;
      }
      if (revision === this.revision) this.onChange();
    })();
    this.loading = { revision, promise };
    return promise;
  }

  /** Adds or replaces a connection that a sign-in or a refresh returned. */
  accept(connection) {
    if (!this.snapshot) return;
    const known = this.snapshot.connections.some(item => item.id === connection.id);
    this.snapshot = {
      ...this.snapshot,
      connections: known ? this.snapshot.connections.map(item => item.id === connection.id ? connection : item) : [...this.snapshot.connections, connection]
    };
  }

  /** Asks the server for a new reading of one connection. */
  refresh(id) {
    return this.act(id, async () => this.accept(await this.request('usage-refresh', id)));
  }

  /** Deletes the connection's sign-in and readings on the server. */
  disconnect(id) {
    return this.act(id, async () => {
      await this.request('usage-disconnect', id);
      if (this.snapshot) this.snapshot = { ...this.snapshot, connections: this.snapshot.connections.filter(item => item.id !== id) };
    });
  }

  /** Runs one action per connection; its failure stays with that connection. Resolves true on success. */
  async act(id, operation) {
    if (this.busy.has(id)) return false;
    const revision = this.revision;
    this.busy.add(id);
    this.actionErrors.delete(id);
    this.onChange();
    try {
      await operation();
      return revision === this.revision;
    } catch (error) {
      if (revision === this.revision) this.actionErrors.set(id, error.message);
      return false;
    } finally {
      if (revision === this.revision) this.busy.delete(id);
      this.onChange();
    }
  }

  stop() { this.setActive(false); }
}

/**
 * One sign-in to a service, from start to a saved connection.
 *
 * Claude: the person opens the service page, approves, and pastes the code.
 * Codex: the person enters the shown code on the service page while this
 * flow polls VibeMon at the interval that the server returns. Closing the
 * flow abandons an unfinished sign-in on the server.
 */
export class UsageConnectFlow {
  /** `describe(code)` is the sentence for a usage failure code that the flow reports itself. */
  constructor({ request, onChange = () => {}, onConnected = () => {}, describe = code => code, timers = globalThis }) {
    Object.assign(this, { request, onChange, onConnected, describe, timers });
    this.generation = 0;
    this.poll = null;
    this.provider = 'claude';
    this.error = null;
    this.restart();
  }

  /** Back to the service choice; nothing is cancelled on the server. */
  restart() {
    this.generation++;
    if (this.poll) this.timers.clearTimeout(this.poll);
    this.poll = null;
    this.phase = 'choose';
    this.authorization = null;
    this.connection = null;
    this.rejected = 0;
    this.waiting = false;
    this.submitting = false;
  }

  fail(error) {
    this.error = error ? { message: error.message, code: error.code ?? null } : null;
    if (error && endsSignIn(error.code) && this.phase !== 'connected') {
      const provider = this.provider;
      this.restart();
      this.provider = provider;
    }
  }

  open(provider) {
    this.restart();
    this.provider = SERVICES.includes(provider) ? provider : 'claude';
    this.error = null;
    this.onChange();
  }

  choose(provider) {
    if (this.phase !== 'choose' || !SERVICES.includes(provider)) return;
    this.provider = provider;
    this.error = null;
    this.onChange();
  }

  async start() {
    if (this.phase !== 'choose') return;
    const generation = ++this.generation;
    this.phase = 'starting';
    this.error = null;
    this.onChange();
    try {
      const authorization = await this.request('usage-start', this.provider);
      if (generation !== this.generation) {
        // The flow closed or restarted while the sign-in started: abandon it.
        this.request('usage-cancel', authorization.id).catch(() => {});
        return;
      }
      Object.assign(this, { phase: 'authorize', authorization, rejected: 0, waiting: false });
    } catch (error) {
      if (generation !== this.generation) return;
      this.phase = 'choose';
      this.fail(error);
    }
    this.onChange();
  }

  /** Checks a pasted Claude code. The sign-in stays open after a rejected code, up to MAX_CODES. */
  async submit(code) {
    const value = String(code ?? '').trim();
    if (this.phase !== 'authorize' || this.authorization.prompt.kind !== 'code' || this.submitting || !value) return null;
    const generation = this.generation;
    this.submitting = true;
    this.error = null;
    this.onChange();
    try {
      const result = await this.request('usage-complete', this.authorization.id, value);
      if (generation !== this.generation) return null;
      if (result.status === 'connected') return this.connected(result.connection);
    } catch (error) {
      if (generation !== this.generation) return null;
      const exhausted = error.code === 'usage-authorization-code-invalid' && ++this.rejected >= MAX_CODES;
      const expired = 'usage-authorization-expired';
      this.fail(exhausted ? Object.assign(new Error(this.describe(expired)), { code: expired }) : error);
    } finally {
      if (generation === this.generation) this.submitting = false;
      this.onChange();
    }
    return null;
  }

  /** The person opened the device page: wait for the approval while the flow stays open. */
  approvalOpened() {
    if (this.phase !== 'authorize' || this.authorization.prompt.kind !== 'device' || this.waiting) return;
    this.waiting = true;
    this.schedule(this.generation, this.authorization.prompt.interval);
    this.onChange();
  }

  schedule(generation, seconds) {
    this.poll = this.timers.setTimeout(() => this.check(generation), seconds * 1000);
  }

  async check(generation) {
    this.poll = null;
    if (generation !== this.generation) return;
    const interval = this.authorization.prompt.interval;
    let next = interval;
    try {
      const result = await this.request('usage-complete', this.authorization.id);
      if (generation !== this.generation) return;
      if (result.status === 'connected') { this.connected(result.connection); this.onChange(); return; }
      next = Math.max(1, result.interval);
      this.error = null;
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error);
      if (endsSignIn(error.code)) { this.onChange(); return; }
      // A transient failure waits longer before the next poll.
      next = interval * 2;
    }
    this.onChange();
    this.schedule(generation, next);
  }

  connected(connection) {
    const provider = this.provider;
    this.restart();
    Object.assign(this, { provider, phase: 'connected', connection, error: null });
    this.onConnected(connection);
    return connection;
  }

  /** Closes the flow and abandons an unfinished sign-in on the server. */
  close() {
    const authorization = this.phase === 'authorize' ? this.authorization : null;
    this.restart();
    this.error = null;
    if (authorization) return this.request('usage-cancel', authorization.id).catch(() => false);
    return Promise.resolve(false);
  }
}
