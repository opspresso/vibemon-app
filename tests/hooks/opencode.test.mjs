import assert from "node:assert/strict";
import test from "node:test";
import { loadPlugin } from "./plugin_harness.mjs";

async function setup(options) {
  const h = await loadPlugin("../../public/install/opencode/plugin/vibemon.js", options);
  const hooks = await h.exports.vibemon({ directory: "/projects/one" });
  const event = async (type, properties) => {
    await hooks.event({ event: { type, properties } });
    await h.flush();
  };
  return { ...h, hooks, event };
}

test("resumed sessions retain the project and resolved model from chat output", async () => {
  const h = await setup();
  await h.hooks["chat.message"]({ sessionID: "s" }, {
    message: { model: { modelID: "model-a" }, agent: "plan" },
  });
  await h.hooks["tool.execute.before"]({ sessionID: "s", tool: "bash" });
  await h.event("session.idle", { sessionID: "s" });
  for (const p of h.payloads()) {
    assert.equal(p.cwd, "/projects/one");
    assert.equal(p.model, "model-a");
    assert.equal(p.permission_mode, "plan");
  }
});

test("cold resume tool and lifecycle events use the instance directory", async () => {
  const h = await setup();
  await h.hooks["tool.execute.before"]({ sessionID: "resumed", tool: "read" });
  await h.event("permission.asked", { sessionID: "resumed", permission: "bash" });
  await h.event("session.deleted", { info: { id: "resumed" } });
  assert.ok(h.payloads().every((p) => p.cwd === "/projects/one"));
  assert.equal(h.payloads()[1].tool_name, "bash");
});

test("compaction, retry, error and status-only idle restore terminal state", async () => {
  const h = await setup();
  await h.hooks["experimental.session.compacting"]({ sessionID: "s" });
  await h.event("session.compacted", { sessionID: "s" });
  await h.event("session.status", { sessionID: "s", status: { type: "retry" } });
  await h.event("session.error", { sessionID: "s", error: { message: "failed" } });
  await h.event("session.status", { sessionID: "s", status: { type: "idle" } });
  await h.event("session.idle", { sessionID: "s" });
  assert.deepEqual(h.payloads().map((p) => p.hook_event_name), [
    "PreCompact", "PostCompact", "UserPromptSubmit", "Stop",
  ]);
});

test("a subagent cannot override its parent's task state", async () => {
  const h = await setup();
  await h.event("session.created", { info: { id: "parent", directory: "/projects/one" } });
  await h.hooks["tool.execute.before"]({ sessionID: "parent", tool: "task" });
  await h.event("session.created", { info: { id: "child", parentID: "parent" } });
  await h.hooks["chat.message"]({ sessionID: "child" });
  await h.event("session.idle", { sessionID: "child" });
  await h.event("session.deleted", { info: { id: "child", parentID: "parent" } });
  assert.deepEqual(h.payloads().map((p) => p.hook_event_name), ["SessionStart", "PreToolUse"]);
});

test("project instances do not share session metadata", async () => {
  const h = await setup();
  await h.hooks["chat.message"]({ sessionID: "s", model: { modelID: "one" } });
  const second = await h.exports.vibemon({ directory: "/projects/two" });
  await second["tool.execute.before"]({ sessionID: "s", tool: "read" });
  await h.flush();
  assert.equal(h.payloads().at(-1).cwd, "/projects/two");
  assert.equal(h.payloads().at(-1).model, "");
});

test("queue serializes children, bounds their lifetime and drains after failure", async () => {
  const h = await setup({ autoClose: false });
  await h.hooks["tool.execute.before"]({ sessionID: "s", tool: "read" });
  await h.event("session.idle", { sessionID: "s" });
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
    await h.hooks["tool.execute.before"]({ sessionID: "s", tool: `tool-${i}` });
  }
  await h.event("session.idle", { sessionID: "s" });
  for (let i = 0; i < h.children.length; i++) h.children[i].child.emit("close", 0);
  assert.equal(h.children.length, 2);
  assert.equal(h.payloads().at(-1).hook_event_name, "Stop");
});

test("a burst across distinct sessions remains bounded", async () => {
  const h = await setup({ autoClose: false });
  for (let i = 0; i < 60; i++) {
    await h.hooks["tool.execute.before"]({ sessionID: `session-${i}`, tool: "read" });
  }
  for (let i = 0; i < h.children.length; i++) h.children[i].child.emit("close", 0);
  assert.equal(h.children.length, 33);
  assert.equal(h.payloads().at(-1).session_id, "session-59");
});
