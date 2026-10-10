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
 * - Serial: /dev/ttyACM* (Linux) or /dev/cu.usbmodem* (macOS)
 * - HTTP: POST to multiple URLs (array in config)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// Character configuration
const CHARACTER = "claw";

// State management
let currentState = "idle";
let doneTimer = null;
let ttyPath = null;
let lastSendTime = 0;
let lastPayload = "";
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

/**
 * Debug logging helper
 */
function debug(message) {
  if (config.debug && logger) {
    logger.info?.(`[vibemon] ${message}`);
  }
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
    debug(`Failed to read shared config: ${err.message}`);
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
    const previousPort = config.serialPort;
    config = resolveConfig();
    if (previousPort !== config.serialPort) ttyPath = null;
    lastPayload = "";
    debug(`Shared config reloaded (HTTP: ${config.httpEnabled}, ${config.httpUrls.length} URLs)`);
  }
}

/**
 * Clamp a raw percentage-ish number into an integer 0-100, or null if not
 * a finite number.
 */
function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
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
    if (typeof used === "number" && typeof budget === "number" && budget > 0) {
      const pct = clampPercent((used / budget) * 100);
      if (pct !== null) return pct;
    }
  }

  const budget = event.contextTokenBudget;
  const usage = event.usage;
  if (typeof budget === "number" && budget > 0 && usage && typeof usage === "object") {
    const components = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    const used = usage.total ?? usage.totalTokens ?? usage.total_tokens
      ?? (components.some(Number.isFinite)
        ? components.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0)
        : usage.inputTokens ?? usage.input_tokens);
    if (typeof used === "number") {
      const pct = clampPercent((used / budget) * 100);
      if (pct !== null) return pct;
    }
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

/**
 * Find available TTY device for ESP32
 */
