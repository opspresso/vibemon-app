/**
 * VibeMon Plugin for opencode
 *
 * opencode has no Claude Code-style hooks, so this plugin bridges opencode
 * events to VibeMon's shared hook pipeline: the adapter
 * (~/.config/opencode/hooks/vibemon.py) feeds vibemon_core.py
 * (~/.vibemon/vibemon_core.py), the same way the Claude Code, Codex, Kiro,
 * and OpenClaw integrations do.
 *
 * Bridge mapping:
 *   session.created                 -> SessionStart       -> start
 *   chat.message                    -> UserPromptSubmit   -> thinking
 *   tool.execute.before             -> PreToolUse         -> working
 *   tool.execute.after              -> PostToolUse        -> thinking
 *   permission.asked                -> PermissionRequest  -> notification
 *   permission.ask (legacy)         -> PermissionRequest  -> notification
 *   experimental.session.compacting -> PreCompact         -> packing
 *   session.compacted               -> PostCompact        -> thinking
 *   session.status (busy/retry)     -> UserPromptSubmit   -> thinking
 *   session.idle / session.error    -> Stop               -> done
 *   session.deleted                 -> SessionEnd         -> done
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

function modelName(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  if (model.modelID) return model.modelID;
  if (model.id) return model.id;
  return "";
}

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

export const vibemon = async ({ directory, worktree }) => {
  // OpenCode initializes a plugin for each project instance in one server.
  // Session metadata must not leak between those instances.
  const sessions = new Map();
  const defaultDir =
    (typeof directory === "string" && directory) ||
    (typeof worktree === "string" && worktree) ||
    process.cwd();

  function context(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, { directory: defaultDir });
    }
    return sessions.get(sessionID);
  }

  function sendStatus(eventName, input = {}) {
    const ctx = context(input.sessionID);
    // The parent's task tool already represents subagent work. A child's
    // idle/deleted event must not mark the still-running parent as done.
    if (ctx.parentID) return;
    if (eventName === "Stop" && ctx.lastEvent === "Stop") return;
    ctx.lastEvent = eventName;
    dispatch({
      hook_event_name: eventName,
      session_id: input.sessionID || "",
      tool_name: typeof input.tool === "string" ? input.tool : "",
      cwd: ctx.directory || defaultDir,
      transcript_path: "",
      permission_mode: ctx.agent === "plan" ? "plan" : "default",
      model: ctx.model || "",
    });
  }

  return {
    event: async ({ event }) => {
      try {
        if (!["session.created", "session.updated", "session.status", "session.error",
          "session.idle", "session.deleted", "session.compacted", "permission.asked"].includes(event?.type)) return;
        const props = (event && event.properties) || {};
        const sessionID =
          props.sessionID || (props.info && props.info.id) || "";
        const ctx = context(sessionID);
        if (event.type === "session.deleted" && props.info?.parentID) {
          ctx.parentID = props.info.parentID;
        }

        switch (event.type) {
          case "session.created":
          case "session.updated": {
            const info = props.info || {};
            if (typeof info.directory === "string" && info.directory) ctx.directory = info.directory;
            ctx.parentID = info.parentID || ctx.parentID;
            ctx.model = modelName(info.model) || ctx.model;
            if (event.type === "session.created") sendStatus("SessionStart", { sessionID });
            break;
          }
          case "session.status": {
            const status = props.status?.type;
            if (status === "idle") sendStatus("Stop", { sessionID });
            else if (status === "busy" || status === "retry") {
              sendStatus("UserPromptSubmit", { sessionID });
            }
            break;
          }
          case "session.error":
          case "session.idle": {
            if (sessionID) sendStatus("Stop", { sessionID });
            break;
          }
          case "session.deleted": {
            sendStatus("SessionEnd", { sessionID });
            sessions.delete(sessionID);
            break;
          }
          case "session.compacted": {
            sendStatus("PostCompact", { sessionID });
            break;
          }
          case "permission.asked": {
            // Current opencode emits permission requests on the bus
            // (`permission.asked`); the `permission.ask` hook below is only
            // triggered by older versions.
            sendStatus("PermissionRequest", {
              sessionID,
              tool: props.permission,
            });
            break;
          }
        }
      } catch {
        // Never let a bridge failure affect opencode.
      }
    },

    "chat.message": async (input = {}, output = {}) => {
      try {
        const ctx = context(input.sessionID);
        ctx.model = modelName(input.model) || modelName(output.message?.model) || ctx.model;
        ctx.agent = input.agent || output.message?.agent || ctx.agent;
        sendStatus("UserPromptSubmit", input);
      } catch {
        // Never let a bridge failure affect opencode.
      }
    },

    "tool.execute.before": async (input = {}) => {
      try {
        sendStatus("PreToolUse", input);
      } catch {
        // Never let a bridge failure affect opencode.
      }
    },

    "tool.execute.after": async (input = {}) => {
      try {
        sendStatus("PostToolUse", input);
      } catch {
        // Never let a bridge failure affect opencode.
      }
    },

    "permission.ask": async (input = {}) => {
      try {
        sendStatus("PermissionRequest", {
          sessionID: input.sessionID,
          tool: input.type,
        });
      } catch {
        // Never let a bridge failure affect opencode.
      }
    },

    "experimental.session.compacting": async (input = {}) => {
      try {
        sendStatus("PreCompact", input);
      } catch {
        // Never let a bridge failure affect opencode.
      }
    },
  };
};
