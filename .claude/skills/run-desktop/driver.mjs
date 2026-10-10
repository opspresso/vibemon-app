// Driver for the VibeMon Electron app — zero dependencies.
// Speaks the Chrome DevTools Protocol directly over Node's built-in
// WebSocket and fetch (Node >= 22).
//
// One-shot (agent path) — commands run in order, the app is closed at the end:
//
//   node .claude/skills/run-desktop/driver.mjs \
//     "launch 3d" "lock codex" "status working" "ss codex-3d" "logs"
//
// With no arguments it starts an interactive REPL instead (human path).
//
// The Electron store is isolated. The full app still manages shared hook
// configuration; use tests/native for isolated automated verification.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const HTTP = 'http://127.0.0.1:19280';
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'vibemon-shots');
const USER_DATA_ROOT = process.env.VIBEMON_TEST_USER_DATA || path.join(os.tmpdir(), 'vibemon-userdata');

fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let proc = null;      // Electron child process
let cdp = null;       // browser-level CDP connection
let page = null;      // the window session commands act on (character by default)
const sessions = new Map();   // targetId -> { url, sessionId }
const logs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

async function post(route, body) {
  const res = await fetch(`${HTTP}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return `${res.status} ${(await res.text()).slice(0, 200)}`;
}

// --- CDP plumbing -----------------------------------------------------------

class CDP {
  #ws; #seq = 0; #pending = new Map();
  onevent = () => {};

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    const conn = new CDP();
    conn.#ws = ws;
    ws.addEventListener('message', (e) => conn.#receive(JSON.parse(e.data)));
    return conn;
  }

  // sessionId targets a specific window (flat session protocol); omit it for
  // browser-level methods like Target.*.
  send(method, params = {}, sessionId) {
    const id = ++this.#seq;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  #receive(msg) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else {
      this.onevent(msg);
    }
  }

  close() { try { this.#ws.close(); } catch { /* already closed */ } }
}

const remoteValue = (o) => o.value !== undefined ? String(o.value) : (o.description ?? o.type);

function handleEvent({ method, params }) {
  if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
    const info = params.targetInfo;
    if (info.type !== 'page' || info.url.startsWith('devtools://')) return;
    if (sessions.has(info.targetId)) {
      sessions.get(info.targetId).url = info.url;
    } else {
      sessions.set(info.targetId, { url: info.url, sessionId: null });
      attach(info.targetId).catch((e) => logs.push(`[driver] attach failed: ${e.message}`));
    }
  } else if (method === 'Target.targetDestroyed') {
    if (page === sessions.get(params.targetId)) page = null;
    sessions.delete(params.targetId);
  } else if (method === 'Runtime.consoleAPICalled') {
    logs.push(`[${params.type}] ${params.args.map(remoteValue).join(' ')}`);
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    logs.push(`[pageerror] ${d.exception?.description ?? d.text}`);
  } else if (method === 'Log.entryAdded') {
    // CSP violations and failed resource loads live in the Log domain, and
    // Log.enable replays entries buffered before we attached.
    const { source, level, text } = params.entry;
    if (source === 'violation' || source === 'security' || source === 'network') {
      logs.push(`[${source}:${level}] ${text}`);
    }
  }
}

async function attach(targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const session = sessions.get(targetId);
  if (!session) return;   // destroyed while attaching
  session.sessionId = sessionId;
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
}

function windowByKind(kind) {
  const suffix = kind === 'bubble' ? 'bubble.html' : 'index.html';
  for (const session of sessions.values()) {
    if (session.sessionId && session.url.endsWith(suffix)) return session;
  }
  return null;
}

async function evaluate(session, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, session.sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function screenshot(session, file, { transparent = false } = {}) {
  if (transparent) {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride',
      { color: { r: 0, g: 0, b: 0, a: 0 } }, session.sessionId);
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session.sessionId);
  if (transparent) {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {}, session.sessionId);
  }
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// --- commands ---------------------------------------------------------------

const COMMANDS = {
  // launch [2d|3d] — seeds the render mode, then boots the app.
  async launch(arg) {
    if (proc) return console.log('already launched — quit first');
    if (await fetch(`${HTTP}/health`).then((r) => r.ok).catch(() => false)) {
      throw new Error('port 19280 is already in use — the real app (or another driver) is running');
    }
    const mode = arg.trim() === '3d' ? '3d' : '2d';
    const userData = path.join(USER_DATA_ROOT, mode);
    fs.mkdirSync(userData, { recursive: true });
    // electron-store keeps settings in <userData>/config.json; the character
    // window reads renderMode at creation, so seed it before launching.
    const configFile = path.join(userData, 'config.json');
    const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    fs.writeFileSync(configFile, JSON.stringify({ ...config, renderMode: mode }, null, 2));

    const debugPort = await freePort();
    const child = spawn(electronBin,
      [APP_DIR, `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`],
      { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = child;
    child.on('exit', () => {
      if (proc !== child) return;
      proc = null; page = null; sessions.clear();
      cdp?.close(); cdp = null;
    });
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream })
        .on('line', (line) => { if (line.trim()) logs.push(`[main] ${line}`); });
    }

    try {
      const version = await until('devtools endpoint', () =>
        fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json()), 30_000);
      cdp = await CDP.connect(version.webSocketDebuggerUrl);
      cdp.onevent = handleEvent;
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      // Ready signal: the HTTP server is up. There is no window yet — the
      // character window is created on demand by POST /status.
      await until('http server', async () => (await fetch(`${HTTP}/health`)).ok, 30_000);
    } catch (e) {
      child.kill('SIGKILL');
      throw e;
    }
    console.log(`launched in ${mode} mode (userData: ${userData})`);
    console.log('no window yet — run "status working" to create the character window');
  },

  // status <state> [character] [project] — POST /status, then wait for the window.
  async status(args) {
    const [state = 'working', character = 'vibemon', project = 'driver'] = args.trim().split(/\s+/);
    const isNewWindow = !windowByKind('character');
    console.log(await post('/status', { state, character, project }));
    page = await until('character window', async () => windowByKind('character'));
    if (isNewWindow) {
      // The preload buffers initial IPC until the renderer subscribes.
      // Wait for the actual engine; never manufacture replacement updates.
      await until('renderer engine', () => evaluate(page,
        '(() => { if (document.querySelector(".vibemon-canvas-3d")) return true;' +
        ' const c = document.querySelector(".vibemon-canvas");' +
        ' return !!c && c.style.left !== ""; })()'));
    }
    await sleep(1500);   // let images load / the rig build and animate
    console.log('character window ready:', page.url.split('/').pop());
  },

  // lock <character|auto> — pin the character. Use this before screenshots:
  // any other VibeMon bridge on this machine posts to the same port and can
  // retarget the window (the /status reply then says "skipped": true).
  async lock(character) {
    console.log(await post('/character-lock', { character: character.trim() || 'auto' }));
    await sleep(1000);
  },

  // focus — what the window is actually showing right now. The window follows
  // the focused project, and any other VibeMon bridge on this machine (a
  // Claude Code hook, say) can retarget it between your POST and your
  // screenshot. Trust this over the status you sent.
  async focus() {
    const res = await fetch(`${HTTP}/status`);
    const data = await res.json();
    const entry = data.projects?.[data.focusedProject];
    console.log(entry
      ? `focused=${data.focusedProject} character=${entry.character} state=${entry.state}`
      : `focused=${data.focusedProject} (no entry)`);
  },

  // ss [name] — screenshot over an opaque backdrop (the window is transparent,
  // so a raw shot is hard to read in review). Use ss-raw for the real frame.
  // Prints the focused project alongside, so the image is self-describing.
  async ss(name) {
    if (!page) return console.log('ERROR: no window — run "status" first');
    await evaluate(page, 'document.documentElement.style.background = "#2b2b33"');
    await sleep(300);
    const file = path.join(SHOT_DIR, `${name.trim() || `ss-${Date.now()}`}.png`);
    await screenshot(page, file);
    await evaluate(page, 'document.documentElement.style.background = ""');
    console.log('screenshot:', file);
    await COMMANDS.focus();
  },

  async 'ss-raw'(name) {
    if (!page) return console.log('ERROR: no window — run "status" first');
    const file = path.join(SHOT_DIR, `${name.trim() || `raw-${Date.now()}`}.png`);
    await screenshot(page, file, { transparent: true });
    console.log('screenshot:', file);
  },

  // page <character|bubble> — retarget subsequent commands.
  async page(kind) {
    const found = windowByKind(kind.trim() || 'character');
    if (!found) return console.log('not open:', kind);
    page = found;
    console.log('now driving:', page.url.split('/').pop());
  },

  async windows() {
    if (!cdp) return console.log('ERROR: launch first');
    for (const session of sessions.values()) console.log(' ', session.url);
  },

  // engine — which renderer actually booted (2D canvas vs WebGL canvas).
  async engine() {
    if (!page) return console.log('ERROR: no window — run "status" first');
    console.log(JSON.stringify(await evaluate(page,
      '(() => { const c = document.querySelector("canvas");' +
      ' return c ? { className: c.className, width: c.width, height: c.height } : null; })()')));
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: no window — run "status" first');
    console.log(JSON.stringify(await evaluate(page, expr)));
  },

  async text(sel) {
    if (!page) return console.log('ERROR: no window — run "status" first');
    const target = sel.trim() ? `document.querySelector(${JSON.stringify(sel.trim())})` : 'document.body';
    console.log(await evaluate(page, `${target}?.innerText ?? '(null)'`));
  },

  // wait <ms> — pause a one-shot sequence (e.g. to let an animation settle).
  async wait(ms) {
    await sleep(Math.max(0, Number(ms) || 1000));
  },

  // logs — renderer console, uncaught errors, CSP/resource-load violations,
  // and main-process output since launch. Empty is the expected result.
  logs() {
    console.log(logs.length ? logs.join('\n') : '(none)');
  },

  async quit() {
    if (!proc) return;
    const child = proc;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    cdp?.send('Browser.close').catch(() => {});
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killTimer);
  },

  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '));
    console.log('typical: launch 3d → lock codex → status working → engine → ss codex-3d → logs');
    console.log('a screenshot that surprises you: run "focus" — another bridge probably retargeted the window');
  }
};

async function run(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return true;
  const fn = COMMANDS[cmd];
  if (!fn) { console.log('unknown:', cmd, '— try: help'); return false; }
  try { await fn(rest.join(' ')); return true; }
  catch (e) { console.log('ERROR:', e.message); return false; }
}

const script = process.argv.slice(2);
if (script.length) {
  // One-shot mode: run the commands in order, always close the app, exit
  // non-zero if any command failed.
  let failed = false;
  for (const line of script) {
    console.log(`driver> ${line}`);
    if (!await run(line)) { failed = true; break; }
  }
  await COMMANDS.quit();
  process.exit(failed ? 1 : 0);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });
  rl.on('line', async (line) => {
    await run(line);
    if (line.trim().split(/\s+/)[0] === 'quit') { rl.close(); process.exit(0); }
    rl.prompt();
  });
  rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });
  console.log('VibeMon driver — "help" for commands, "launch [2d|3d]" to start');
  rl.prompt();
}
