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
| `http_urls` | HTTP targets (Desktop App, ESP32 WiFi) | `["http://127.0.0.1:19280"]` |
| `serial_port` | ESP32 USB serial port (wildcard supported; POSIX only, ignored on Windows) | `"/dev/cu.usbmodem*"` |
| `vibemon_url` | VibeMon cloud API URL | `https://vibemon.io` |
| `vibemon_token` | Generated write token (from /account) | |

Claude Code's statusline reads a separate `~/.vibemon/statusline.json` for display toggles (e.g. `show_cost`, `show_git`, `show_model`, `show_tokens`) — see [statusline.example.json](../public/install/vibemon/statusline.example.json) for the full set of defaults. This file is optional; statusline.py falls back to sensible defaults (and to any matching keys still in `config.json`) when it's absent.

The Claude Code installer also places a standalone refresher at `~/.vibemon/usage.py`. For Claude, it fetches plan usage directly from Anthropic's OAuth usage API using the local Claude Code login token (no active session required), falling back to a `claude -p "/usage"` subprocess when a token isn't available or the API call fails. For Codex, it queries the same account-level usage API Codex CLI's own `/status` polls using the local Codex login token, falling back to a recent local session snapshot. This fallback reads at most the newest 1 MiB of up to eight recent logs, preserves the observation timestamp, and does not renew stale usage by rewriting the cache. Either way it writes the shared `~/.vibemon/cache/usage.json`, so the Desktop app can run it (`python3 ~/.vibemon/usage.py --max-age 600`) on startup or on a schedule to keep usage data fresh even when no Claude Code or Codex session is active. Since the `claude -p "/usage"` fallback is itself a real Claude Code session, the Desktop app sets `VIBEMON_SUPPRESS_HOOKS=1` in its environment so the spawned session's own hooks don't report status back. Independently of that env var, the hooks also skip any session whose cwd is `~/.vibemon` itself, so spawners that don't set the variable (older Desktop app versions, manual `usage.py` runs) can't surface a phantom `.vibemon` project either.

The reset-countdown fields the hooks attach (`usage5hResetsIn`/`usageWeekResetsIn`/`usageWeekModelResetsIn`) are populated whenever the cache was refreshed via a `resets_at` epoch — either an active Claude Code session's statusline (the official `rate_limits` path), `usage.py`'s direct Anthropic/Codex API queries, or a Codex session log. Only the last-resort `claude -p "/usage"` text fallback lacks a machine-parseable reset time, so the reset countdown is omitted in that case while the usage percentages still update.

Note that the plan-usage fields (`usage5h`/`usageWeek`/`usageWeekModel` and their reset countdowns) are sent by the **Claude Code and Codex hooks**, since they both read from the same `usage.py`-refreshed cache (under provider/account-specific cache keys). The Kiro and opencode hooks don't report usage, and OpenClaw reports context-window usage as `memory` instead.

### Codex Configuration

Codex uses the same `~/.vibemon/config.json` as Claude Code, Kiro, the OpenClaw plugin, and the opencode plugin. Hooks are enabled by default; the installer preserves an explicit `[features].hooks = false` in `~/.codex/config.toml`. Merge [`codex/hooks.json`](../public/install/codex/hooks.json) into your existing `~/.codex/hooks.json` (do not overwrite), then open `/hooks` in Codex and review/trust the new definitions. Codex skips new or changed non-managed hooks until their current definition is trusted.

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

After installing or updating the plugin, rebuild OpenClaw's persisted plugin registry and restart the gateway (`openclaw plugins registry --refresh && openclaw gateway restart`) — the gateway boots from a registry snapshot and won't pick up the plugin's hooks otherwise. The installer runs the refresh automatically. A missing CLI or failed refresh returns a failing installation/removal result; resolve that error and retry before restarting the gateway.

### opencode Configuration

The opencode plugin reads transmission settings (`http_urls`, `serial_port`, `vibemon_url`, `vibemon_token`) from the same `~/.vibemon/config.json` as the other tools. opencode has no Claude Code-style hooks, so the plugin at `~/.config/opencode/plugins/vibemon.js` bridges opencode events to VibeMon's hook pipeline: it spawns the adapter at `~/.config/opencode/hooks/vibemon.py`, which feeds `vibemon_core.py`. opencode auto-discovers plugins in `~/.config/opencode/plugins/` at startup, so no config registration is needed — install the plugin file and restart opencode.

