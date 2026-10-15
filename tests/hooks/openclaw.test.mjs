import assert from "node:assert/strict";
import test from "node:test";
import { okResponse, openclaw } from "./plugin_harness.mjs";

const ctx = { runId: "r", sessionId: "s", sessionKey: "agent:main:s" };

test("status and health requests release their response streams", async () => {
  let released = 0;
  const h = await openclaw({
    pluginConfig: { autoLaunch: true, httpUrls: ["http://127.0.0.1:19280"] },
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([123, 125])); },
      cancel() { released++; },
    }), { status: 200 }),
  });
  await h.emit("gateway_start");
  assert.equal(released, h.requests.length);
  assert.ok(released >= 2);
});

test("connection diagnostics omit URL credentials, query secrets and raw transport errors", async () => {
  const h = await openclaw({
    pluginConfig: { debug: true, httpUrls: ["http://user:fixture-password@monitor/?key=fixture-query"], vibemonUrl: "https://user:fixture-password@cloud.example/?key=fixture-query", vibemonToken: "fixture-write" },
    fetch: async () => { throw new Error("fixture-private-transport-detail"); },
  });
  await h.emit("before_agent_run", {}, ctx);
  const output = h.logs.join("\n");
  for (const secret of ["fixture-password", "fixture-query", "fixture-write", "fixture-private-transport-detail"]) assert.ok(!output.includes(secret));
  assert.ok(output.includes("http://monitor"));
  assert.ok(output.includes("https://cloud.example"));
});

test("cloud delivery uses shared account identity without putting credentials in arguments", async () => {
  const h = await openclaw({
    env: { VIBEMON_OPENCLAW_ACCOUNT_ID: "work" },
    pluginConfig: { vibemonUrl: "https://cloud.example", vibemonToken: "fixture-write" },
  });
  await h.emit("before_agent_run", {}, ctx);
  const cloud = h.children.find(({ args }) => args.includes("--send-cloud"));
  assert.ok(cloud, "cloud reports use the shared Python transport");
  assert.deepEqual([...cloud.args], ["/home/test/.vibemon/vibemon_core.py", "--send-cloud", "openclaw"]);
  assert.equal(cloud.options.env.VIBEMON_URL, "https://cloud.example");
  assert.equal(cloud.options.env.VIBEMON_TOKEN, "fixture-write");
  assert.equal(cloud.options.env.VIBEMON_OPENCLAW_ACCOUNT_ID, "work");
  assert.equal(JSON.stringify(cloud.args).includes("fixture-write"), false);
  const sent = JSON.parse(cloud.child.raw);
  assert.equal(sent.state, "thinking");
  const local = h.requests.find(request => request.payload?.state === "thinking").payload;
  assert.deepEqual(sent.account, local.account);
  assert.equal(sent.sourceId, "agent:84718e3543c37148d811992cd3a6f77d4fdae75b02dff7d410b6b43c30dd536b");
  assert.equal(sent.sourceId, local.sourceId);
  assert.equal(sent.observedAt, local.observedAt);
  assert.equal(cloud.options.timeout, 5000);
  assert.equal(h.requests.some(request => request.url.includes("cloud.example")), false);
});

test("a failed cloud child releases the queued final status", async () => {
  const h = await openclaw({ autoClose: false, pluginConfig: {
    httpEnabled: false, vibemonUrl: "https://cloud.example", vibemonToken: "fixture-write",
  } });
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("agent_end", {}, ctx);
  await h.advance(3000);
  assert.equal(h.children.length, 1);
  h.children[0].child.emit("error", new Error("ENOENT"));
  h.children[0].child.emit("close", -1);
  await h.flush();
  assert.equal(h.children.length, 2);
  assert.equal(JSON.parse(h.children[1].child.raw).state, "done");
  h.children[1].child.emit("close", 0);
  await h.flush();
});

test("auto-launch delegates to the installed shared native launcher", async () => {
  const h = await openclaw({
    pluginConfig: { autoLaunch: true, httpUrls: ["http://127.0.0.1:19280"] },
    fetch: async (url) => ({ ok: !url.endsWith("/health"), status: 200, text: async () => "ok" }),
  });
  const started = h.emit("gateway_start");
  await h.flush();
  const launch = h.children.find(({ args }) => args.includes("--launch-desktop"));
  assert.equal(launch.command, "python3");
  assert.deepEqual([...launch.args], ["/home/test/.vibemon/vibemon_core.py", "--launch-desktop"]);
  assert.equal(launch.options.timeout, 5000);
  await h.advance(3000);
  await started;
});

