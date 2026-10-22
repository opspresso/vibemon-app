/**
 * VibeMon Bridge Plugin for OpenClaw
 *
 * Sends real-time agent status to VibeMon (ESP32/Desktop) via hooks.
 * This is more reliable than log-based monitoring.
 *
 * Hooks used:
 * - before_agent_run (fallback: deprecated before_agent_start) -> thinking
 * - before_tool_call / after_tool_call -> working / thinking
 * - subagent_spawned -> working
 * - agent_end -> done (after all active runs finish, including failures)
 * - before_compaction / after_compaction -> packing / thinking
 * - gateway_start -> start
 *
 * Output:
 * - Serial: the configured port, resolved and written by vibemon_core.py
 * - HTTP: POST to multiple URLs (array in config)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// Character configuration
const CHARACTER = "claw";

// Each agent/workspace has independent activity, debounce and heartbeat state.
const groups = new Map();
const pendingIdentities = new Set();
let hostConfig = {};
const runs = new Map();
const sendLanes = new Map();
const HTTP_TIMEOUT_MS = 2500;
const CORE_SCRIPT = path.join(os.homedir(), ".vibemon", "vibemon_core.py");

// Built-in defaults (lowest precedence)
const DEFAULT_CONFIG = {
  projectName: "OpenClaw",
  character: CHARACTER,
  serialEnabled: false,
  httpEnabled: false,
  httpUrls: ["http://127.0.0.1:19280"],
  autoLaunch: false,
  debug: false,
  vibemonUrl: null,
  vibemonToken: null,
};

// Effective configuration (resolved in register, refreshed on send)
let config = { ...DEFAULT_CONFIG };

// Plugin config from openclaw.json (highest precedence, set in register)
let pluginConfig = {};

// Shared VibeMon config (~/.vibemon/config.json) — also read by the
// Claude/Codex/Kiro hooks, and kept pointed at the Desktop app by the app
// itself. Transmission settings (http_urls, serial_port, vibemon_url,
// vibemon_token) fall back to it so OpenClaw gets the same auto-managed
// targets; explicit plugin config in openclaw.json always wins.
const SHARED_CONFIG_PATH = path.join(os.homedir(), ".vibemon", "config.json");
let sharedConfig = {};
let sharedConfigMtime = null;

let logger = null;

// Delay before sending done (prevents premature done on multi-turn)
const DONE_DELAY_MS = 3000;

// Minimum interval between sends (debounce)
const MIN_SEND_INTERVAL_MS = 100;

// While a run is active, repeat its state after this much silence. Displays
// age an active state to idle after 5 minutes without a report.
const HEARTBEAT_MS = 60000;
const ACTIVE_STATES = new Set(["thinking", "planning", "working", "packing", "notification"]);

/**
 * Debug logging helper
 */
function debug(message) {
  if (config.debug && logger) {
    logger.info?.(`[vibemon] ${message}`);
  }
}

function targetLabel(value) {
  try { return new URL(value).origin; }
  catch { return "invalid address"; }
}

/**
 * (Re)load ~/.vibemon/config.json if it changed on disk (mtime check).
 * Returns true when sharedConfig was updated.
 */
function loadSharedConfig() {
  let stat = null;
  try {
    stat = fs.statSync(SHARED_CONFIG_PATH);
  } catch {
    // File missing
  }

  if (!stat) {
    if (sharedConfigMtime === null) return false;
    sharedConfigMtime = null;
    sharedConfig = {};
    return true;
  }

  if (stat.mtimeMs === sharedConfigMtime) return false;
  sharedConfigMtime = stat.mtimeMs;

  try {
    const json = JSON.parse(fs.readFileSync(SHARED_CONFIG_PATH, "utf-8"));
    sharedConfig = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  } catch (err) {
    debug(`Failed to read shared config: ${err.name}`);
    sharedConfig = {};
  }
  return true;
}

/**
 * First value that is not undefined/null/"" (empty string means "not set"
 * in both openclaw.json and ~/.vibemon/config.json), or null.
 */
function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/**
 * Resolve the effective config: pluginConfig (openclaw.json) > env >
 * sharedConfig (~/.vibemon/config.json) > built-in defaults.
 *
 * A non-empty shared http_urls implies HTTP output on, and a shared
 * serial_port implies serial output on — matching how the vibemon.py hooks
 * interpret the same file. An explicit boolean in pluginConfig overrides.
 */
