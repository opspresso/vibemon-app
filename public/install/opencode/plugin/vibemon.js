/**
 * VibeMon Plugin for opencode 2.x
 *
 * This plugin sends opencode session state to VibeMon. It spawns the adapter
 * (~/.config/opencode/hooks/vibemon.py), which feeds the shared transport
 * (~/.vibemon/vibemon_core.py) like the Claude Code, Codex, Kiro, and
 * OpenClaw integrations.
 *
 * opencode 2.x loads the default export `{ id, setup }`. opencode 1.x cannot
 * load this file.
 *
 * Source (tool hook or bus event)         Hook event          State
 *   session.created                    -> SessionStart       -> start
 *   session.execution.started          -> UserPromptSubmit   -> thinking
 *   session.retry.scheduled            -> UserPromptSubmit   -> thinking
 *   tool hook execute.before           -> PreToolUse         -> working
 *   tool hook execute.after            -> PostToolUse        -> thinking
 *   permission.asked                   -> PermissionRequest  -> notification
 *   session.compaction.started         -> PreCompact         -> packing
 *   session.compaction.ended           -> PostCompact        -> thinking
 *   session.execution.succeeded,
 *     .failed, .interrupted            -> Stop               -> done
 *   session.deleted                    -> SessionEnd         -> done
 *
 * opencode auto-discovers plugins in ~/.config/opencode/plugins/ at startup,
 * so no config merge is needed. install.py inspects the PYTHON / HOOK_SCRIPT
 * constants below and, on Windows or a custom config home, rewrites them with
 * absolute paths at install time.
 */

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const OPENCODE_HOME = path.join(os.homedir(), ".config", "opencode");
const HOOK_SCRIPT = path.join(OPENCODE_HOME, "hooks", "vibemon.py");
const PYTHON = "python3";

// Serialize adapter children and bound both the backlog and each child's
// lifetime, so a stalled transport cannot stop subsequent state updates.
const MAX_QUEUED_PAYLOADS = 32;
const ADAPTER_TIMEOUT_MS = 10000;

const payloadQueue = [];
let draining = false;

function dispatch(payload) {
  const pending = payloadQueue.findIndex((entry) =>
    entry.session_id === payload.session_id && entry.cwd === payload.cwd);
  if (pending !== -1) payloadQueue.splice(pending, 1);
  payloadQueue.push(payload);
  if (payloadQueue.length > MAX_QUEUED_PAYLOADS) {
    // Drop the oldest, not the newest: the latest state must still be sent.
    payloadQueue.shift();
  }
  drain();
}

function drain() {
  if (draining) return;
  const next = payloadQueue.shift();
  if (next === undefined) return;
  draining = true;
  spawnAdapter(next);
}

function spawnAdapter(payload) {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    draining = false;
    drain();
  };

  let child;
  try {
    child = spawn(PYTHON, [HOOK_SCRIPT], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      timeout: ADAPTER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch {
    settle();
    return;
  }

  child.on("error", settle);
  child.on("close", settle);
  child.stdin.on("error", () => {});
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {
    // spawn/error or exit settles this child.
  }
  if (child.unref) child.unref();
}

function text(value) {
  return typeof value === "string" ? value : "";
}

// opencode 2.x sends `{ id, providerID }` model references.
function modelName(model) {
  return text(model) || text(model?.id);
}

// opencode calls setup once per project instance in one server. Each call
// keeps its own session map, so metadata cannot leak between projects.
function setup(ctx) {
  const defaultDir = text(ctx.location?.directory) || process.cwd();
  const sessions = new Map();

  function session(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, { directory: defaultDir, agent: "", model: "" });
    }
    return sessions.get(sessionID);
  }

  function sendStatus(eventName, sessionID, tool = "") {
    const state = session(sessionID);
    // The parent's subagent tool already represents child work. A child's
    // completion must not mark the still-running parent as done.
    if (state.parentID) return;
    if (eventName === "Stop" && state.lastEvent === "Stop") return;
    state.lastEvent = eventName;
    dispatch({
      hook_event_name: eventName,
      session_id: sessionID,
      tool_name: text(tool),
      cwd: state.directory,
      transcript_path: "",
      permission_mode: state.agent === "plan" ? "plan" : "default",
      model: state.model,
    });
  }

  // Bus events carry their fields in `event.data`. Streaming deltas
  // (session.text.*, session.reasoning.*, session.tool.*) are ignored: they
  // arrive many times per step and add no state.
  function onEvent(event) {
    const data = event?.data || {};
    const sessionID = text(data.sessionID);
    if (!sessionID) return;

    switch (event.type) {
      case "session.created": {
        const state = session(sessionID);
        state.directory = text(data.location?.directory) || state.directory;
        state.parentID = text(data.parentID) || state.parentID;
        state.model = modelName(data.model) || state.model;
        state.agent = text(data.agent) || state.agent;
        sendStatus("SessionStart", sessionID);
        break;
      }
      case "session.step.started": {
        const state = session(sessionID);
        state.model = modelName(data.model) || state.model;
        state.agent = text(data.agent) || state.agent;
        break;
      }
      case "session.execution.started":
      case "session.retry.scheduled":
        sendStatus("UserPromptSubmit", sessionID);
        break;
      case "permission.asked":
        sendStatus("PermissionRequest", sessionID, data.action);
        break;
      case "session.compaction.started":
        sendStatus("PreCompact", sessionID);
        break;
      case "session.compaction.ended":
        sendStatus("PostCompact", sessionID);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        sendStatus("Stop", sessionID);
        break;
      case "session.deleted":
        sendStatus("SessionEnd", sessionID);
        sessions.delete(sessionID);
        break;
    }
  }

  // Tool hooks run inside opencode's tool call, so a bridge failure must not
  // escape them.
  const toolHook = (eventName) => (event) => {
    try {
      const sessionID = text(event?.sessionID);
      if (!sessionID) return;
      const state = session(sessionID);
      state.agent = text(event.agent) || state.agent;
      sendStatus(eventName, sessionID, event.tool);
    } catch {
      // Never let a bridge failure affect opencode.
    }
  };
  ctx.tool.hook("execute.before", toolHook("PreToolUse"));
  ctx.tool.hook("execute.after", toolHook("PostToolUse"));

  const abort = new AbortController();
  (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      try {
        onEvent(event);
      } catch {
        // Never let a bridge failure affect opencode.
      }
    }
  })().catch(() => {
    // The stream ends when the plugin unloads.
  });

  return () => abort.abort();
}

export default { id: "vibemon", setup };
