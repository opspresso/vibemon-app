/**
 * VibeMon Plugin for opencode
 *
 * opencode 2.x validates plugin modules against the V2 plugin schema, so this
 * file dual-registers:
 *
 *   V2 (opencode >= 2.0, the supported path going forward): the default
 *   export below — a Plugin.define({ id, setup }) definition whose setup
 *   registers ctx.tool/ctx.session/ctx.permission/ctx.event hooks.
 *
 *   V1 (opencode 1.18.29+ object entrypoints only; the named `vibemon`
 *   export and `server()` below): one module-level instance with its own
 *   queue, mirroring the legacy hooks:
 *     chat.message                -> UserPromptSubmit -> thinking
 *     tool.execute.before        -> PreToolUse       -> working
 *     tool.execute.after         -> PostToolUse      -> thinking
 *     permission.ask             -> PermissionRequest-> notification
 *     experimental.session.compacting -> PreCompact  -> packing
 *     event bus: session.created -> SessionStart, session.idle/error -> Stop,
 *                session.deleted  -> SessionEnd, session.compacted ->
 *                PostCompact, session.status busy/retry -> UserPromptSubmit,
 *                session.status idle -> Stop
 *
 * Both paths spawn the same adapter:
 * ~/.config/opencode/hooks/vibemon.py, which feeds vibemon_core.py
 * (~/.vibemon/vibemon_core.py), the same way the Claude Code, Codex, Kiro,
 * and OpenClaw integrations do. The V1 export remains so opencode 1.14-1.18
 * keeps working; it was removed here before a reinstall re-added it, because
 * "no V2 default export" in opencode 2.0 is not a reason to lose 1.x users.
 *
 * install.py inspects the PYTHON / HOOK_SCRIPT constants above and, on
 * Windows or a custom config home, rewrites them with absolute paths at
 * install time.
 */

import { spawn } from "node:child_process";

// Shared with the V2 `setup` path. opencode may initialize the plugin again
// for another project directory, so the backlog is keyed by adapter instance.
// One instance's stalled transport must not block another project's updates.
const MAX_QUEUED_PAYLOADS = 32;
const ADAPTER_TIMEOUT_MS = 10000;

function createDispatcher(spawnChild) {
  const instances = new Map();

  function instanceFor(instanceId) {
    if (!instances.has(instanceId)) {
      instances.set(instanceId, { queue: [], draining: false, children: 0 });
    }
    return instances.get(instanceId);
  }

  return function dispatch(payload, instanceId = "default") {
    const instance = instanceFor(instanceId);
    const queue = instance.queue;
    const pending = queue.findIndex((entry) =>
      entry.session_id === payload.session_id && entry.cwd === payload.cwd);
    if (pending !== -1) queue.splice(pending, 1);
    queue.push(payload);
    if (queue.length > MAX_QUEUED_PAYLOADS) {
      // Drop the oldest, not the newest: the latest state must still be sent.
      queue.shift();
    }
    drain(instance);
  };

  function drain(instance) {
    if (instance.draining) return;
    const next = instance.queue.shift();
    if (next === undefined) return;
    instance.draining = true;
    spawnChild(next, (child) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        instance.draining = false;
        drain(instance);
      };
      child.on("error", settle);
      child.on("close", settle);
      child.stdin.on("error", () => {});
      try {
        child.stdin.write(JSON.stringify(next.payload));
        child.stdin.end();
      } catch {
        // Spawn errors and premature exits settle this child too.
        settle();
      }
    });
  }
}

// opencode initializes one V2 plugin instance per project instance, so
// session metadata (directory, agent, model) must never be shared across
// projects. One dispatcher per project keeps that isolation while reusing
// the queue logic.
function createStatusBridge(dispatch, defaultDir, defaultModel = "") {
  const sessions = new Map();

  function context(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, { directory: defaultDir, model: defaultModel });
    }
    return sessions.get(sessionID);
  }

  return {
    context,
    sendStatus(eventName, input = {}) {
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
  };
}

const dispatchV1 = createDispatcher((payload, ready) => {
  ready(spawn(PYTHON, [HOOK_SCRIPT], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    timeout: ADAPTER_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }));
});

