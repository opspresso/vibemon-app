import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

// Load the actual plugin with isolated filesystem, process and transport
// boundaries. No test accesses the user's config, devices or network.
export async function loadPlugin(relativePath, options = {}) {
  const timers = new Map();
  let timerId = 0;
  let now = 1000;
  const children = [];
  const requests = [];
  const timeouts = [];
  const files = new Map(Object.entries(options.files || {}));
  let mtime = 1;
  const fakeFs = {
    realpathSync: value => value,
    constants: { W_OK: 2 },
    existsSync: (p) => files.has(p),
    accessSync: () => {},
    readdirSync: (p) => [...files.keys()].filter((f) => path.posix.dirname(f) === p).map((f) => path.posix.basename(f)),
    statSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return { mtimeMs: mtime };
    },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p);
    },
    writeFileSync: () => { throw new Error("Direct gateway serial writes are forbidden"); },
  };
  function spawn(command, args, spawnOptions) {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.raw = "";
    child.stdin.write = (data) => { child.raw += data; };
    child.stdin.end = (data = "") => {
      child.raw += data;
      if (options.autoClose !== false) queueMicrotask(() => child.emit("close", 0));
    };
    child.unref = () => {};
    children.push({ command, args, options: spawnOptions, child });
    return child;
  }
  const sandbox = vm.createContext({
    process: { env: options.env || {}, platform: "linux", cwd: () => "/server" },
    URL,
    AbortController,
    Date: class extends Date { static now() { return now; } },
    AbortSignal: { timeout: (ms) => { timeouts.push(ms); return { timeout: ms }; } },
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, request) => {
      requests.push({ url, ...request, payload: request.body ? JSON.parse(request.body) : null });
      if (options.fetch) return options.fetch(url, request);
      return { ok: true, status: 200, text: async () => "ok" };
    },
  });
  const modules = {
    "node:fs": { default: fakeFs },
    "node:path": { default: path.posix },
    "node:os": { default: { homedir: () => "/home/test", hostname: () => "test-machine" } },
    "node:crypto": { createHash },
    "node:child_process": { spawn },
  };
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const module = new vm.SourceTextModule(source, { context: sandbox });
  await module.link((specifier) => {
    const exports = modules[specifier];
    if (!exports) throw new Error(`Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context: sandbox });
  });
  await module.evaluate();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    exports: module.namespace, children, requests, timeouts, flush,
    setFile(p, content) { files.set(p, content); mtime += 1; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await flush();
    },
    payloads: () => children.filter(({ child }) => child.raw).map(({ child }) => JSON.parse(child.raw)),
  };
}

export async function openclaw(options = {}) {
  const harness = await loadPlugin("../../public/install/openclaw/extensions/index.mjs", options);
  const hooks = new Map();
  const logs = [];
  harness.exports.default.register({
    logger: Object.fromEntries(["info", "warn", "error"].map(level => [level, message => logs.push(message)])),
    pluginConfig: { httpUrls: ["http://monitor"], ...options.pluginConfig },
    config: options.config || {},
    on: (name, callback) => hooks.set(name, callback),
  });
  return {
    ...harness,
    logs,
    async emit(name, event = {}, ctx = {}) {
      if (!hooks.has(name)) throw new Error(`Hook not registered: ${name}`);
      await hooks.get(name)(event, ctx);
      await harness.flush();
    },
    states: () => harness.requests.filter((r) => r.payload).map((r) => r.payload.state),
  };
}
