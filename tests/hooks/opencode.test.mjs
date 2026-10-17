import assert from "node:assert/strict";
import test from "node:test";
import { loadPlugin } from "./plugin_harness.mjs";

const PLUGIN = "../../public/install/opencode/plugin/vibemon.js";

// A push-based stand-in for opencode 2.x `ctx.event.subscribe()`. It ends
// when the subscriber's AbortSignal fires, like the real stream.
function eventStream() {
  const pending = [];
  const waiters = [];
  let signal;
  let closed = false;
  const next = () => {
    if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
    if (closed || signal?.aborted) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => waiters.push(resolve));
  };
  return {
    subscribe(options = {}) {
      signal = options.signal;
      signal?.addEventListener("abort", () => {
        closed = true;
        for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
      });
      return { [Symbol.asyncIterator]: () => ({ next }) };
    },
    push(event) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else pending.push(event);
    },
    get aborted() { return Boolean(signal?.aborted); },
  };
}

// One opencode 2.x server, shaped after opencode 2.0.25. Each `open(dir)`
// calls the plugin's `setup` for one project instance. The event bus reaches
// every instance; tool hooks reach only the instance that runs them.
// `sessions` holds the ctx.session.get() results; values may be promises.
async function opencode(options = {}) {
  const h = await loadPlugin(PLUGIN, options);
  const sessions = options.sessions || {};
  const instances = [];
  const lookups = [];

  function open(directory) {
    const hooks = new Map();
    const stream = eventStream();
    const cleanup = h.exports.default.setup({
      location: { directory },
      tool: { hook: (name, handler) => hooks.set(name, handler) },
      event: { subscribe: (subscribeOptions) => stream.subscribe(subscribeOptions) },
      session: {
        get: async ({ sessionID }) => {
          lookups.push(`${directory}:${sessionID}`);
          if (!sessions[sessionID]) throw new Error("NotFound");
          return sessions[sessionID];
        },
      },
    });
    const instance = {
      directory,
      cleanup,
      stream,
      hooks,
      async tool(name, event) {
        hooks.get(name)(event);
        await h.flush();
      },
    };
    instances.push(instance);
    return instance;
  }

  return {
    ...h,
    open,
    lookups,
    one: open("/projects/one"),
    async event(type, data) {
      for (const instance of instances) instance.stream.push({ id: "evt", created: 1, type, data });
      await h.flush();
    },
    names: () => h.payloads().map((p) => p.hook_event_name),
  };
}

// session.created data as opencode 2.0.25 sends it.
const created = (sessionID, directory = "/projects/one", extra = {}) => ({
  sessionID, projectID: "prj", location: { directory }, subpath: "", ...extra,
});

test("default export serves the opencode 2.x and 1.x plugin APIs", async () => {
  const h = await opencode();
  assert.equal(h.exports.default.id, "vibemon");
  assert.equal(typeof h.exports.default.setup, "function");
  assert.equal(typeof h.exports.default.server, "function");
  assert.deepEqual([...h.one.hooks.keys()], ["execute.before", "execute.after"]);
});

test("a prompt with a tool call maps to the full state sequence", async () => {
  const h = await opencode();
  const s = "ses_1";
  await h.event("session.created", created(s, "/projects/one", { model: { id: "big-pickle", providerID: "opencode" } }));
  await h.event("session.execution.started", { sessionID: s });
  await h.event("session.step.started", {
    sessionID: s, agent: "plan", model: { id: "model-b", providerID: "opencode" },
  });
  await h.one.tool("execute.before", { sessionID: s, tool: "shell", agent: "plan" });
  await h.event("permission.asked", { id: "per_1", sessionID: s, action: "shell" });
  await h.one.tool("execute.after", { sessionID: s, tool: "shell", status: "completed" });
  await h.event("session.execution.succeeded", { sessionID: s });

  assert.deepEqual(h.names(), [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop",
  ]);
  const payloads = h.payloads();
  assert.equal(payloads[0].model, "big-pickle");
  assert.equal(payloads[0].permission_mode, "default");
  for (const p of payloads) {
    assert.equal(p.session_id, s);
    assert.equal(p.cwd, "/projects/one");
  }
  for (const p of payloads.slice(2)) {
    assert.equal(p.model, "model-b");
    assert.equal(p.permission_mode, "plan");
  }
  assert.deepEqual(payloads.map((p) => p.tool_name), ["", "", "shell", "shell", "shell", ""]);
  assert.deepEqual(h.lookups, []);
});

