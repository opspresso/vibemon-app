# Features

## Agent Support

VibeMon normalizes multiple agent ecosystems into one display model. The rendering layer is shared, but the integration path is not.

| Agent | Integration path | Best signal source | Observability quality | Important limitation |
|------|-------------------|--------------------|-----------------------|----------------------|
| Claude Code | Native hooks | Session, turn, and tool hooks | High | None significant for basic monitoring |
| Codex | Native hooks and non-interactive JSON output | Interactive hooks for sessions, `codex exec --json` for automation | Medium in interactive mode, high in automation | Interactive tool hooks are currently Bash-focused |
| Kiro | Native hooks | Prompt, tool, and stop hooks | High | Fewer lifecycle events than Claude Code |
| OpenClaw | Plugin bridge | Plugin SDK hooks | Medium to high | Internal hooks are not enough by themselves for full tool-loop visibility |

### Bridge Types

- **Native hook bridge**: Claude Code, Codex, and Kiro expose hook events that VibeMon can translate directly into `start`, `thinking`, `working`, `notification`, `packing`, and `done`.
- **Plugin bridge**: OpenClaw support is intentionally plugin-based. Its simpler internal hooks are session and message oriented, so VibeMon uses plugin SDK lifecycle hooks for better timing.

### Agent-Specific Notes

- **Claude Code**: Best overall source for real-time monitoring. It exposes a broad lifecycle including prompt, tool, permission, compact, and stop events.
- **Codex**: Good fit for VibeMon, but not symmetric with Claude Code yet. Interactive hooks are experimental and the current runtime emits Bash for `PreToolUse`, `PermissionRequest`, and `PostToolUse`. For CI or batch jobs, `codex exec --json` exposes a much richer event stream.
- **Kiro**: Strong tool-level support with explicit `preToolUse` and `postToolUse`, plus namespaced MCP tool names.
- **OpenClaw**: Strongest when treated as a plugin platform. The VibeMon bridge should continue to use plugin hooks instead of depending on the lighter internal hook system.

## Characters

| Character | Color | Description | Auto-selected for |
|-----------|-------|-------------|-------------------|
| `vibemon` | Purple | Robot with antenna, default character | Any bridge without its own character |
| `clawd` | Orange | Four-legged friend | Claude Code |
| `codex` | Navy | Cloud character with light eyes on a dark screen | Codex CLI |
| `kiro` | White | Ghost character | Kiro |
| `claw` | Red | Antenna character | OpenClaw |
| `daangni` | Peach/teal | Round face, fluffy top | Manual only (Character Lock) |