function resolveConfig() {
  const urls = (value) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim());
  const sharedHttpUrls = urls(process.env.VIBEMON_HTTP_URLS ?? sharedConfig.http_urls);
  const pluginHttpUrls = Array.isArray(pluginConfig.httpUrls)
    ? pluginConfig.httpUrls.filter((u) => typeof u === "string" && u)
    : [];

  const serialPort = firstNonEmpty(
    pluginConfig.serialPort,
    process.env.VIBEMON_SERIAL_PORT,
    sharedConfig.serial_port,
    null,
  );

  return {
    projectName: pluginConfig.projectName ?? DEFAULT_CONFIG.projectName,
    character: pluginConfig.character ?? DEFAULT_CONFIG.character,
    serialEnabled: typeof pluginConfig.serialEnabled === "boolean"
      ? pluginConfig.serialEnabled
      : Boolean(serialPort),
    serialPort,
    httpEnabled: typeof pluginConfig.httpEnabled === "boolean"
      ? pluginConfig.httpEnabled
      : pluginHttpUrls.length > 0 || sharedHttpUrls.length > 0,
    httpUrls: pluginHttpUrls.length > 0
      ? pluginHttpUrls
      : sharedHttpUrls.length > 0
        ? sharedHttpUrls
        : DEFAULT_CONFIG.httpUrls,
    autoLaunch: typeof pluginConfig.autoLaunch === "boolean"
      ? pluginConfig.autoLaunch
      : process.env.VIBEMON_AUTO_LAUNCH !== undefined
        ? process.env.VIBEMON_AUTO_LAUNCH === "1"
        : typeof sharedConfig.auto_launch === "boolean"
        ? sharedConfig.auto_launch
        : DEFAULT_CONFIG.autoLaunch,
    debug: pluginConfig.debug ?? (process.env.DEBUG !== undefined
      ? process.env.DEBUG === "1" : sharedConfig.debug === true),
    vibemonUrl: firstNonEmpty(
      pluginConfig.vibemonUrl,
      process.env.VIBEMON_URL,
      sharedConfig.vibemon_url,
      DEFAULT_CONFIG.vibemonUrl,
    ),
    vibemonToken: firstNonEmpty(
      pluginConfig.vibemonToken,
      process.env.VIBEMON_TOKEN,
      sharedConfig.vibemon_token,
      DEFAULT_CONFIG.vibemonToken,
    ),
  };
}

/**
 * Re-resolve config if ~/.vibemon/config.json changed (e.g. the Desktop app
 * updated http_urls after the gateway started).
 */
function refreshConfig() {
  if (loadSharedConfig()) {
    config = resolveConfig();
    for (const group of groups.values()) group.lastPayload = "";
    debug(`Shared config reloaded (HTTP: ${config.httpEnabled}, ${config.httpUrls.length} URLs)`);
  }
}

/**
 * Cap an available non-negative percentage at 100 without rounding.
 */
function clampPercent(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

function contextPercent(used, budget) {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(budget) || budget <= 0) return null;
  return Math.min(1, used / budget) * 100;
}

/**
 * Extract a 0-100 context-window usage percentage from an OpenClaw
 * llm_output event. The official usage fields are input/output/cacheRead/
 * cacheWrite/total; older usageState and token-name forms remain supported.
 */
function extractMemoryPercent(event) {
  if (!event || typeof event !== "object") return null;

  const usageState = event.usageState;
  const ctx = usageState && typeof usageState === "object"
    ? usageState.context || usageState.contextWindow
    : null;
  if (ctx && typeof ctx === "object") {
    if (typeof ctx.percentage === "number") {
      const pct = clampPercent(ctx.percentage);
      if (pct !== null) return pct;
    }
    const used = ctx.usedTokens ?? ctx.used_tokens;
    const budget = ctx.budgetTokens ?? ctx.budget_tokens;
    const pct = contextPercent(used, budget);
    if (pct !== null) return pct;
  }

  const budget = event.contextTokenBudget;
  const usage = event.usage;
  if (usage && typeof usage === "object") {
    const components = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].filter(value => value != null);
    const used = usage.total ?? usage.totalTokens ?? usage.total_tokens
      ?? (components.length
        ? components.every(n => Number.isFinite(n) && n >= 0) ? components.reduce((sum, n) => sum + n, 0) : null
        : usage.inputTokens ?? usage.input_tokens);
    return contextPercent(used, budget);
  }

  return null;
}

