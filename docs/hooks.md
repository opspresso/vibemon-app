# Coding-agent hooks

Hooks convert coding-agent events into local status updates and authenticated Web summaries. The Desktop App displays local activity and selected cloud accounts. Provider credentials remain on the source machine.

Desktop auto-launch opens the installed macOS App or a Windows installer location (or `VibeMon.exe` on PATH). Start custom Windows installations and other platforms manually. Hooks never install or run an npm package.

## Supported Platforms

| Platform | Character | Description |
|----------|-----------|-------------|
| **Claude Code** | clawd | Anthropic's CLI for Claude |
| **Codex CLI** | codex | OpenAI's CLI for Codex |
| **Kiro IDE** | kiro | Amazon's AI coding assistant |
| **OpenClaw** | claw | Open source AI gateway |
| **opencode** | vibemon | Sends `opencode`; the current registry renders the default character |

## Installation

Follow the [installation guide](../public/install/setup.md) for Desktop, headless, and Windows instructions, scoped write tokens, integrity checks, repair, and uninstall. This reference covers configuration and event mappings after installation.

## Configuration

After installation, edit `~/.vibemon/config.json` to configure your targets:

```json
{
  "debug": false,
  "cache_path": "~/.vibemon/cache/projects.json",
  "auto_launch": true,
  "http_urls": [],
  "serial_port": null,
  "vibemon_token": "",
  "vibemon_url": "https://vibemon.io"
}
```

| Field | Description | Example |
|-------|-------------|---------|
| `debug` | Enable debug logging | `true` |
| `cache_path` | Cache file path for project metadata | `~/.vibemon/cache/projects.json` |
| `auto_launch` | Auto-launch Desktop App on session start | `true` |
| `http_urls` | Local status-push targets (Desktop App or legacy ESP32-C6 firmware) | `["http://127.0.0.1:19280"]` |
| `serial_port` | Legacy ESP32-C6 USB serial port (`~` and `*` wildcard supported; POSIX only, ignored on Windows) | `"/dev/cu.usbmodem*"` |
| `vibemon_url` | VibeMon cloud API URL | `https://vibemon.io` |
| `vibemon_token` | Generated write token (from /account) | |

Claude Code's statusline reads a separate `~/.vibemon/statusline.json` for display toggles (e.g. `show_cost`, `show_git`, `show_model`, `show_tokens`) — see [statusline.example.json](../public/install/vibemon/statusline.example.json) for the full set of defaults. This file is optional; statusline.py falls back to sensible defaults (and to any matching keys still in `config.json`) when it's absent.

The Claude Code installer also places a standalone refresher at `~/.vibemon/usage.py`. For Claude, it fetches plan usage directly from Anthropic's OAuth usage API using the local Claude Code login token (no active session required), falling back to a `claude -p "/usage"` subprocess when a token isn't available or the API call fails. For Codex, it queries the same account-level usage API Codex CLI's own `/status` polls using the local Codex login token, falling back to a recent local session snapshot. This fallback reads at most the newest 1 MiB of up to eight recent logs, preserves the observation timestamp, and does not renew stale usage by rewriting the cache. Either way it writes the shared `~/.vibemon/cache/usage.json`, so the Desktop app can run it (`python3 ~/.vibemon/usage.py --max-age 600`) on startup or on a schedule to keep usage data fresh even when no Claude Code or Codex session is active. Since the `claude -p "/usage"` fallback is itself a real Claude Code session, the Desktop app sets `VIBEMON_SUPPRESS_HOOKS=1` in its environment so the spawned session's own hooks don't report status back. Independently of that env var, the hooks also skip any session whose cwd is `~/.vibemon` itself, so spawners that don't set the variable (older Desktop app versions, manual `usage.py` runs) can't surface a phantom `.vibemon` project either.

The reset-countdown fields the hooks attach (`usage5hResetsIn`/`usageWeekResetsIn`/`usageWeekModelResetsIn`) are populated whenever the cache was refreshed via a `resets_at` epoch — either an active Claude Code session's statusline (the official `rate_limits` path), `usage.py`'s direct Anthropic/Codex API queries, or a Codex session log. Only the last-resort `claude -p "/usage"` text fallback lacks a machine-parseable reset time, so the reset countdown is omitted in that case while the usage percentages still update.