The installer honors an `OPENCODE_CONFIG_DIR` override (default `$XDG_CONFIG_HOME/opencode`, falling back to `~/.config/opencode`); on Windows it also pins the plugin's interpreter to the Python that ran the installer, since `python3` isn't on `PATH` there.

## CLI Commands

The hook script supports these commands. `--status` works with every
monitor target. `--lock`, `--unlock`, and `--lock-mode` are attempted
against every configured HTTP target first (a Desktop app that doesn't
expose the endpoint is skipped) and then over serial; `--reboot` targets
the ESP32 only and skips the Desktop app:

```bash
# Lock monitor to current project
python3 ~/.claude/hooks/vibemon.py --lock [project_name]

# Unlock monitor
python3 ~/.claude/hooks/vibemon.py --unlock

# Get current status
python3 ~/.claude/hooks/vibemon.py --status

# Get/set lock mode (first-project, on-thinking)
python3 ~/.claude/hooks/vibemon.py --lock-mode [mode]

# Reboot ESP32 device
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

ESP32 firmware is outside this overhaul. Local serial integration is unchanged. See the [firmware repository](https://github.com/opspresso/vibemon-esp32) for hardware setup. The retired cloud WebSocket endpoint is unavailable.

## API

Hooks deliver coding activity to the [Status API](https://vibemon.io/docs/api/status). Cloud calls require a generated write token. The [Monitoring API](https://vibemon.io/docs/api/monitoring) defines account identity, resource summaries, selected-source reads, and trends. Local Desktop endpoints use a separate [HTTP API](https://github.com/opspresso/vibemon-app/blob/main/docs/api.md).

## State Mapping

State reporting is edge-driven: a new state start replaces the previous state. Completion hooks are retained only where no later start event reliably restores the state (`PostToolUse`/`PostCompact`) or an explicit turn/session ending must be reported (`Stop`/`SessionEnd`). Claude and Codex subagent `Agent` calls already pass through the matcher-free tool hooks, so separate subagent hooks would only duplicate those transitions.

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
| SessionEnd | done |
| Stop | done |
| StopFailure | done |

**Plan Mode**: When Claude Code is in plan mode, `thinking` and `working` states automatically become `planning`.

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

`SessionStart` covers startup, resume, and clear. `PreToolUse`, `PostToolUse`, and `PermissionRequest` are registered without a matcher, so every supported local tool call (`Bash`, `apply_patch`/`Edit`/`Write`, MCP tools, and other local function tools) is observed. Informational hooks run in the background, while `SessionEnd` and `Interrupt` run synchronously with Codex's three-second maximum timeout. `done` indicates that activity ended, including cancellation or failure; it does not assert task success.

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

OpenClaw reads the active model and context usage from `llm_output`, resets them per run, and tracks parallel runs and tools. Local HTTP targets serialize updates, keep the newest pending state, and have a 2.5-second request deadline. USB and cloud delivery use the shared Python transport with a five-second process limit. Cloud reports use the gateway's `VIBEMON_OPENCLAW_ACCOUNT_ID` / `VIBEMON_OPENCLAW_ACCOUNT_NAME` (or common account variables), instance identity, and working directory. Changing the displayed character does not change the OpenClaw account provider.

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

opencode has no Claude Code-style hooks, so the plugin bridges its events to these hook events:

- `session.created` → SessionStart
- `chat.message` → UserPromptSubmit
- `tool.execute.before` → PreToolUse
- `tool.execute.after` → PostToolUse
- `permission.asked` (bus event; legacy `permission.ask` hook) → PermissionRequest
- `experimental.session.compacting` → PreCompact
- `session.compacted` → PostCompact
- `session.status` (`busy`/`retry`) → UserPromptSubmit
- `session.idle`, `session.status` (`idle`), or `session.error` → Stop
- `session.deleted` → SessionEnd

Resumed OpenCode sessions use the project instance directory and resolved chat model. Known child sessions do not publish independent status because the parent task tool represents them. Each adapter process has a 10-second deadline so a stalled child cannot stop the queue.

## Related Projects

- [VibeMon Web](https://vibemon.io) - Cloud dashboard and API
- [vibemon-app](https://github.com/opspresso/vibemon-app) - Desktop App
- [Public App source](https://github.com/opspresso/vibemon-app) - Hooks, collectors, registries, renderers, and character images