/**
 * Read the fallback model from the host's parsed configuration.
 */
function readModelFromConfig() {
  const value = hostConfig?.agents?.defaults?.model;
  const model = typeof value === "string" ? value : value?.primary;
  return typeof model === "string" ? model.split("/").pop() : "";
}

// Shared transport owns serial locking and cloud account/credential boundaries.
function sendCorePayload(args, payload, env = process.env) {
  return new Promise(resolve => {
    const child = spawn("python3", [CORE_SCRIPT, ...args], {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
      killSignal: "SIGKILL",
      windowsHide: true,
      env,
    });
    let inputFailed = false;
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0 && !inputFailed));
    child.stdin.on("error", () => { inputFailed = true; });
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  });
}

/**
 * Get Desktop App URL from config (localhost or 127.0.0.1)
 */
function getDesktopAppUrl() {
  return config.httpUrls.find((url) => {
    try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); }
    catch { return false; }
  });
}

/**
 * Check if Desktop App is running
 */
async function isDesktopRunning() {
  const desktopUrl = getDesktopAppUrl();
  if (!desktopUrl) return false;

  try {
    const response = await fetch(`${desktopUrl.replace(/\/+$/, "")}/health`, {
      method: "GET", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Use the shared native-package launcher.
 */
function launchDesktop() {
  debug("Launching installed Desktop App...");

  try {
    const child = spawn("python3", [CORE_SCRIPT, "--launch-desktop"], {
      detached: true,
      stdio: "ignore",
      timeout: 5000,
    });
    child.on("error", (err) => debug(`Desktop launch failed: ${err.message}`));
    child.unref();
    debug("Desktop App launch command sent");
  } catch (err) {
    debug(`Failed to launch Desktop App: ${err.message}`);
  }
}

/**
 * Auto-launch Desktop App if not running
 */
async function autoLaunchDesktop() {
  if (!config.autoLaunch) return;

  // Only auto-launch if Desktop App URL is configured
  const desktopUrl = getDesktopAppUrl();
  if (!desktopUrl) return;

  const running = await isDesktopRunning();
  if (!running) {
    debug("Desktop App not running, launching...");
    launchDesktop();
    // Wait for Desktop App to start
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/**
 * Send status to a single HTTP URL
 */
async function sendHttpToUrl(url, payload) {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await response.body?.cancel();

    if (!response.ok) {
      debug(`HTTP failed (${targetLabel(url)}): ${response.status}`);
      return false;
    }
    debug(`HTTP sent: ${response.status}`);
    return true;
  } catch (err) {
    debug(`HTTP error (${targetLabel(url)}): ${err.name}`);
    return false;
  }
}

/**
 * Send status to VibeMon API with Bearer token authentication
 */
async function sendVibeMonApi(payload, target = config) {
  // Check if VibeMon API is configured
  if (!target.vibemonUrl || !target.vibemonToken) {
    debug(`VibeMon API skipped: url=${target.vibemonUrl ? "set" : "empty"}, token=${target.vibemonToken ? "set" : "empty"}`);
    return false;
  }

  const ok = await sendCorePayload(["--send-cloud", "openclaw"], payload, {
    ...process.env,
    VIBEMON_URL: target.vibemonUrl,
    VIBEMON_TOKEN: target.vibemonToken,
  });
  if (!ok) logger?.warn?.("[vibemon] Cloud delivery failed. Check Python, the shared installation, and the VibeMon write-token configuration.");
  return ok;
}

/**
 * Build status payload
 */
function buildPayload(state, extra = {}) {
  return {
    state,
    project: config.projectName,
    character: config.character,
    model: readModelFromConfig(),
    memory: undefined,
    ...extra,
  };
}

function sourceIdentity(group) {
  if (group.identity) return group.identity;
  group.identity = new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error("Account identity unavailable")); } };
    let child;
    try {
      child = spawn("python3", [CORE_SCRIPT, "--resolve-plugin-account", "openclaw"], {
        stdio: ["pipe", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL", windowsHide: true,
      });
    } catch { fail(); return; }
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.length > 8192) { child.kill?.("SIGKILL"); fail(); }
    });
    child.on("close", code => {
      if (settled) return;
      try {
        const value = JSON.parse(output);
        if (code !== 0 || value.account?.provider !== "openclaw" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.account?.id) ||
            typeof value.account?.displayName !== "string" || !value.account.displayName.trim() ||
            value.account.displayName.length > 128 || !/^agent:[a-f0-9]{64}$/.test(value.sourceId)) { fail(); return; }
        settled = true;
        resolve({ account: value.account, sourceId: value.sourceId });
      } catch { fail(); }
    });
    child.stdin.end(JSON.stringify({
      project: group.project, cwd: group.cwd, session_id: group.key,
      hook_event_name: "SessionStart", account_hint: group.hint,
    }));
    child.unref?.();
  }).catch(error => { group.identity = null; throw error; });
  return group.identity;
}

