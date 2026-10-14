import assert from "node:assert/strict";
import test from "node:test";
import { loadPlugin } from "./plugin_harness.mjs";

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

// Calls the plugin's V2 `setup` with the context fields it uses, captured
// from opencode 2.0.25.
function instance(h, directory) {
  const hooks = new Map();
  const stream = eventStream();
  const cleanup = h.exports.default.setup({
    location: { directory },
    tool: { hook: (name, handler) => hooks.set(name, handler) },
    event: { subscribe: (options) => stream.subscribe(options) },
  });
  return {
    cleanup,
    stream,
    hooks,
    async tool(name, event) {
      hooks.get(name)(event);
      await h.flush();
    },
    async event(type, data, extra = {}) {
      stream.push({ id: "evt", created: 1, type, data, ...extra });
      await h.flush();
    },
  };
}

async function setup(options) {
  const h = await loadPlugin("../../public/install/opencode/plugin/vibemon.js", options);
  return { ...h, one: instance(h, "/projects/one"), instance: (dir) => instance(h, dir) };
}

const names = (h) => h.payloads().map((p) => p.hook_event_name);

test("default export is the opencode 2.x plugin definition", async () => {
  const h = await setup();
  assert.equal(h.exports.default.id, "vibemon");
  assert.equal(typeof h.exports.default.setup, "function");
  assert.deepEqual([...h.one.hooks.keys()], ["execute.before", "execute.after"]);
});

test("a prompt with a tool call maps to the full state sequence", async () => {
  const h = await setup();
  const s = "ses_1";
  await h.one.event("session.created", {
    sessionID: s,
    location: { directory: "/projects/one/sub" },
    model: { id: "big-pickle", providerID: "opencode" },
  });
  await h.one.event("session.execution.started", { sessionID: s });
  await h.one.event("session.step.started", {
    sessionID: s, agent: "plan", model: { id: "model-b", providerID: "opencode" },
  });
  await h.one.tool("execute.before", { sessionID: s, tool: "shell", agent: "plan" });
  await h.one.event("permission.asked", { id: "per_1", sessionID: s, action: "shell" });
  await h.one.tool("execute.after", { sessionID: s, tool: "shell", status: "completed" });
  await h.one.event("session.execution.succeeded", { sessionID: s });

  assert.deepEqual(names(h), [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop",
  ]);
  const payloads = h.payloads();
  assert.equal(payloads[0].model, "big-pickle");
  assert.equal(payloads[0].permission_mode, "default");
  for (const p of payloads) {
    assert.equal(p.session_id, s);
    assert.equal(p.cwd, "/projects/one/sub");
  }
  for (const p of payloads.slice(2)) {
    assert.equal(p.model, "model-b");
    assert.equal(p.permission_mode, "plan");
  }
  assert.deepEqual(payloads.map((p) => p.tool_name), ["", "", "shell", "shell", "shell", ""]);
});

test("streaming and session-less events send nothing", async () => {
  const h = await setup();
  for (const type of ["plugin.updated", "model.updated", "location.shutdown"]) {
    await h.one.event(type, {});
  }
  for (const type of [
    "session.inbox.enqueued", "session.step.started", "session.reasoning.delta",
    "session.tool.input.started", "session.tool.called", "session.tool.success",
    "session.text.delta", "session.step.ended", "session.usage.updated", "permission.replied",
  ]) {
    await h.one.event(type, { sessionID: "s" });
  }
  await h.one.event("session.execution.started", null);
  await h.one.tool("execute.before", undefined);
  assert.deepEqual(h.payloads(), []);
});

test("resumed sessions use the instance directory", async () => {
  const h = await setup();
  await h.one.tool("execute.before", { sessionID: "resumed", tool: "read" });
  await h.one.event("session.deleted", { sessionID: "resumed" });
  assert.deepEqual(names(h), ["PreToolUse", "SessionEnd"]);
  assert.ok(h.payloads().every((p) => p.cwd === "/projects/one"));
});

test("compaction, retry and every execution outcome restore terminal state", async () => {
  const h = await setup();
  await h.one.event("session.compaction.started", { sessionID: "s", reason: "manual" });
  await h.one.event("session.compaction.ended", { sessionID: "s" });
  await h.one.event("session.retry.scheduled", { sessionID: "s" });
  await h.one.event("session.execution.failed", { sessionID: "s", error: {} });
  await h.one.event("session.execution.interrupted", { sessionID: "s" });
  await h.one.event("session.execution.started", { sessionID: "s" });
  await h.one.event("session.execution.interrupted", { sessionID: "s" });
  assert.deepEqual(names(h), [
    "PreCompact", "PostCompact", "UserPromptSubmit", "Stop", "UserPromptSubmit", "Stop",
  ]);
});

test("a subagent cannot override its parent's state", async () => {
  const h = await setup();
  await h.one.event("session.created", { sessionID: "parent" });
  await h.one.tool("execute.before", { sessionID: "parent", tool: "subagent" });
  await h.one.event("session.created", { sessionID: "child", parentID: "parent", agent: "general" });
  await h.one.event("session.execution.started", { sessionID: "child" });
  await h.one.tool("execute.before", { sessionID: "child", tool: "read" });
  await h.one.event("session.execution.succeeded", { sessionID: "child" });
  await h.one.event("session.deleted", { sessionID: "child" });
  assert.deepEqual(names(h), ["SessionStart", "PreToolUse"]);
});

test("project instances do not share session metadata", async () => {
  const h = await setup();
  await h.one.event("session.created", { sessionID: "s", model: { id: "one" } });
  const two = h.instance("/projects/two");
  await two.tool("execute.before", { sessionID: "s", tool: "read" });
  assert.equal(h.payloads().at(-1).cwd, "/projects/two");
  assert.equal(h.payloads().at(-1).model, "");
});

test("cleanup ends the event subscription", async () => {
  const h = await setup();
  assert.equal(typeof h.one.cleanup, "function");
  h.one.cleanup();
  await h.flush();
  assert.equal(h.one.stream.aborted, true);
  await h.one.event("session.execution.started", { sessionID: "s" });
  assert.deepEqual(h.payloads(), []);
});

test("queue serializes children, bounds their lifetime and drains after failure", async () => {
  const h = await setup({ autoClose: false });
  await h.one.tool("execute.before", { sessionID: "s", tool: "read" });
  await h.one.event("session.execution.succeeded", { sessionID: "s" });
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
  const h = await setup({ autoClose: false });
  for (let i = 0; i < 60; i++) {
    await h.one.tool("execute.before", { sessionID: "s", tool: `tool-${i}` });
  }
  await h.one.event("session.execution.succeeded", { sessionID: "s" });
  for (let i = 0; i < h.children.length; i++) h.children[i].child.emit("close", 0);
  assert.equal(h.children.length, 2);
  assert.equal(h.payloads().at(-1).hook_event_name, "Stop");
});

test("a burst across distinct sessions remains bounded", async () => {
  const h = await setup({ autoClose: false });
  for (let i = 0; i < 60; i++) {
    await h.one.tool("execute.before", { sessionID: `session-${i}`, tool: "read" });
  }
  for (let i = 0; i < h.children.length; i++) h.children[i].child.emit("close", 0);
  assert.equal(h.children.length, 33);
  assert.equal(h.payloads().at(-1).session_id, "session-59");
});