// opencode 2.0 may run this module outside Bun, so no Bun-only API is used.
// Child processes are detached and self-timeout: the plugin must never keep
// opencode alive and no callback may await on a stalled transport.
function spawnDetachedAdapter(payload) {
  let child;
  try {
    child = spawn(PYTHON, [HOOK_SCRIPT], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      detached: true,
      timeout: ADAPTER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch {
    return false;
  }
  if (!child || !child.stdin) return false;
  child.on("error", () => {});
  try {
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {
    // A child that died before the write settles nothing observable.
  }
  if (child.unref) child.unref();
  return true;
}

// The V2 event bus carries one payload per event and offers no transform
// point, so tool/prompt/permission/compaction hooks are the only source for
// their states, and `start` is emitted from session.created instead of a
// separate hook. V2 hook/event payloads are not fully documented, so every
// field read is defensive: any shape mismatch degrades to "no status" rather
// than throwing into opencode's hot path.
function registerV2Hooks(ctx, bridge) {
  const sendStatus = (event, eventName) => {
    const input = (event && event.input) || {};
    const sessionID = input.sessionID || (event && event.sessionID) || "";
    bridge.sendStatus(eventName, {
      sessionID,
      tool: typeof event.tool === "string" ? event.tool : undefined
    });
  };

  const subscriptions = [];
  if (typeof ctx.event?.subscribe === "function") {
    const subscription = ctx.event.subscribe();
    subscriptions.push(subscription);
    const events = subscription?.stream || subscription;
    if (events && typeof events[Symbol.asyncIterator] === "function") {
      (async () => {
        try {
          for await (const event of events) {
            try {
              const props = (event && event.properties) || {};
              if (typeof event.sessionID === "string" || typeof props.sessionID === "string") continue;
              const sessionID = props.sessionID
                || (props.info && props.info.id)
                || event.sessionID
                || "";
              const ctxEntry = bridge.context(sessionID);
              if (event.type === "session.created" && sessionID) {
                ctxEntry.model = modelName(props.info && props.info.model) || ctxEntry.model;
                bridge.sendStatus("SessionStart", { sessionID });
              } else if (event.type === "session.idle" && sessionID) {
                bridge.sendStatus("Stop", { sessionID });
              } else if (event.type === "session.error" && sessionID) {
                bridge.sendStatus("Stop", { sessionID });
              }
            } catch {
              // Never let a bridge failure affect opencode.
            }
          }
        } catch {
          // A closed stream simply ends the subscription.
        }
      })();
    }
  }

  if (typeof ctx.tool?.hook === "function") {
    for (const [name, eventName] of [
      ["execute.before", "PreToolUse"],
      ["execute.after", "PostToolUse"],
    ]) {
      ctx.tool.hook(name, (event) => {
        try {
          sendStatus(event, eventName);
        } catch {
          // Never let a bridge failure affect opencode.
        }
      });
    }
  }

  if (typeof ctx.session?.hook === "function") {
    ctx.session.hook("prompt", (event) => {
      try {
        const message = event.message || {};
        const sessionID = event.sessionID
          || (event.session && event.session.id)
          || "";
        const ctxEntry = bridge.context(sessionID);
        ctxEntry.model = modelName(message.model) || ctxEntry.model;
        bridge.sendStatus("UserPromptSubmit", { sessionID });
      } catch {
        // Never let a bridge failure affect opencode.
      }
    });
    ctx.session.hook("compaction", (event) => {
      try {
        bridge.sendStatus("PreCompact", {
          sessionID: event.sessionID
            || (event.session && event.session.id)
            || ""
        });
      } catch {
        // Never let a bridge failure affect opencode.
      }
    });
  }

  if (typeof ctx.permission?.hook === "function") {
    // V2 names this hook "ask" (it may run synchronously); the name is
    // probed so opencode 2.x renames can't silently kill permission states.
    for (const name of ["evaluate", "ask"]) {
      try {
        ctx.permission.hook(name, (event) => {
          try {
            sendStatus(event, "PermissionRequest");
          } catch {
            // Never let a bridge failure affect opencode.
          }
        });
        break;
      } catch {
        // This hook name does not exist here; the fallback covers older
        // builds only and must never break session states.
      }
    }
  }

  return () => {
    for (const subscription of subscriptions) {
      try {
        if (subscription && typeof subscription.return === "function") {
          subscription.return();
        } else if (subscription && typeof subscription.cancel === "function") {
          subscription.cancel();
        }
      } catch {
        // Subprocess lifetime is bounded by child.timeout, not by this.
      }
    }
  };
}