test("streaming and session-less events send nothing", async () => {
  const h = await opencode();
  await h.event("session.created", created("s"));
  const sent = h.payloads().length;
  for (const type of ["plugin.updated", "model.updated", "location.shutdown"]) {
    await h.event(type, {});
  }
  for (const type of [
    "session.inbox.enqueued", "session.step.started", "session.reasoning.delta",
    "session.tool.input.started", "session.tool.called", "session.tool.success",
    "session.text.delta", "session.step.ended", "session.usage.updated", "permission.replied",
  ]) {
    await h.event(type, { sessionID: "s" });
  }
  await h.event("session.execution.started", null);
  await h.one.tool("execute.before", undefined);
  assert.equal(h.payloads().length, sent);
});

test("each project instance sends only its own sessions", async () => {
  const h = await opencode({
    sessions: { booted: { id: "booted", location: { directory: "/projects/two" } } },
  });
  const two = h.open("/projects/two");
  await h.event("session.created", created("a", "/projects/one"));
  await h.event("session.created", created("b", "/projects/two"));
  await h.event("session.execution.started", { sessionID: "a" });
  await h.event("session.execution.started", { sessionID: "b" });
  await h.event("session.execution.started", { sessionID: "booted" });
  await two.tool("execute.before", { sessionID: "b", tool: "read" });
  await h.event("session.execution.succeeded", { sessionID: "a" });
  await h.event("session.execution.succeeded", { sessionID: "b" });
  await h.event("session.execution.succeeded", { sessionID: "booted" });

  const sent = h.payloads().map((p) => `${p.cwd}:${p.session_id}:${p.hook_event_name}`);
  assert.deepEqual(sent, [
    "/projects/one:a:SessionStart",
    "/projects/two:b:SessionStart",
    "/projects/one:a:UserPromptSubmit",
    "/projects/two:b:UserPromptSubmit",
    "/projects/two:booted:UserPromptSubmit",
    "/projects/two:b:PreToolUse",
    "/projects/one:a:Stop",
    "/projects/two:b:Stop",
    "/projects/two:booted:Stop",
  ]);
  assert.deepEqual(h.lookups.sort(), ["/projects/one:booted", "/projects/two:booted"]);
});

test("a session created before setup subscribed reads its metadata once", async () => {
  const h = await opencode({
    sessions: { booted: { id: "booted", location: { directory: "/projects/one" }, model: { id: "model-a" } } },
  });
  await h.event("session.execution.started", { sessionID: "booted" });
  await h.one.tool("execute.before", { sessionID: "booted", tool: "read" });
  await h.event("session.execution.succeeded", { sessionID: "booted" });
  assert.deepEqual(h.lookups, ["/projects/one:booted"]);
  assert.deepEqual(h.names(), ["UserPromptSubmit", "PreToolUse", "Stop"]);
  assert.ok(h.payloads().every((p) => p.cwd === "/projects/one" && p.model === "model-a"));
});

test("events wait for a pending lookup and keep their order", async () => {
  let resolve;
  const info = new Promise((done) => { resolve = done; });
  const h = await opencode({ sessions: { s: info } });
  await h.event("session.execution.started", { sessionID: "s" });
  await h.one.tool("execute.before", { sessionID: "s", tool: "read" });
  await h.event("session.execution.succeeded", { sessionID: "s" });
  assert.deepEqual(h.payloads(), []);
  resolve({ id: "s", location: { directory: "/projects/one" }, model: { id: "model-a" } });
  await h.flush();
  assert.deepEqual(h.lookups, ["/projects/one:s"]);
  // The queue keeps the latest pending state per session, so PreToolUse is
  // replaced. Stop must still be last.
  assert.deepEqual(h.names(), ["UserPromptSubmit", "Stop"]);
  assert.ok(h.payloads().every((p) => p.model === "model-a"));
});

test("a session without metadata is sent only after this instance runs its tool", async () => {
  const h = await opencode();
  await h.event("session.execution.started", { sessionID: "gone" });
  await h.event("session.deleted", { sessionID: "gone" });
  assert.deepEqual(h.payloads(), []);
  await h.one.tool("execute.before", { sessionID: "resumed", tool: "read" });
  await h.event("session.execution.succeeded", { sessionID: "resumed" });
  await h.event("session.deleted", { sessionID: "resumed" });
  assert.deepEqual(h.names(), ["PreToolUse", "Stop", "SessionEnd"]);
  assert.ok(h.payloads().every((p) => p.cwd === "/projects/one"));
});

test("compaction, retry and every execution outcome restore terminal state", async () => {
  const h = await opencode();
  await h.event("session.created", created("s"));
  await h.event("session.compaction.started", { sessionID: "s", reason: "manual" });
  await h.event("session.compaction.ended", { sessionID: "s" });
  await h.event("session.retry.scheduled", { sessionID: "s" });
  await h.event("session.execution.failed", { sessionID: "s", error: {} });
  await h.event("session.execution.interrupted", { sessionID: "s" });
  await h.event("session.execution.started", { sessionID: "s" });
  await h.event("session.execution.interrupted", { sessionID: "s" });
  assert.deepEqual(h.names(), [
    "SessionStart", "PreCompact", "PostCompact", "UserPromptSubmit", "Stop", "UserPromptSubmit", "Stop",
  ]);
});

