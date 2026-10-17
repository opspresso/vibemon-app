/**
 * VibeMon Plugin for opencode
 *
 * This plugin sends opencode session state to VibeMon. It spawns the adapter
 * (~/.config/opencode/hooks/vibemon.py), which feeds the shared transport
 * (~/.vibemon/vibemon_core.py) like the Claude Code, Codex, Kiro, and
 * OpenClaw integrations.
 *
 * One default export serves both plugin APIs: opencode 2.x calls `setup()`,
 * and opencode 1.18.29 and later call `server()`.
 *
 * opencode 2.x source (tool hook or bus event) Hook event     State
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
 * opencode 1.x source (hook or event)      Hook event          State
 *   session.created                    -> SessionStart       -> start
 *   chat.message                       -> UserPromptSubmit   -> thinking
 *   tool.execute.before                -> PreToolUse         -> working
 *   tool.execute.after                 -> PostToolUse        -> thinking
 *   permission.asked, .updated         -> PermissionRequest  -> notification
 *   experimental.session.compacting    -> PreCompact         -> packing
 *   session.compacted                  -> PostCompact        -> thinking
 *   session.idle, session.error        -> Stop               -> done
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
    entry.session_id === payload.session_id && entry.cwd === payload.cwd &&
    JSON.stringify(entry.account_hint) === JSON.stringify(payload.account_hint) && !entry.tool_use_id);
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

// opencode 2.x sends `{ id, providerID }` model references and opencode 1.x
// sends `{ providerID, modelID }`.
function modelName(model) {
  return text(model) || text(model?.id) || text(model?.modelID);
}

// The session state of one project instance (one directory). It sends each
// owned top-level session with the instance directory.
function sessionBridge(directory) {
  const sessions = new Map();
  const accountRevisions = new Map();

  // `info` is session metadata: a 2.x session.created payload, a
  // ctx.session.get() result, or a 1.x session `info`.
  function remember(sessionID, info) {
    const state = sessions.get(sessionID) || { owned: false, agent: "", model: "", provider: "", revision: "0", toolAccounts: new Map() };
    const location = text(info?.location?.directory) || text(info?.directory);
    if (location) state.owned = location === directory;
    state.parentID = text(info?.parentID) || state.parentID;
    state.model = modelName(info?.model) || state.model;
    state.provider = text(info?.model?.providerID) || state.provider;
    state.agent = text(info?.agent) || state.agent;
    sessions.set(sessionID, state);
    return state;
  }

  function sendStatus(state, eventName, sessionID, tool = "", toolUseID = "") {
    if (!state.owned) return;
    // The parent's subagent tool already represents child work. A child's
    // completion must not mark the still-running parent as done.
    if (state.parentID) return;
    if (eventName === "Stop" && state.lastEvent === "Stop") return;
    if (eventName === "UserPromptSubmit") {
      const revision = accountRevisions.get(state.provider) || "0";
      state.revision = revision;
    }
    let accountHint = { provider: state.provider, revision: state.revision };
    if (state.revision !== "0" && !state.revision.startsWith("environment:")) accountHint.credential_id = state.revision;
    let reportedModel = state.model;
    if (toolUseID && eventName === "PreToolUse") state.toolAccounts.set(toolUseID, { accountHint, model: state.model });
    if (toolUseID && eventName === "PostToolUse") {
      const original = state.toolAccounts.get(toolUseID);
      accountHint = original?.accountHint || accountHint;
      reportedModel = original?.model || reportedModel;
      state.toolAccounts.delete(toolUseID);
    }
    const previous = state.lastReport;
    const changed = previous && JSON.stringify(previous.account_hint) !== JSON.stringify(accountHint);
    const lateTool = changed && eventName === "PostToolUse";
    if (changed && previous.account_hint.provider && !lateTool && previous.hook_event_name !== "Stop" && previous.hook_event_name !== "SessionEnd") {
      dispatch({ ...previous, hook_event_name: "Stop", tool_name: "", tool_use_id: "" });
    }
    const report = {
      hook_event_name: eventName,
      session_id: sessionID,
      tool_name: text(tool),
      tool_use_id: text(toolUseID),
      cwd: directory,
      transcript_path: "",
      permission_mode: state.agent === "plan" ? "plan" : "default",
      model: reportedModel,
      account_hint: accountHint,
    };
    if (!lateTool) {
      state.lastEvent = eventName;
      state.lastReport = report;
    }
    dispatch(report);
  }

  return { sessions, remember, sendStatus, accountChanged(provider, revision) {
    if (provider) accountRevisions.set(provider, revision);
  } };
}

// opencode 2.x calls setup once per project instance in one server. The event
// bus delivers the events of every instance, but tool hooks fire only in the
// instance that runs the session. A session belongs to this instance when its
// `location.directory` equals the instance directory, so each session is sent
// once and with its own project directory.
function setup(ctx) {
  const directory = text(ctx.location?.directory) || process.cwd();
  const { sessions, remember, sendStatus, accountChanged } = sessionBridge(directory);
  const lookups = new Map();

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
    if (event?.type === "credential.switched") {
      accountChanged(text(data.integrationID), text(data.credentialID) || `environment:${event.created}`);
      return;
    }
    const sessionID = text(data.sessionID);
    if (!sessionID) return;

    if (event.type === "session.created") {
      sendStatus(remember(sessionID, data), "SessionStart", sessionID);
    } else if (event.type === "session.step.started") {
      withSession(sessionID, (state) => {
        state.model = modelName(data.model) || state.model;
        state.provider = text(data.model?.providerID) || state.provider;
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

// opencode 1.x calls server once per project instance and delivers only that
// instance's events and hooks, so every session it reports is owned.
async function server(input) {
  const directory = text(input?.directory) || process.cwd();
  const { sessions, remember, sendStatus } = sessionBridge(directory);

  function status(sessionID, eventName, info, tool = "", toolUseID = "") {
    if (!sessionID) return;
    try {
      const state = remember(sessionID, info);
      state.owned = true;
      sendStatus(state, eventName, sessionID, tool, toolUseID);
      if (eventName === "SessionEnd") sessions.delete(sessionID);
    } catch {
      // Never let a bridge failure affect opencode.
    }
  }

  // `session.idle` follows every finished, failed, or aborted prompt.
  // `session.error` comes first on a failure; sendStatus sends one Stop.
  const EVENTS = {
    "session.idle": "Stop",
    "session.error": "Stop",
    "session.compacted": "PostCompact",
  };

  return {
    event: async ({ event } = {}) => {
      const properties = event?.properties || {};
      if (event?.type === "session.created") {
        status(text(properties.info?.id), "SessionStart", properties.info);
      } else if (event?.type === "session.deleted") {
        status(text(properties.info?.id), "SessionEnd", properties.info);
      } else if (event?.type === "permission.asked" || event?.type === "permission.updated") {
        status(text(properties.sessionID), "PermissionRequest", undefined, text(properties.type),
          text(properties.callID) || text(properties.tool?.callID));
      } else if (EVENTS[event?.type]) {
        status(text(properties.sessionID), EVENTS[event.type]);
      }
    },
    "chat.message": async (message) => {
      status(text(message?.sessionID), "UserPromptSubmit", { model: message?.model, agent: message?.agent });
    },
    // `callID` is the tool call ID, so parallel calls are tracked separately.
    "tool.execute.before": async (call) => {
      status(text(call?.sessionID), "PreToolUse", undefined, call?.tool, call?.callID);
    },
    "tool.execute.after": async (call) => {
      status(text(call?.sessionID), "PostToolUse", undefined, call?.tool, call?.callID);
    },
    "experimental.session.compacting": async (compaction) => {
      status(text(compaction?.sessionID), "PreCompact");
    },
  };
}

export default { id: "vibemon", setup, server };