test("tool failures return to thinking and failed runs finish", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_tool_call", { toolName: "exec", toolCallId: "t" }, ctx);
  await h.emit("after_tool_call", { toolName: "exec", toolCallId: "t", error: "failed" }, ctx);
  await h.emit("agent_end", { success: false }, ctx);
  await h.advance(3000);
  assert.deepEqual(h.states(), ["thinking", "working", "thinking", "done"]);
});

test("progress delivery never marks an active run done", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("message_sent", { success: true });
  await h.advance(10000);
  assert.deepEqual(h.states(), ["thinking"]);
});

test("parallel runs and tools remain active until the last one finishes", async () => {
  const h = await openclaw();
  const second = { runId: "r2", sessionId: "s2" };
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_agent_run", {}, second);
  await h.emit("before_tool_call", { toolName: "read", toolCallId: "a" }, second);
  await h.emit("before_tool_call", { toolName: "exec", toolCallId: "b" }, second);
  await h.emit("after_tool_call", { toolName: "exec", toolCallId: "b" }, second);
  assert.equal(h.states().at(-1), "working");
  assert.equal(h.requests.at(-1).payload.tool, "read");
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  assert.ok(!h.states().includes("done"));
  await h.emit("agent_end", { success: false }, second);
  await h.advance(3000);
  assert.equal(h.states().at(-1), "done");
});

test("a silent active run repeats its state as a heartbeat until it ends", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_tool_call", { toolName: "exec", toolCallId: "long" }, ctx);
  await h.advance(59999);
  assert.deepEqual(h.states(), ["thinking", "working"]);
  await h.advance(1);
  await h.advance(60000);
  assert.deepEqual(h.states(), ["thinking", "working", "working", "working"]);
  const beat = h.requests.at(-1).payload;
  assert.equal(beat.heartbeat, true);
  assert.equal(beat.tool, "exec");
  await h.emit("after_tool_call", { toolName: "exec", toolCallId: "long" }, ctx);
  assert.equal(h.requests.at(-1).payload.heartbeat, undefined);
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  await h.advance(600000);
  assert.deepEqual(h.states().slice(-2), ["thinking", "done"]);
});

test("usage and active model follow official llm_output fields and reset per run", async () => {
  const h = await openclaw({ config: { agents: { defaults: { model: "provider/default" } } } });
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("llm_output", {
    model: "actual", contextTokenBudget: 1000,
    usage: { input: 101, output: 50, cacheRead: 200, cacheWrite: 50 },
  }, ctx);
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  assert.equal(h.requests.at(-1).payload.model, "actual");
  assert.equal(h.requests.at(-1).payload.memory, 40.1);
  await h.emit("before_agent_run", {}, { runId: "next", sessionId: "s" });
  assert.equal(h.requests.at(-1).payload.memory, undefined);
  assert.equal(h.requests.at(-1).payload.model, "default");
});

test("compaction returns to thinking and late tool results cannot revive a run", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_compaction", {}, ctx);
  await h.emit("after_compaction", {}, ctx);
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  await h.emit("after_tool_call", { toolName: "read" }, ctx);
  assert.deepEqual(h.states(), ["thinking", "packing", "thinking", "done"]);
});

test("ending one session preserves another active session", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_agent_run", {}, { runId: "other", sessionId: "other" });
  await h.emit("session_end", { sessionId: "s" });
  assert.ok(!h.states().includes("done"));
  await h.emit("session_end", { sessionId: "other" });
  assert.equal(h.states().at(-1), "done");
});

test("HTTP lanes serialize states and retain only the latest pending update", async () => {
  let release;
  const h = await openclaw({
    pluginConfig: { httpUrls: ["http://slow/", "http://fast"] },
    fetch: async (url) => {
      if (url.startsWith("http://slow")) await new Promise((resolve) => { release = resolve; });
      return okResponse();
    },
  });
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_tool_call", { toolName: "read" }, ctx);
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  assert.equal(h.requests.filter((r) => r.url === "http://slow/status").length, 1);
  assert.equal(h.requests.filter((r) => r.url === "http://fast/status").at(-1).payload.state, "done");
  release();
  await h.flush();
  assert.deepEqual(h.requests.filter((r) => r.url === "http://slow/status").map((r) => r.payload.state), ["thinking", "done"]);
  assert.ok(h.timeouts.every((timeout) => timeout === 2500));
  release();
  await h.flush();
});