test("a subagent cannot override its parent's state", async () => {
  const h = await opencode({
    sessions: { missed: { id: "missed", parentID: "parent", location: { directory: "/projects/one" } } },
  });
  await h.event("session.created", created("parent"));
  await h.one.tool("execute.before", { sessionID: "parent", tool: "subagent" });
  await h.event("session.created", created("child", "/projects/one", { parentID: "parent", agent: "general" }));
  for (const child of ["child", "missed"]) {
    await h.event("session.execution.started", { sessionID: child });
    await h.one.tool("execute.before", { sessionID: child, tool: "read" });
    await h.event("session.execution.succeeded", { sessionID: child });
    await h.event("session.deleted", { sessionID: child });
  }
  assert.deepEqual(h.names(), ["SessionStart", "PreToolUse"]);
});

test("cleanup ends the event subscription", async () => {
  const h = await opencode();
  assert.equal(typeof h.one.cleanup, "function");
  h.one.cleanup();
  await h.flush();
  assert.equal(h.one.stream.aborted, true);
  await h.event("session.created", created("s"));
  assert.deepEqual(h.payloads(), []);
});

test("queue serializes children, bounds their lifetime and drains after failure", async () => {
  const h = await opencode({ autoClose: false });
  await h.one.tool("execute.before", { sessionID: "s", tool: "read" });
  await h.event("session.execution.succeeded", { sessionID: "s" });
  assert.equal(h.children.length, 1);
  const first = h.children[0];
  assert.equal(first.options.timeout, 10000);
  assert.equal(first.options.killSignal, "SIGKILL");
  assert.equal(first.options.windowsHide, true);
  first.child.emit("error", new Error("ENOENT"));
  first.child.emit("close", -1);
  assert.equal(h.children.length, 2);
  assert.equal(h.payloads().at(-1).hook_event_name, "Stop");
});

test("bursts keep the latest terminal event within the bounded queue", async () => {
  const h = await opencode({ autoClose: false });
  for (let i = 0; i < 60; i++) {
    await h.one.tool("execute.before", { sessionID: "s", tool: `tool-${i}` });
  }
  await h.event("session.execution.succeeded", { sessionID: "s" });
  h.closeChildren();
  assert.equal(h.children.length, 2);
  assert.equal(h.payloads().at(-1).hook_event_name, "Stop");
});

test("a burst across distinct sessions remains bounded", async () => {
  const h = await opencode({ autoClose: false });
  for (let i = 0; i < 60; i++) {
    await h.one.tool("execute.before", { sessionID: `session-${i}`, tool: "read" });
  }
  h.closeChildren();
  assert.equal(h.children.length, 33);
  assert.equal(h.payloads().at(-1).session_id, "session-59");
});

test("tool call IDs reach the adapter and queued tool events are never replaced", async () => {
  const h = await opencode({ autoClose: false });
  await h.one.tool("execute.before", { sessionID: "s", tool: "read", id: "call-1" });
  await h.one.tool("execute.before", { sessionID: "s", tool: "shell", id: "call-2" });
  await h.one.tool("execute.after", { sessionID: "s", tool: "read", id: "call-1" });
  await h.event("session.compaction.failed", { sessionID: "s" });
  h.closeChildren();
  const sent = h.payloads().map((payload) => [payload.hook_event_name, payload.tool_use_id]);
  assert.deepEqual(sent, [
    ["PreToolUse", "call-1"], ["PreToolUse", "call-2"], ["PostToolUse", "call-1"], ["PostCompact", ""],
  ]);
});

// One opencode 1.x project instance, shaped after opencode 1.18.29: server()
// returns hooks, and `event` receives only this instance's bus events.
async function opencodeV1(directory = "/projects/one") {
  const h = await loadPlugin(PLUGIN);
  const hooks = await h.exports.default.server({ directory, worktree: directory });
  return {
    ...h,
    hooks,
    async call(name, input) {
      await hooks[name](input, {});
      await h.flush();
    },
    async event(type, properties) {
      await hooks.event({ event: { type, properties } });
      await h.flush();
    },
    names: () => h.payloads().map((p) => p.hook_event_name),
  };
}