function groupFor(ctx = {}) {
  const agent = typeof ctx.agentId === "string" && ctx.agentId ? ctx.agentId : "main";
  const cwd = typeof ctx.workspaceDir === "string" && ctx.workspaceDir ? ctx.workspaceDir : process.cwd();
  const key = JSON.stringify([agent, cwd]);
  if (!groups.has(key)) {
    const account = pluginConfig.accounts?.[agent];
    const hint = { agent_id: agent };
    if (account && typeof account === "object") {
      hint.manual_id = account.id;
      hint.manual_name = account.displayName;
    }
    // Receivers count UTF-16 units; keep complete characters at that boundary.
    let project = "";
    for (const character of agent === "main" ? config.projectName : `${config.projectName} · ${agent}`) {
      if (project.length + character.length > 128) break;
      project += character;
    }
    groups.set(key, { key, agent, cwd, project, hint, identity: null,
      runs: new Map(), currentState: "idle", lastSendTime: 0, lastPayload: "", lastStatus: null,
      heartbeatTimer: null, doneTimer: null });
  }
  return groups.get(key);
}

function sendStatus(group, state, extra = {}) {
  if (process.env.VIBEMON_SUPPRESS_HOOKS === "1") return;
  refreshConfig();
  const fields = { ...buildPayload(state, extra), project: group.project };
  const signature = JSON.stringify(fields);
  const now = Date.now();
  if (now - group.lastSendTime < MIN_SEND_INTERVAL_MS && signature === group.lastPayload) return;
  group.lastSendTime = now;
  group.lastPayload = signature;
  group.currentState = state;
  const { heartbeat, ...values } = extra;
  if (!heartbeat) group.lastStatus = { state, fields: values };
  updateHeartbeat(group);
  if (!(config.httpEnabled && config.httpUrls.length) && !(config.serialEnabled && config.serialPort) &&
      !(config.vibemonUrl && config.vibemonToken)) return;
  const target = config;
  const pending = sourceIdentity(group).then(identity => {
    const payload = { ...fields, ...identity, observedAt: new Date(now).toISOString() };
    if (target.serialEnabled && target.serialPort) {
      enqueueSend(`${group.key}:serial:${target.serialPort}`, () => sendCorePayload(["--send-serial", target.serialPort], payload));
    }
    if (target.httpEnabled) for (const url of target.httpUrls) {
      enqueueSend(`${group.key}:http:${url}`, () => sendHttpToUrl(url, payload));
    }
    if (target.vibemonUrl && target.vibemonToken) {
      const report = { ...payload, cwd: group.cwd, session_id: group.key, account_hint: group.hint };
      enqueueSend(`${group.key}:api:${target.vibemonUrl}`, () => sendVibeMonApi(report, target));
    }
  }).catch(() => logger?.warn?.("[vibemon] Account identity unavailable. Check Python and the shared integration installation."));
  pendingIdentities.add(pending);
  pending.finally(() => pendingIdentities.delete(pending));
}

// One request per target at a time, retaining only its newest pending state.
// A slow endpoint cannot reorder statuses or delay another healthy endpoint.
function enqueueSend(key, send) {
  let lane = sendLanes.get(key);
  if (lane) { lane.pending = send; return lane.done; }
  lane = { pending: send };
  sendLanes.set(key, lane);
  lane.done = (async () => {
    while (lane.pending) {
      const next = lane.pending;
      lane.pending = null;
      try { await next(); } catch (err) { debug(`Send failed: ${err.name}`); }
    }
    sendLanes.delete(key);
  })();
  return lane.done;
}