test("configured serial port uses bounded shared transport and reloads on change", async () => {
  const shared = "/home/test/.vibemon/config.json";
  const h = await openclaw({ files: {
    [shared]: JSON.stringify({ serial_port: "/dev/custom" }),
    "/dev/custom": "", "/dev/changed": "", "/dev/ttyACM0": "",
  } });
  await h.emit("before_agent_run", {}, ctx);
  assert.equal(h.children[0].args.at(-1), "/dev/custom");
  assert.ok(h.children[0].args.includes("--send-serial"));
  assert.equal(h.children[0].options.timeout, 5000);
  h.setFile(shared, JSON.stringify({ serial_port: "/dev/changed" }));
  await h.emit("before_tool_call", { toolName: "read" }, ctx);
  assert.equal(h.children.at(-1).args.at(-1), "/dev/changed");
});

test("shared settings honor environment overrides and hook suppression", async () => {
  const h = await openclaw({
    pluginConfig: { httpUrls: undefined },
    env: { VIBEMON_HTTP_URLS: "http://env", VIBEMON_SERIAL_PORT: "/dev/env" },
    files: { "/dev/env": "", "/home/test/.vibemon/config.json": JSON.stringify({ http_urls: ["http://shared"] }) },
  });
  await h.emit("before_agent_run", {}, ctx);
  assert.equal(h.requests[0].url, "http://env/status");
  assert.equal(h.children[0].args.at(-1), "/dev/env");
  const suppressed = await openclaw({ env: { VIBEMON_SUPPRESS_HOOKS: "1" } });
  await suppressed.emit("before_agent_run", {}, ctx);
  assert.equal(suppressed.requests.length, 0);
});

test("manual compaction does not leave a phantom active run", async () => {
  const h = await openclaw();
  await h.emit("before_compaction", {}, { sessionId: "s" });
  await h.emit("after_compaction", {}, { sessionId: "s" });
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  assert.equal(h.states().at(-1), "done");
});

test("compaction without a run id resolves the active session", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("before_tool_call", { toolName: "read" }, ctx);
  await h.emit("before_compaction", {}, { sessionId: "s" });
  await h.emit("after_compaction", {}, { sessionId: "s" });
  assert.equal(h.states().at(-1), "working");
  await h.emit("agent_end", { success: false }, ctx);
  await h.advance(3000);
  assert.equal(h.states().at(-1), "done");
});

test("gateway shutdown drains its final status", async () => {
  let release;
  const h = await openclaw({ fetch: async () => {
    await new Promise((resolve) => { release = resolve; });
    return okResponse();
  } });
  let stopped = false;
  const stop = h.emit("gateway_stop").then(() => { stopped = true; });
  await h.flush();
  assert.equal(stopped, false);
  assert.equal(h.requests.at(-1).payload.state, "done");
  release();
  await stop;
  assert.equal(stopped, true);
});

test("a rejected HTTP request releases the pending latest state", async () => {
  let reject;
  let first = true;
  const h = await openclaw({ fetch: async () => {
    if (first) {
      first = false;
      await new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    }
    return okResponse();
  } });
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("agent_end", { success: true }, ctx);
  await h.advance(3000);
  reject(new Error("request timed out"));
  await h.flush();
  assert.deepEqual(h.states(), ["thinking", "done"]);
});

test("an optional run id can appear after the start hook without leaking activity", async () => {
  const h = await openclaw();
  await h.emit("before_agent_run", {}, { sessionId: "s" });
  await h.emit("before_tool_call", { toolName: "read" }, ctx);
  await h.emit("agent_end", { success: true, runId: "r" });
  await h.advance(3000);
  assert.equal(h.states().at(-1), "done");
});

test("serial output needs a port setting and passes it to the shared transport", async () => {
  const h = await openclaw({ pluginConfig: { serialEnabled: true, httpEnabled: false } });
  await h.emit("before_agent_run", {}, ctx);
  assert.equal(h.children.length, 0);
  assert.ok(h.logs.some((message) => message.includes("Serial output needs serialPort")));
  const wildcard = await openclaw({ pluginConfig: { serialPort: "~/dev/cu.usbserial-*", httpEnabled: false } });
  await wildcard.emit("before_agent_run", {}, ctx);
  assert.equal(wildcard.children[0].args.slice(-2).join(" "), "--send-serial ~/dev/cu.usbserial-*");
});

test("a spawned subagent keeps the run's model on the working state", async () => {
  const h = await openclaw();
  await h.emit("model_call_started", { model: "fixture-model" }, ctx);
  await h.emit("before_agent_run", {}, ctx);
  await h.emit("model_call_started", { model: "fixture-model" }, ctx);
  await h.emit("subagent_spawned", {}, ctx);
  const last = h.requests.filter((r) => r.payload).at(-1).payload;
  assert.equal(last.state, "working");
  assert.equal(last.model, "fixture-model");
  assert.equal(last.tool, "subagent");
});