test("opencode 1.x: a prompt with a tool call maps to the full state sequence", async () => {
  const h = await opencodeV1();
  const s = "ses_1";
  await h.event("session.created", { info: { id: s, directory: "/projects/one", projectID: "prj" } });
  await h.call("chat.message", { sessionID: s, agent: "plan", model: { providerID: "opencode", modelID: "model-a" } });
  await h.call("tool.execute.before", { sessionID: s, tool: "bash", callID: "call-1" });
  await h.event("permission.asked", { id: "per_1", sessionID: s, type: "bash", callID: "call-1" });
  await h.call("tool.execute.after", { sessionID: s, tool: "bash", callID: "call-1", args: {} });
  await h.call("experimental.session.compacting", { sessionID: s });
  await h.event("session.compacted", { sessionID: s });
  await h.event("session.idle", { sessionID: s });
  await h.event("session.deleted", { info: { id: s, directory: "/projects/one" } });

  assert.deepEqual(h.names(), [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
    "PreCompact", "PostCompact", "Stop", "SessionEnd",
  ]);
  const payloads = h.payloads();
  assert.ok(payloads.every((p) => p.session_id === s && p.cwd === "/projects/one"));
  assert.deepEqual(payloads.map((p) => p.tool_use_id), ["", "", "call-1", "call-1", "call-1", "", "", "", ""]);
  assert.equal(payloads[2].model, "model-a");
  assert.equal(payloads[2].permission_mode, "plan");
});

test("opencode 1.x: a failure or abort ends the turn with one Stop", async () => {
  const h = await opencodeV1();
  await h.call("chat.message", { sessionID: "s" });
  await h.event("session.error", { sessionID: "s", error: { name: "MessageAbortedError" } });
  await h.event("session.idle", { sessionID: "s" });
  await h.call("chat.message", { sessionID: "s" });
  await h.event("session.idle", { sessionID: "s" });
  assert.deepEqual(h.names(), ["UserPromptSubmit", "Stop", "UserPromptSubmit", "Stop"]);
});

test("opencode 1.x: a subagent cannot override its parent's state", async () => {
  const h = await opencodeV1();
  await h.call("chat.message", { sessionID: "parent" });
  await h.call("tool.execute.before", { sessionID: "parent", tool: "task", callID: "call-1" });
  await h.event("session.created", { info: { id: "child", parentID: "parent", directory: "/projects/one" } });
  await h.call("chat.message", { sessionID: "child" });
  await h.call("tool.execute.before", { sessionID: "child", tool: "read", callID: "call-2" });
  await h.event("session.idle", { sessionID: "child" });
  assert.deepEqual(h.names(), ["UserPromptSubmit", "PreToolUse"]);
});

test("opencode 1.x: malformed input sends nothing and never throws", async () => {
  const h = await opencodeV1();
  await h.hooks.event({});
  await h.hooks.event({ event: { type: "session.idle" } });
  await h.hooks["chat.message"](undefined);
  await h.hooks["tool.execute.before"]({ tool: "read" });
  await h.flush();
  assert.deepEqual(h.payloads(), []);
});

test("credential switching settles the previous account and binds the next turn", async () => {
  const h = await opencode();
  await h.event("session.created", created("s", "/projects/one", { model: { id: "model", providerID: "anthropic" } }));
  await h.event("session.execution.started", { sessionID: "s" });
  await h.one.tool("execute.before", { sessionID: "s", tool: "read", id: "old-call" });
  await h.event("credential.switched", { integrationID: "anthropic", credentialID: "new-account" });
  await h.event("session.execution.started", { sessionID: "s" });
  const reports = h.payloads();
  assert.equal(reports.at(-2).hook_event_name, "Stop");
  assert.equal(reports.at(-2).account_hint.revision, "0");
  assert.equal(reports.at(-1).account_hint.revision, "new-account");
  await h.one.tool("execute.after", { sessionID: "s", tool: "read", id: "old-call" });
  assert.equal(h.payloads().at(-1).account_hint.revision, "0");
  assert.ok(h.payloads().every(p => p.account_hint.provider === "anthropic"));
});

test("a different model provider closes the previous connection without mixing its model", async () => {
  const h = await opencode();
  await h.event("session.created", created("s", "/projects/one", { model: { id: "claude", providerID: "anthropic" } }));
  await h.event("session.execution.started", { sessionID: "s" });
  await h.event("session.step.started", { sessionID: "s", model: { id: "gpt", providerID: "openai" } });
  await h.one.tool("execute.before", { sessionID: "s", tool: "read" });
  assert.equal(h.payloads().at(-2).hook_event_name, "Stop");
  assert.equal(h.payloads().at(-2).account_hint.provider, "anthropic");
  assert.equal(h.payloads().at(-2).model, "claude");
  assert.equal(h.payloads().at(-1).account_hint.provider, "openai");
  assert.equal(h.payloads().at(-1).model, "gpt");
});
