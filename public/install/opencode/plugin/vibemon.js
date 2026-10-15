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
 *   session.compaction.ended,
 *     .failed                          -> PostCompact        -> thinking
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
  // A newer state replaces a pending one of the same session. A tool event
  // is never replaced: the hook tracks which tool calls are still running.
  const pending = payloadQueue.findIndex((entry) =>
    entry.session_id === payload.session_id && entry.cwd === payload.cwd && !entry.tool_use_id);
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

// opencode calls setup once per project instance (one directory) in one
// server. The event bus delivers the events of every instance, but tool hooks
// fire only in the instance that runs the session. A session belongs to this
// instance when its `location.directory` equals the instance directory, so
// each session is sent once and with its own project directory.
function setup(ctx) {
  const directory = text(ctx.location?.directory) || process.cwd();
  const sessions = new Map();
  const lookups = new Map();

  // `info` is session metadata: a session.created payload or the
  // ctx.session.get() result. Both use the same field names.
  function remember(sessionID, info) {
    const state = sessions.get(sessionID) || { owned: false, agent: "", model: "" };
    const location = text(info?.location?.directory);
    if (location) state.owned = location === directory;
    state.parentID = text(info?.parentID) || state.parentID;
    state.model = modelName(info?.model) || state.model;
    state.agent = text(info?.agent) || state.agent;
    sessions.set(sessionID, state);
    return state;
  }

  // The event stream does not replay events sent before setup subscribes.
  // The session that boots a project instance, a resumed session, and a
  // session of another instance have no session.created event here. Read
  // their metadata once before their first status. Calls for one session run
  // in order, also while the lookup is pending.
  function withSession(sessionID, use) {
    const run = (state) => {
      try {
        use(state);
      } catch {
        // Never let a bridge failure affect opencode.
      }
    };
    if (sessions.has(sessionID)) {
      run(sessions.get(sessionID));
      return;
    }
    if (!lookups.has(sessionID)) {
      lookups.set(sessionID, Promise.resolve()
        .then(() => ctx.session.get({ sessionID }))
        // A deleted session has no metadata. It stays unowned unless a tool
        // hook of this instance claims it.
        .catch(() => undefined)
        .then((info) => {
          lookups.delete(sessionID);
          return remember(sessionID, info);
        }));
    }
    lookups.get(sessionID).then(run);
  }

  function sendStatus(state, eventName, sessionID, tool = "", toolUseID = "") {
    if (!state.owned) return;
    // The parent's subagent tool already represents child work. A child's
    // completion must not mark the still-running parent as done.
    if (state.parentID) return;
    if (eventName === "Stop" && state.lastEvent === "Stop") return;
    state.lastEvent = eventName;
    dispatch({
      hook_event_name: eventName,
      session_id: sessionID,
      tool_name: text(tool),
      tool_use_id: text(toolUseID),
      cwd: directory,
      transcript_path: "",
      permission_mode: state.agent === "plan" ? "plan" : "default",
      model: state.model,
    });
  }

  const STATUS_EVENTS = {
    "session.execution.started": "UserPromptSubmit",
    "session.retry.scheduled": "UserPromptSubmit",
    "permission.asked": "PermissionRequest",
    "session.compaction.started": "PreCompact",
    "session.compaction.ended": "PostCompact",
    "session.compaction.failed": "PostCompact",
    "session.execution.succeeded": "Stop",
    "session.execution.failed": "Stop",
    "session.execution.interrupted": "Stop",
    "session.deleted": "SessionEnd",
  };

  // Bus events carry their fields in `event.data`. Streaming deltas
  // (session.text.*, session.reasoning.*, session.tool.*) are ignored: they
  // arrive many times per step and add no state.
  function onEvent(event) {
    const data = event?.data || {};
    const sessionID = text(data.sessionID);
    if (!sessionID) return;

    if (event.type === "session.created") {
      sendStatus(remember(sessionID, data), "SessionStart", sessionID);
    } else if (event.type === "session.step.started") {
      withSession(sessionID, (state) => {
        state.model = modelName(data.model) || state.model;
        state.agent = text(data.agent) || state.agent;
      });
    } else if (STATUS_EVENTS[event.type]) {
      const eventName = STATUS_EVENTS[event.type];
      withSession(sessionID, (state) => {
        sendStatus(state, eventName, sessionID, event.type === "permission.asked" ? data.action : "",
          event.type === "permission.asked" ? data.tool?.callID : "");
        if (eventName === "SessionEnd") sessions.delete(sessionID);
      });
    }
  }

  // Tool hooks run inside opencode's tool call. withSession() keeps bridge
  // failures inside the plugin. Only the owning instance runs these hooks.
  const toolHook = (eventName) => (event) => {
    const sessionID = text(event?.sessionID);
    if (!sessionID) return;
    withSession(sessionID, (state) => {
      state.owned = true;
      state.agent = text(event.agent) || state.agent;
      // `id` is the tool call ID, so parallel calls are tracked separately.
      sendStatus(state, eventName, sessionID, event.tool, event.id);
    });
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