function findTtyDevice() {
  const platform = process.platform;

  // macOS: /dev/cu.usbmodem*
  if (platform === "darwin") {
    try {
      const devices = fs.readdirSync("/dev").filter((f) => f.startsWith("cu.usbmodem"));
      if (devices.length > 0) {
        const device = `/dev/${devices[0]}`;
        if (fs.existsSync(device)) {
          try {
            fs.accessSync(device, fs.constants.W_OK);
            return device;
          } catch {
            debug(`Found ${device} but not writable`);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Linux: /dev/ttyACM*
  if (platform === "linux") {
    try {
      const devices = fs.readdirSync("/dev").filter((f) => f.startsWith("ttyACM"));
      if (devices.length > 0) {
        const device = `/dev/${devices[0]}`;
        if (fs.existsSync(device)) {
          try {
            fs.accessSync(device, fs.constants.W_OK);
            return device;
          } catch {
            debug(`Found ${device} but not writable (check dialout group)`);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Resolve a configured serial_port: expand `~`, and expand a single `*`
 * wildcard against the device directory (mirroring vibemon_core's
 * resolve_serial_port). Returns null when nothing matches.
 */
function resolveSerialPort(pattern) {
  if (typeof pattern !== "string" || !pattern) return null;

  let resolved = pattern.trim();
  if (resolved.startsWith("~")) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  if (!resolved.includes("*")) {
    return fs.existsSync(resolved) ? resolved : null;
  }

  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const regex = new RegExp(
    "^" + base.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  try {
    const matches = fs.readdirSync(dir).filter((name) => regex.test(name)).sort();
    return matches.length > 0 ? path.join(dir, matches[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Send status to ESP32 via serial
 */
function sendSerial(payload) {
  if (!config.serialEnabled) return;

  // Resolve the configured port first; fall back to auto-detection when no
  // explicit serial_port is set.
  if (!ttyPath) {
    ttyPath = config.serialPort
      ? resolveSerialPort(config.serialPort)
      : findTtyDevice();
    if (ttyPath) {
      debug(`Using TTY: ${ttyPath}`);
    }
  }

  if (!ttyPath) return;

  const port = ttyPath;
  enqueueSend(`serial:${port}`, () => new Promise((resolve) => {
    // Share Python's baud-rate setup, nonblocking writes and file locks with
    // every other agent. Never open a potentially blocking TTY in the gateway.
    const child = spawn("python3", [CORE_SCRIPT, "--send-serial", port], {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    child.on("error", () => { ttyPath = null; resolve(); });
    child.on("close", (code) => {
      if (code !== 0) ttyPath = null;
      resolve();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  }));
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
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Launch Desktop App via npx
 */
function launchDesktop() {
  debug("Launching Desktop App via npx...");

  try {
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-l", "-c", "npx vibemon@latest"], {
      detached: true,
      stdio: "ignore",
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

    if (!response.ok) {
      debug(`HTTP failed (${url}): ${response.status}`);
      return false;
    }
    debug(`HTTP sent: ${response.status}`);
    return true;
  } catch (err) {
    debug(`HTTP error (${url}): ${err.message}`);
    return false;
  }
}

/**
 * Send status to VibeMon API with Bearer token authentication
 */
async function sendVibeMonApi(payload, target = config) {
  // Check if VibeMon API is configured
  if (!target.vibemonUrl || !target.vibemonToken) {
    debug(`VibeMon API skipped: url=${config.vibemonUrl ? "set" : "empty"}, token=${config.vibemonToken ? "set" : "empty"}`);
    return false;
  }

  const project = payload.project || config.projectName;
  if (!project) {
    debug("VibeMon API skipped: no project name");
    return false;
  }

  // Build API URL (strip trailing slash) — /api/status, matching the
  // Python bridges (the cloud's bare /status only works via a rewrite)
  const baseUrl = target.vibemonUrl.replace(/\/+$/, "");
  const apiUrl = `${baseUrl}/api/status`;

  const apiPayload = {
    state: payload.state || "",
    project: project,
    tool: payload.tool || "",
    model: payload.model || "",
    ...(typeof payload.memory === "number" ? { memory: payload.memory } : {}),
    character: payload.character || CHARACTER,
  };


  try {
    const parsed = new URL(apiUrl);
    const localTest = process.env.VIBEMON_ALLOW_HTTP_LOCAL === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.protocol === "http:";
    if ((parsed.protocol !== "https:" && !localTest) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid cloud HTTPS URL");
    const response = await fetch(apiUrl, {
      redirect: "error",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.vibemonToken}`,
      },
      body: JSON.stringify(apiPayload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    await response.body?.cancel();

    if (!response.ok) {
      debug(`VibeMon API failed: ${response.status}`);
      if (logger) {
        logger.warn?.(`[vibemon] VibeMon API error: ${response.status}`);
      }
      return false;
    }

    debug(`VibeMon API success: ${response.status}`);
    return true;
  } catch (err) {
    debug(`VibeMon API error: ${err.name}`);
    if (logger) {
      logger.error?.(`[vibemon] VibeMon API error: ${err.name}`);
    }
    return false;
  }
}

/**
 * Build status payload
 */
function buildPayload(state, extra = {}) {
  const payload = {
    state,
    project: config.projectName,
    character: config.character,
    model: readModelFromConfig(),
    memory: undefined,
    ...extra,
  };

  return payload;
}

/**
 * Send status (debounced) - sends to all configured targets
 */
function sendStatus(state, extra = {}) {
  if (process.env.VIBEMON_SUPPRESS_HOOKS === "1") return;
  refreshConfig();

  const payload = buildPayload(state, extra);
  const signature = JSON.stringify(payload);
  const now = Date.now();
  if (now - lastSendTime < MIN_SEND_INTERVAL_MS && signature === lastPayload) {
    return;
  }
  lastSendTime = now;
  lastPayload = signature;
  currentState = state;

  // Queue serial output through the shared Python transport
  sendSerial(payload);

  if (config.httpEnabled) {
    for (const url of config.httpUrls) {
      enqueueSend(`http:${url}`, () => sendHttpToUrl(url, payload));
    }
  }
  if (config.vibemonUrl && config.vibemonToken) {
    const target = config;
    enqueueSend(`api:${target.vibemonUrl}`, () => sendVibeMonApi(payload, target));
  }
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
      try { await next(); } catch (err) { debug(`Send failed: ${err.message}`); }
    }
    sendLanes.delete(key);
  })();
  return lane.done;
}

/**
 * Cancel pending done timer
 */
function cancelDoneTimer() {
  if (doneTimer) {
    clearTimeout(doneTimer);
    doneTimer = null;
    debug("Done timer cancelled");
  }
}

/**
 * Schedule done state with delay
 */
function scheduleDone(extra = {}) {
  if (runs.size) return;
  cancelDoneTimer();
  debug(`Scheduling done in ${DONE_DELAY_MS}ms`);

  doneTimer = setTimeout(() => {
    doneTimer = null;
    debug("Done timer fired -> done");
    if (!runs.size) sendStatus("done", extra);
  }, DONE_DELAY_MS);
}

/**
 * Plugin definition
 */
const plugin = {
  id: "vibemon-bridge",
  name: "VibeMon Bridge",
  description: "Real-time status bridge for VibeMon (ESP32/Desktop)",
  version: "1.2.0",

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
      api.logger.info(`[vibemon] HTTP URLs: ${config.httpUrls.join(", ")}`);
    }
    // Log VibeMon API configuration
    // Never log token content: tokens can be as short as 8 chars, so even a
    // prefix can be the whole credential.
    if (config.vibemonUrl && config.vibemonToken) {
      api.logger.info(`[vibemon] VibeMon API: ${config.vibemonUrl} (token: set)`);
    } else {
      api.logger.info(`[vibemon] VibeMon API: disabled (url: ${config.vibemonUrl || "not set"}, token: ${config.vibemonToken ? "set" : "not set"})`);
    }

    // Find TTY device at startup
    if (config.serialEnabled) {
      ttyPath = config.serialPort ? resolveSerialPort(config.serialPort) : findTtyDevice();
      if (ttyPath) {
        api.logger.info(`[vibemon] TTY device: ${ttyPath}`);
      } else {
        api.logger.warn(`[vibemon] No TTY device found (ESP32 not connected?)`);
      }
    }

    function runKey(event, ctx) {
      const id = ctx?.runId || event?.runId;
      if (id && runs.has(id)) return id;
      const sessionId = ctx?.sessionId || event?.sessionId;
      const sessionKey = ctx?.sessionKey || event?.sessionKey;
      for (const [key, run] of runs) {
        if (id && run.runId === id) return key;
        if (id && run.runId && run.runId !== id) continue;
        if ((sessionId && run.sessionId === sessionId) ||
            (sessionKey && run.sessionKey === sessionKey)) return key;
      }
      return id || sessionKey || sessionId || "legacy";
    }

    function runContext(event, ctx) {
      const key = runKey(event, ctx);
      if (!runs.has(key)) {
        runs.set(key, {
          sessionId: ctx?.sessionId || event?.sessionId,
          sessionKey: ctx?.sessionKey || event?.sessionKey,
          model: ctx?.modelId || readModelFromConfig(),
          memory: undefined,
          tools: new Map(),
        });
      }
      const run = runs.get(key);
      run.runId ||= ctx?.runId || event?.runId;
      return run;
    }

    function metadata(run) {
      return { model: run?.model || readModelFromConfig(), memory: run?.memory };
    }

    function reportActive(preferred) {
      const working = [...runs.values()].find((run) => run.tools.size);
      const run = working || preferred || [...runs.values()].at(-1);
      sendStatus(working ? "working" : "thinking", {
        ...metadata(run),
        tool: working ? [...working.tools.values()].at(-1) : "",
      });
    }

    api.on("gateway_start", async () => {
      cancelDoneTimer();
      runs.clear();
      sendStatus("start", { note: "gateway_started" });
      await autoLaunchDesktop();
      // Preserve a turn that began while the desktop was launching.
      if (runs.size) reportActive();
      else if (currentState === "start") sendStatus("start");
    });

    const onAgentTurnStart = (event, ctx) => {
      cancelDoneTimer();
      reportActive(runContext(event, ctx));
    };
    api.on("before_agent_run", onAgentTurnStart);
    api.on("before_agent_start", onAgentTurnStart);

    api.on("subagent_spawned", () => {
      cancelDoneTimer();
      sendStatus("working");
    });

    api.on("before_tool_call", (event, ctx) => {
      cancelDoneTimer();
      const run = runContext(event, ctx);
      const tool = event?.toolName || ctx?.toolName || "unknown";
      run.tools.set(event?.toolCallId || ctx?.toolCallId || tool, tool);
      reportActive(run);
    });

    api.on("after_tool_call", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      if (!run) return; // A late result cannot revive a finished run.
      run.tools.delete(event?.toolCallId || ctx?.toolCallId || event?.toolName || ctx?.toolName || "unknown");
      reportActive(run);
    });

    api.on("before_compaction", (event, ctx) => {
      cancelDoneTimer();
      sendStatus("packing", metadata(runs.get(runKey(event, ctx))));
    });
    api.on("after_compaction", (event, ctx) => {
      const run = runs.get(runKey(event, ctx));
      if (run) reportActive(run);
      else sendStatus("thinking");
    });

    // llm_output is the public usage-bearing event. model_call_ended has
    // sanitized timing metadata only, so it cannot supply a usage gauge.
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

    // Channel messages may be progress updates; they are not proof that an
    // agent run has finished. Retain the fallback only when no run is active.
    api.on("message_sent", (event) => {
      if (event?.success && !doneTimer && currentState !== "done") scheduleDone();
    });

    api.on("agent_end", (event, ctx) => {
      const key = runKey(event, ctx);
      const run = runs.get(key);
      runs.delete(key);
      if (runs.size) reportActive();
      else scheduleDone(metadata(run));
    });

    api.on("session_end", (event, ctx) => {
      const sessionId = event?.sessionId || ctx?.sessionId;
      const sessionKey = event?.sessionKey || ctx?.sessionKey;
      for (const [key, run] of runs) {
        if ((sessionId && run.sessionId === sessionId) ||
            (sessionKey && run.sessionKey === sessionKey) ||
            (!sessionId && !sessionKey && key === "legacy")) runs.delete(key);
      }
      cancelDoneTimer();
      if (runs.size) reportActive();
      else sendStatus("done");
    });

    api.on("gateway_stop", async () => {
      cancelDoneTimer();
      runs.clear();
      sendStatus("done", { note: "gateway_stopped" });
      await Promise.allSettled([...sendLanes.values()].map((lane) => lane.done));
    });
  },
};

export default plugin;