Context and plan-usage percentages retain their measured precision in the cache and both local and Web payloads. The statusline and dashboards format percentages to at most two decimal places. Formatting never becomes the input to a later cache write. Missing or invalid readings stay unavailable; a measured zero remains zero.

Note that the plan-usage fields (`usage5h`/`usageWeek`/`usageWeekModel` and their reset countdowns) are sent by the **Claude Code and Codex hooks**, since they both read from the same `usage.py`-refreshed cache (under provider/account-specific cache keys). The Kiro and opencode hooks don't report usage, and OpenClaw reports context-window usage as `memory` instead.

### Codex Configuration

Codex uses the same `~/.vibemon/config.json` as Claude Code, Kiro, the OpenClaw plugin, and the opencode plugin. Hooks are enabled by default. The installer does not create or edit `~/.codex/config.toml`; model, permissions, hook enablement, and native `tui.status_line` preferences belong to the user or their machine configuration manager. An explicit `[features].hooks = false` remains in effect. Merge [`codex/hooks.json`](../public/install/codex/hooks.json) into your existing `~/.codex/hooks.json` (do not overwrite), then open `/hooks` in Codex and review/trust the new definitions. Codex skips new or changed non-managed hooks until their current definition is trusted.

The VibeMon installer owns its shared scripts in `~/.vibemon`, per-tool VibeMon hooks/plugins, and Claude's VibeMon `statusline.py`. It refreshes only its own registrations in shared settings, preserving neighboring memory-sync, terminal, and user hooks. Machine configuration managers must likewise merge their own hook registrations rather than replace event arrays, and must leave VibeMon files out of their copy/prune lists. Installing, updating, or removing VibeMon does not manage machine scripts.

Kiro IDE 1.x and CLI 3.x load VibeMon from the global v1 hook file at `~/.kiro/hooks/vibemon.json`, so no custom agent needs to be selected. During upgrades, the installer removes only VibeMon's legacy hooks from `~/.kiro/agents/default.json` and its old `.kiro.hook` files; neighboring user hooks are preserved.

### OpenClaw Configuration