All characters use **image-based rendering** (128x128 PNG, bundled with the app in `src/assets/characters/`). Character is **auto-selected by bridge**, not by the core display runtime. You can also force one with [Character Lock](#character-lock).

Characters are defined in a single registry (`src/shared/data/characters.json`): display name, accent color (the eye/accent overlay drawn on the sprite — white for VibeMon, distinct from the "Color" appearance above), image file, and eye/effect coordinates (in canvas pixels on the 128x128 sprite, adjustable at 1px). The character window, tray icon (downscaled from the same PNG), menus, and validation all derive from it — adding a character is one PNG plus one registry entry.

### Character Lock

Forces the character window to always show one character, ignoring whatever character each project's status reports.

- `auto` (default): each project shows its own character
- Any character name: that character is always shown instead, applied immediately to the open window
- Toggled via the system tray menu (**Character Lock** submenu) or `POST /character-lock`
- Switching back to `auto` doesn't retroactively fix the open window — it picks up each project's real character again on its next status update

## States

The state drives the character's eyes/effects on the sprite, the speech
bubble's background color, and the tray icon's background color. States
are defined in a single registry (`src/shared/data/states.json`): bubble
color/text, focus and loading behavior, and eye/effect type all live in
one entry per state.

| State | Color | Eyes | Bubble text | Trigger |
|-------|-------|------|-------------|---------|
| `start` | Cyan | ■ ■ + ✦ | Hello! | Session begins |
| `idle` | Green | ■ ■ | Ready | Waiting for input |
| `thinking` | Purple | ▀ ▀ + 💭 | Thinking | User submits prompt |
| `planning` | Teal | ▀ ▀ + 💭 | Planning | Plan mode active |
| `working` | Blue | 👓 (glasses) | (tool-based) | Tool executing |
| `packing` | Gray | ▀ ▀ + 💭 | Packing | Context compacting |
| `notification` | Yellow | ● ● + ? | Input? | User input needed |
| `done` | Green | > < | Done! | Tool completed |
| `sleep` | Navy | ─ ─ + Z | Zzz... | 5min inactivity |
| `alert` | Red | ■ ■ + ! | Alert | Critical error/failure |

### Working State Text

The `working` state's speech bubble shows fixed text based on the active tool:

| Tool | Text |
|------|------|
| Bash | Running |
| Read | Reading |
| Edit | Editing |
| Write | Writing |
| Grep / WebSearch | Searching |
| Glob | Scanning |
| WebFetch | Fetching |
| Task | Tasking |
| Default | Working |

### State Timeout

| From State | Timeout | To State |
|------------|---------|----------|
| `start`, `done` | 1 minute | `idle` |
| `planning`, `thinking`, `working`, `packing`, `notification`, `alert` | 5 minutes | `idle` |
| `idle` | 5 minutes | `sleep` |

After 10 minutes in sleep state, the window automatically closes. It reappears on the next status update.

## Animations

- **Floating**: Gentle motion (±3px horizontal, ±5px vertical, ~3.2s cycle)
- **Glasses**: Working state character wears frame-only glasses (lenses stay clear, eyes remain visible)
- **Sparkle**: Session start and working states show rotating sparkle effect
- **Thought bubble**: Thinking, planning, and packing states show animated thought bubble
- **Zzz**: Sleep state shows blinking Z animation
- **Loading dots** (speech bubble): Thinking/planning/packing/working states show animated progress dots — thinking-style states run 3x slower than working
- **Metric bars** (speech bubble): Gradient colors based on usage thresholds:
  - 0-50%: Green
  - 51-70%: Yellow
  - 71-90%: Orange (warning)
  - 91-100%: Red (critical)

## Character Window

The app shows exactly one character window plus its following speech bubble:

- Follows whichever project is currently "focused": the focused project holds the window while it is busy — in an active state (thinking, planning, working, packing, notification, alert) or within 4 seconds of its last active update — so the brief done/idle moments between tools don't bounce the window between concurrent sessions. `alert`/`notification` from another project switch immediately; once the focused project settles, the most recently updated project takes over.
- Status updates for unfocused projects are still recorded in the background (up to 50 projects) and become visible the moment that project gains focus.
- Can be dragged past the screen edge while the drag is in progress; once you let go, it's clamped back fully on-screen.
- Reappears at the same spot you last left it, across restarts.
- The speech bubble follows the character everywhere:
  - If the character is pinned to the top or bottom edge, the bubble moves beside it
  - If the character is pinned to the left or right edge, the bubble moves above or below it
- Shows just the character sprite on a transparent background — status text and metrics live in the speech bubble.

## Desktop App Features

- **Single instance**: Only one app instance can run at a time
- **Frameless window**: Clean floating design
- **Always on Top**: Stays visible above other windows (configurable modes)
- **System Tray**: Quick access from menubar/taskbar
- **Draggable**: Move the character anywhere on screen
- **Snap to corner**: Can be dragged past the screen edge mid-drag; once you let go, it's clamped back on-screen, snapping flush to a corner within a 30px threshold
- **Position survives lock/sleep**: When macOS moves the window itself — screen lock, system sleep, or a display detaching — that move is not saved, and the window returns to its remembered position once its display is back
- **Remembered position**: The window spawns at the position it was last dragged to
- **Click to focus terminal**: Click the character to switch to iTerm2/Ghostty tab (macOS only)

### Always on Top Modes

| Mode | Description |
|------|-------------|
| `all` | The window stays on top regardless of state - **Default** |
| `active-only` | Only active states (thinking, planning, working, packing, notification, alert) stay on top |
| `disabled` | The window never stays on top |

When `active-only` is selected:
- Active states (thinking, planning, working, packing, notification, alert) immediately enable always on top
- Inactive states (start, idle, done, sleep) immediately disable always on top (prevents focus stealing)

Change via system tray menu: Always on Top → Select mode

### Click to Focus Terminal (macOS)

When running Claude Code in multiple terminal tabs, clicking the character window automatically switches to the corresponding terminal tab.

**Supported Terminals:**
- iTerm2 (full tab switching support)
- Ghostty (application activation)

**Requirements:**
- macOS only (uses AppleScript)
- iTerm2 or Ghostty terminal

### Speech Bubble

A small, transparent, click-through window that displays selected info fields (status, project name, model, memory, 5h usage, weekly usage) next to the character. Positioned automatically so it never overlaps the character window and stays on-screen, with an animated slide when it needs to move.

- Toggled per field via the system tray menu (**Speech Bubble** submenu: Status / Project / Model / Memory / Usage 5h / Usage Week)
- The status field shows state-based text (e.g. "Ready", "Thinking") and tool-based text while working (e.g. "Reading"), with animated loading dots during thinking/planning/working/packing — slower for thinking-style states

### Settings Window

A dedicated settings window (tray menu → **Settings...**) with four tabs in a sidebar:

- **VibeMon** — Character Lock, Always on Top mode, Speech Bubble field toggles, Open at Login
- **Collector** — how AI tool session status gets delivered here, locally or via the cloud relay: WebSocket connection status + account token (also writes the collector's `vibemon_token` into `~/.vibemon/config.json`), plus Config (HTTP URLs, Serial Port, VibeMon URL, Debug Logging, Auto-launch Desktop App) read and written directly by the app — no python installer needed
- **AI Tools** — per-tool hook install status for Claude Code / Codex CLI / Kiro IDE / OpenClaw, with one-click Install (Reinstall for already-installed tools) and a Refresh action
- **About** — app version, Check for Updates with one-click download/install, and Docs / GitHub Releases links

Changes apply immediately through the same code paths as the tray menu, and the window re-syncs when refocused so tray-made changes are reflected.

The account token is never returned to the settings renderer after it is saved; the UI only receives whether a token is configured. WebSocket authentication sends the token both as a connection URL query parameter (required by the deployed relay, which authorizes at the HTTP upgrade) and in a protocol auth message after connecting.

### System Tray Menu

Grouped to mirror the Settings window's tab order (VibeMon / Collector / AI Tools / About):

- Settings... (opens the Settings window)
- **VibeMon** — Character Lock (Auto/VibeMon/Clawd/Codex/Kiro/Claw/Daangni), Always on Top, Speech Bubble field toggles, Open at Login toggle
- **Collector** — WebSocket status (Connected/Disconnected), HTTP Server port display
- **AI Tools** — AI Tool Hooks (per-tool install status for Claude Code/Codex CLI/Kiro IDE/OpenClaw, with one-click install), followed by Claude/Codex plan usage grouped per provider (5h and weekly %, each with a heat-colored bar icon and time-to-reset) — read from the shared usage cache independent of which project is focused; rows with no fresh data are omitted
- **About** — opens the Settings window's About tab, followed by a version display or a one-click "Update to vX" / "Restart to install vX" item
- Quit

## Rendering Engine

The character is rendered by a bundled engine (`src/engine/vibemon-engine.js`): a 128x128 canvas drawing the character PNG, state-driven pixel-art eyes/effects, and the floating animation, over a fully transparent background. Character images live in `src/assets/characters/`. No network access is needed to render.

## Build

Hook installation verifies the downloaded installer against the `installer` SHA-256 published in the same origin's `manifest.json` (fetched fresh at install time), so install.py updates ship with a vibemon-docs deploy alone — no app release needed. Custom installer deployments can pin a specific hash via `VIBEMON_INSTALLER_SHA256` together with `VIBEMON_DOCS_URL`; the pin takes precedence over the manifest.

```bash
npm run build:mac     # macOS (DMG, ZIP)
npm run build:win     # Windows (NSIS, Portable)
npm run build:linux   # Linux (AppImage, DEB)
npm run build:all     # All platforms
```