function updateHeartbeat(group) {
  if (group.heartbeatTimer) clearTimeout(group.heartbeatTimer);
  group.heartbeatTimer = null;
  if (!group.runs.size || !group.lastStatus || !ACTIVE_STATES.has(group.lastStatus.state)) return;
  group.heartbeatTimer = setTimeout(() => {
    group.heartbeatTimer = null;
    if (group.runs.size) sendStatus(group, group.lastStatus.state, { ...group.lastStatus.fields, heartbeat: true });
  }, HEARTBEAT_MS);
  group.heartbeatTimer.unref?.();
}

function cancelDoneTimer(group) {
  if (group.doneTimer) clearTimeout(group.doneTimer);
  group.doneTimer = null;
}

function scheduleDone(group, extra = {}) {
  if (group.runs.size) return;
  cancelDoneTimer(group);
  group.doneTimer = setTimeout(() => {
    group.doneTimer = null;
    if (!group.runs.size) sendStatus(group, "done", extra);
  }, DONE_DELAY_MS);
}

/**
 * Plugin definition
 */
const plugin = {
  id: "vibemon-bridge",
  name: "VibeMon Bridge",
  description: "Real-time status bridge for VibeMon (ESP32/Desktop)",
  version: "1.3.0",

  register(api) {
    logger = api.logger;
    hostConfig = api.config || {};

    // Resolve config: openclaw.json plugin config > env > shared config
    pluginConfig = api.pluginConfig || {};
    loadSharedConfig();
    config = resolveConfig();

    api.logger.info(`[vibemon] Plugin loaded`);
    api.logger.info(`[vibemon] Project: ${config.projectName}, Character: ${config.character}`);
    api.logger.info(`[vibemon] Serial: ${config.serialEnabled}, HTTP: ${config.httpEnabled} (${config.httpUrls.length} URLs), AutoLaunch: ${config.autoLaunch}`);
    if (config.httpEnabled && config.httpUrls.length > 0) {
      api.logger.info(`[vibemon] HTTP origins: ${config.httpUrls.map(targetLabel).join(", ")}`);
    }
    // Log VibeMon API configuration. Never log any part of the token: logs
    // leave the machine more easily than the configuration file.
    if (config.vibemonUrl && config.vibemonToken) {
      api.logger.info(`[vibemon] VibeMon API: ${targetLabel(config.vibemonUrl)} (token: set)`);
    } else {
      api.logger.info(`[vibemon] VibeMon API: disabled (url: ${config.vibemonUrl ? targetLabel(config.vibemonUrl) : "not set"}, token: ${config.vibemonToken ? "set" : "not set"})`);
    }

    if (config.serialEnabled && !config.serialPort) {
      api.logger.warn("[vibemon] Serial output needs serialPort or serial_port in ~/.vibemon/config.json");
    }

    function runKey(event, ctx) {
      const id = ctx?.runId || event?.runId;
      const sessionId = ctx?.sessionId || event?.sessionId;
      const sessionKey = ctx?.sessionKey || event?.sessionKey;
      const matches = [];
      for (const [key, run] of runs) {
        if (ctx?.agentId && run.group.agent !== ctx.agentId) continue;
        if (ctx?.workspaceDir && run.group.cwd !== ctx.workspaceDir) continue;
        if (id && run.runId === id) { matches.push(key); continue; }
        if (id && run.runId && run.runId !== id) continue;
        if ((sessionId && run.sessionId === sessionId) || (sessionKey && run.sessionKey === sessionKey)) matches.push(key);
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
      return JSON.stringify([ctx?.agentId || "main", ctx?.workspaceDir || process.cwd(), id || sessionKey || sessionId || "legacy"]);
    }

    function runContext(event, ctx) {
      const key = runKey(event, ctx);
      if (key === null) return null;
      if (!runs.has(key)) {
        const group = groupFor(ctx);
        const run = { group, sessionId: ctx?.sessionId || event?.sessionId, sessionKey: ctx?.sessionKey || event?.sessionKey,
          model: ctx?.modelId || readModelFromConfig(), memory: undefined, tools: new Map() };
        runs.set(key, run);
        group.runs.set(key, run);
      }
      const run = runs.get(key);
      run.runId ||= ctx?.runId || event?.runId;
      return run;
    }

    function removeRun(key) {
      const run = runs.get(key);
      if (run) { run.group.runs.delete(key); runs.delete(key); }
      return run;
    }

    function metadata(run) { return { model: run?.model || readModelFromConfig(), memory: run?.memory }; }

    function reportActive(group, preferred) {
      const working = [...group.runs.values()].find(run => run.tools.size);
      const run = working || preferred || [...group.runs.values()].at(-1);
      sendStatus(group, working ? "working" : "thinking", { ...metadata(run), tool: working ? [...working.tools.values()].at(-1) : "" });
    }

    api.on("gateway_start", async () => {
      for (const group of groups.values()) { cancelDoneTimer(group); group.runs.clear(); updateHeartbeat(group); }
      runs.clear();
      const group = groupFor();
      sendStatus(group, "start", { note: "gateway_started" });
      await autoLaunchDesktop();
      for (const active of groups.values()) if (active.runs.size) reportActive(active);
      if (!runs.size && group.currentState === "start") sendStatus(group, "start");
    });

    const onAgentTurnStart = (event, ctx) => {
      const run = runContext(event, ctx);
      if (!run) return;
      cancelDoneTimer(run.group);
      reportActive(run.group, run);
    };
    api.on("before_agent_run", onAgentTurnStart);
    api.on("before_agent_start", onAgentTurnStart);

    api.on("subagent_spawned", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      const group = run?.group || groupFor(ctx);
      cancelDoneTimer(group);
      sendStatus(group, "working", { ...metadata(run), tool: "subagent" });
    });
    api.on("before_tool_call", (event, ctx) => {
      const run = runContext(event, ctx);
      if (!run) return;
      cancelDoneTimer(run.group);
      const tool = event?.toolName || ctx?.toolName || "unknown";
      run.tools.set(event?.toolCallId || ctx?.toolCallId || tool, tool);
      reportActive(run.group, run);
    });
    api.on("after_tool_call", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      if (!run) return;
      run.tools.delete(event?.toolCallId || ctx?.toolCallId || event?.toolName || ctx?.toolName || "unknown");
      reportActive(run.group, run);
    });
    api.on("before_compaction", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      const group = run?.group || groupFor(ctx);
      cancelDoneTimer(group);
      sendStatus(group, "packing", metadata(run));
    });
    api.on("after_compaction", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      if (run) reportActive(run.group, run);
      else sendStatus(groupFor(ctx), "thinking");
    });
    api.on("llm_output", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      if (!run) return;
      if (typeof event?.model === "string") run.model = event.model;
      run.memory = extractMemoryPercent(event);
    });
    api.on("model_call_started", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      if (run && typeof event?.model === "string") run.model = event.model;
    });
    api.on("message_sent", (event, ctx) => {
      const group = groupFor(ctx);
      if (event?.success && !group.doneTimer && group.currentState !== "done") scheduleDone(group);
    });
    api.on("agent_end", (event, ctx) => {
      const run = removeRun(runKey(event, ctx));
      if (!run) return;
      if (run.group.runs.size) reportActive(run.group);
      else scheduleDone(run.group, metadata(run));
    });
    api.on("session_end", (event, ctx) => {
      const sessionId = event?.sessionId || ctx?.sessionId;
      const sessionKey = event?.sessionKey || ctx?.sessionKey;
      const affected = new Set();
      for (const [key, run] of runs) {
        if (ctx?.agentId && run.group.agent !== ctx.agentId) continue;
        if ((sessionId && run.sessionId === sessionId) || (sessionKey && run.sessionKey === sessionKey) ||
            (!sessionId && !sessionKey && !run.runId && !run.sessionId && !run.sessionKey)) {
          affected.add(run.group); removeRun(key);
        }
      }
      for (const group of affected) {
        cancelDoneTimer(group);
        if (group.runs.size) reportActive(group);
        else sendStatus(group, "done");
      }
    });
    api.on("gateway_stop", async () => {
      if (!groups.size) groupFor();
      runs.clear();
      for (const group of groups.values()) {
        cancelDoneTimer(group); group.runs.clear(); sendStatus(group, "done", { note: "gateway_stopped" });
      }
      await Promise.allSettled([...pendingIdentities]);
      await Promise.allSettled([...sendLanes.values()].map(lane => lane.done));
    });
  },
};

export default plugin;