The OpenClaw plugin reads transmission settings (`http_urls`, `serial_port`, `vibemon_url`, `vibemon_token`) from the same `~/.vibemon/config.json` as the other tools. It only needs to be registered and enabled in `~/.openclaw/openclaw.json` — OpenClaw doesn't auto-discover extension directories, so the plugin path must also be registered under `plugins.load.paths` or the manifest/entries config alone won't load it:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/vibemon-bridge"]
    },
    "entries": {
      "vibemon-bridge": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

To override the shared settings for OpenClaw only, add a `config` object to the entry (`projectName`, `character`, `httpEnabled`, `httpUrls`, `serialEnabled`, `vibemonUrl`, `vibemonToken`, `autoLaunch`, `debug`) — plugin config always wins over `~/.vibemon/config.json`.

Serial output from OpenClaw needs a port setting: `serialPort` in the plugin config or `serial_port` in `~/.vibemon/config.json`. The plugin does not search for devices. `vibemon_core.py` resolves the setting the same way for every tool.

After installing or updating the plugin, rebuild OpenClaw's persisted plugin registry and restart the gateway (`openclaw plugins registry --refresh && openclaw gateway restart`) — the gateway boots from a registry snapshot and won't pick up the plugin's hooks otherwise. The installer runs the refresh automatically. A missing CLI or failed refresh returns a failing installation/removal result; resolve that error and retry before restarting the gateway.

### opencode Configuration

The opencode integration requires opencode 1.18.29 or later. One plugin file serves opencode 1.x and 2.x.

The opencode plugin reads transmission settings (`http_urls`, `serial_port`, `vibemon_url`, `vibemon_token`) from the same `~/.vibemon/config.json` as the other tools. The plugin at `~/.config/opencode/plugins/vibemon.js` maps opencode events to VibeMon hook events: it spawns the adapter at `~/.config/opencode/hooks/vibemon.py`, which feeds `vibemon_core.py`. opencode auto-discovers plugins in `~/.config/opencode/plugins/` at startup, so no config registration is needed — install the plugin file and restart opencode.

The installer honors an `OPENCODE_CONFIG_DIR` override (default `$XDG_CONFIG_HOME/opencode`, falling back to `~/.config/opencode`); on Windows it also pins the plugin's interpreter to the Python that ran the installer, since `python3` isn't on `PATH` there.

## CLI Commands

The hook script supports these commands for local status-push targets, not
VibeMon Touch. `--status` queries configured local targets. `--lock`, `--unlock`, and `--lock-mode` are attempted
against every configured HTTP target first (a Desktop app that doesn't
expose the endpoint is skipped) and then over serial; `--reboot` targets
legacy ESP32-C6 firmware only and skips the Desktop app:

```bash
# Lock monitor to current project
python3 ~/.claude/hooks/vibemon.py --lock [project_name]

# Unlock monitor
python3 ~/.claude/hooks/vibemon.py --unlock

# Get current status
python3 ~/.claude/hooks/vibemon.py --status

# Get/set lock mode (first-project, on-thinking)
python3 ~/.claude/hooks/vibemon.py --lock-mode [mode]

# Reboot a legacy ESP32-C6 device
python3 ~/.claude/hooks/vibemon.py --reboot
```

On Windows PowerShell, run the same commands as
`python "$env:USERPROFILE\.claude\hooks\vibemon.py" --status` — `python3` and
`~` in argument position don't resolve there.

## Apps

### Desktop App

Electron app with system tray for macOS, Windows, Linux. See [Installation](#installation) above to install.

Read tokens are configured in **Settings → Connections**; hook write tokens are configured in **Settings → Integrations → Send activity to Web** or directly in the hook configuration. Select **Dashboard** from the menu-bar or tray menu to view resources and coding accounts.

It shows a single character window with a speech bubble that follows it. The window retargets to whichever project is currently active instead of opening one window per project.

Features: frameless floating window, always on top, system tray integration, snap to screen corners, click to focus terminal (macOS).

### ESP32 Hardware

VibeMon Touch runs on the four-inch ESP32-S3 board and polls the same HTTPS summaries as Desktop. Configure Wi-Fi, the Web origin, and a read token on its screen. Hooks send activity to Web with a write token; Touch does not receive those events through `http_urls` or `serial_port`. See the [firmware repository](https://github.com/opspresso/vibemon-esp32) for setup.

Existing ESP32-C6 devices use the [previous firmware](https://github.com/opspresso/vibemon-esp32/tree/e6c272c) and can retain local HTTP/serial delivery. Do not flash the Touch build to a C6 board. The retired cloud WebSocket endpoint is unavailable.

## API

Hooks deliver coding activity to the [Status API](https://vibemon.io/docs/api/status). Cloud calls require a generated write token. The [Monitoring API](https://vibemon.io/docs/api/monitoring) defines account identity, resource summaries, selected-source reads, and trends. Local Desktop endpoints use a separate [HTTP API](https://github.com/opspresso/vibemon-app/blob/main/docs/api.md).

## State Mapping

Hooks report edges: a prompt starts a turn, a tool starts or ends, and a turn stops. The time between two edges is silent. A long tool call, a long model response, or a background subagent sends no event. Every display ages a silent active state to `idle` after 5 minutes (see [state timeouts](https://github.com/opspresso/vibemon-app/blob/main/docs/features.md#state-timeout)). Hooks therefore keep a running turn visible with heartbeats.

### Turn lifecycle

1. An event with an active state (`thinking`, `planning`, `working`, `packing`, or `notification`) opens the session's turn.
2. The hook that opens the turn starts one detached watcher process for the session. The watcher runs `python3 ~/.vibemon/vibemon_core.py --watch-session <session_id>`.
3. While the turn is open, the watcher repeats the last state every 60 seconds without another event. The report has `heartbeat: true`. A heartbeat refreshes the state clock, but it does not take display focus and does not add a Web activity sample. It counts the payload's reset countdowns down by the time since the hook built it, so they stay correct against the new observation time.
4. The turn closes when the agent reports `done` (`Stop`, `StopFailure`, `Interrupt`, or `SessionEnd`) or `start` (a new session).
5. The watcher also closes the turn and reports `done` within 5 seconds when:
   - the agent process exits without a `SessionEnd` hook, or
   - Claude Code records a user interrupt or a rejected tool (`[Request interrupted by user…]`) in its transcript. Claude Code runs no `Stop` hook for an interrupt.

The watcher identifies the agent process as the nearest ancestor of the hook that is not a shell, launcher, or Python interpreter. If it cannot identify that process, no watcher starts, and the session ages by the state timeouts as before.

Interactive Codex runs turns in its app-server process, and the TUI is only a client. The hook's agent process is therefore the app-server. A turn continues after its TUI exits and closes with `Stop`.

To verify this lifecycle against an installed agent, run `python3 scripts/verify_agent_continuity.py claude` or `codex` from the repository. The agent runs one 75-second command and uses the signed-in account. The check passes when the turn stays active through a heartbeat and ends with `done`.

### Session activity cache

When an event carries `session_id`, the hook records the session in `~/.vibemon/cache/activity.json` under one cross-process lock:

- **Running tools.** `PreToolUse` adds its `tool_use_id`. `PostToolUse`, `PostToolUseFailure`, and `PermissionDenied` remove it. A new prompt and every turn end clear the set. When a tool ends while another tool still runs, the session reports `working` instead of `thinking`. Plan mode keeps `planning`.
- **Pending questions.** A tool that asks the user (`AskUserQuestion`, `request_user_input`) and a tool with a `PermissionRequest` wait for the user. While one is unanswered, the session reports `notification`, even after a parallel tool ends.
- **Ordering.** The same lock issues strictly increasing timestamps, so hooks that start out of order cannot place an older state after a newer one.
- **Heartbeat payload.** The last display payload and the agent process ID let the watcher repeat the state. The cache holds no prompts, tool inputs, or responses.

Python hooks capture the observation time after mapping the event, before Git discovery or usage-cache reads. Local and Web delivery share that timestamp, so delayed metadata collection cannot make an older event appear newer. If the lock stays busy for 0.5 seconds, the hook reports its mapped state with the current time and starts no watcher.

Claude and Codex subagent `Agent` calls pass through the matcher-free tool hooks. The running `Agent` tool keeps the parent session `working` until the subagent returns, so separate subagent hooks would only duplicate those transitions.

### Claude Code

| Event | State |
|-------|-------|
| SessionStart | start |
| UserPromptSubmit | thinking |
| PreToolUse | working |
| PostToolUse | thinking |
| PostToolUseFailure | thinking |
| PermissionDenied | thinking |
| PreCompact | packing |
| PostCompact | thinking |
| Notification | notification |
| PermissionRequest | notification |
| Elicitation | notification |
| ElicitationResult | thinking |
| SessionEnd | done |
| Stop | done |
| StopFailure | done |

**Plan Mode**: When Claude Code is in plan mode, `thinking` and `working` states automatically become `planning`.

`PreToolUse` for `AskUserQuestion` reports `notification`, because the turn waits for the user's answer.

`Stop` reports `working` and keeps the turn open when its `background_tasks` list has a `running`, `pending`, or `in_progress` task. Claude Code starts a new turn when that work finishes.

Claude `Notification` reports **Needs input** only for `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, and `agent_needs_input`. `idle_prompt` reports `done` only when a turn is still open; it ends a turn whose `Stop` hook did not run, for example after an interrupt that the transcript check did not see. Other informational notifications do not change activity or refresh its timestamp. The installer filters these events before launching Python; the adapter also checks them for older hook registrations. See the [Claude notification contract](https://code.claude.com/docs/en/hooks#notification).

A tool approved at a permission prompt runs without a new hook event. The session shows `notification` until that tool's `PostToolUse`.

### Codex CLI

| Event | State |
|-------|-------|
| SessionStart | start |
| UserPromptSubmit | thinking |
| PreToolUse | working |
| PostToolUse | thinking |
| PermissionRequest | notification |
| PreCompact | packing |
| PostCompact | thinking |
| Stop | done |
| Interrupt | done |
| SessionEnd | done |

`SessionStart` covers startup, resume, and clear. `PreToolUse` for `request_user_input` reports `notification`. `PreToolUse`, `PostToolUse`, and `PermissionRequest` are registered without a matcher, so every supported local tool call (`Bash`, `apply_patch`/`Edit`/`Write`, MCP tools, and other local function tools) is observed. Informational hooks run in the background, while `SessionEnd` and `Interrupt` run synchronously with Codex's three-second maximum timeout. `done` indicates that activity ended, including cancellation or failure; it does not assert task success.

### Kiro IDE

| Event | State |
|-------|-------|
| SessionStart | start |
| UserPromptSubmit | thinking |
| PreToolUse | working |
| PostToolUse | thinking |
| Stop | done |

### OpenClaw

| Event | State |
|-------|-------|
| gateway_start | start |
| before_agent_run (fallback: before_agent_start) | thinking |
| before_tool_call | working |
| after_tool_call (success or failure) | thinking (working while another tool runs) |
| before_compaction / after_compaction | packing / thinking |
| subagent_spawned | working |
| agent_end (success or failure) | done (3s delay, after all runs finish) |
| message_sent | done fallback (only with no active run) |
| session_end / gateway_stop | done |

OpenClaw reads the active model and context usage from `llm_output`, resets them per run, and tracks parallel runs and tools. The plugin runs inside the gateway, so it needs no watcher process: while a run is active, it repeats the newest active state with `heartbeat: true` 60 seconds after the last report. Local HTTP targets serialize updates, keep the newest pending state, and have a 2.5-second request deadline. USB and cloud delivery use the shared Python transport with a five-second process limit. Cloud reports use the gateway's `VIBEMON_OPENCLAW_ACCOUNT_ID` / `VIBEMON_OPENCLAW_ACCOUNT_NAME` (or common account variables), instance identity, and working directory. Changing the displayed character does not change the OpenClaw account provider.

### opencode

| Event | State |
|-------|-------|
| SessionStart | start |
| UserPromptSubmit | thinking |
| PreToolUse | working |
| PostToolUse | thinking |
| PermissionRequest | notification |
| PreCompact | packing |
| PostCompact | thinking |
| Stop | done |
| SessionEnd | done |

The plugin default-exports `{ id, setup, server }`. opencode 2.x calls `setup`, and opencode 1.18.29 or later calls `server`.

In opencode 2.x, `setup` registers two tool hooks and reads the event bus (`ctx.event.subscribe()`):

- `session.created` → SessionStart
- `session.execution.started` or `session.retry.scheduled` → UserPromptSubmit
- tool hook `execute.before` → PreToolUse, with the tool call `id` as `tool_use_id`
- tool hook `execute.after` → PostToolUse, with the same `tool_use_id`
- `permission.asked` → PermissionRequest
- `session.compaction.started` → PreCompact
- `session.compaction.ended` or `session.compaction.failed` → PostCompact
- `session.execution.succeeded`, `session.execution.failed`, or `session.execution.interrupted` → Stop
- `session.deleted` → SessionEnd

The plugin ignores streaming events (`session.text.*`, `session.reasoning.*`, `session.tool.*`) because they add no state. It sends `Stop` once per completed turn. The adapter queue replaces a pending state of the same session with a newer one, but it never replaces a tool event, because the hook tracks running tool calls by their IDs.

opencode loads the plugin once per project instance (one directory). The event bus delivers the events of every instance, so each plugin instance sends only the sessions whose `location.directory` equals its own directory. That directory is the payload `cwd`.

The event bus does not replay events sent before the plugin subscribes. For a session without a `session.created` event (the session that starts the project instance, or a resumed session), the plugin reads the session metadata once with `ctx.session.get()`. That session starts at UserPromptSubmit instead of SessionStart.

The model and agent come from the session metadata and `session.step.started`; the `plan` agent sets `permission_mode` to `plan`. Child sessions (metadata with `parentID`) do not publish status, because the parent's `subagent` tool represents them. Each adapter process has a 10-second deadline so a stalled child cannot stop the queue.

In opencode 1.x, `server` returns these hooks:

- event `session.created` → SessionStart
- hook `chat.message` → UserPromptSubmit, with the message model and agent
- hook `tool.execute.before` → PreToolUse, with the tool `callID` as `tool_use_id`
- hook `tool.execute.after` → PostToolUse, with the same `tool_use_id`
- event `permission.asked` or `permission.updated` → PermissionRequest
- hook `experimental.session.compacting` → PreCompact
- event `session.compacted` → PostCompact
- event `session.idle` or `session.error` → Stop
- event `session.deleted` → SessionEnd

opencode 1.x sends `session.idle` after every completed, failed, or aborted prompt, so each turn ends in `done`. A failure sends `session.error` before `session.idle`; the plugin sends one `Stop` for both. opencode 1.x delivers only the events of the plugin's own project instance, so the instance directory is the payload `cwd`. Child sessions announced by `session.created` with `parentID` do not publish status.

## Related Projects

- [VibeMon Web](https://vibemon.io) - Cloud dashboard and API
- [vibemon-app](https://github.com/opspresso/vibemon-app) - Desktop App
- [Public App source](https://github.com/opspresso/vibemon-app) - Hooks, collectors, registries, renderers, and character images
