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
| `clawd` | Orange | Default character | Claude Code |
| `codex` | Green | Terminal robot | Codex |
| `kiro` | White | Ghost character | Kiro |
| `claw` | Red | Antenna character | OpenClaw |

All characters use **image-based rendering** (128x128 PNG). Character is **auto-selected by bridge**, not by the core display runtime. You can also manually change it via the system tray menu.

## States

| State | Background | Eyes | Text | Trigger |
|-------|------------|------|------|---------|
| `start` | Cyan | ■ ■ + ✦ | Hello! | Session begins |
| `idle` | Green | ■ ■ | Ready | Waiting for input |
| `thinking` | Purple | ▀ ▀ + 💭 | Thinking | User submits prompt |
| `planning` | Teal | ▀ ▀ + 💭 | Planning | Plan mode active |
| `working` | Blue | 🕶️ (sunglasses) | (tool-based) | Tool executing |
| `packing` | Gray | ▀ ▀ + 💭 | Packing | Context compacting |
| `notification` | Yellow | ● ● + ? | Input? | User input needed |
| `done` | Green | > < | Done! | Tool completed |
| `sleep` | Navy | ─ ─ + Z | Zzz... | 5min inactivity |
| `alert` | Red | ■ ■ + ! | Alert | Critical error/failure (ESP32: triggers alert light if configured) |

### Working State Text

The `working` state displays fixed text based on the active tool:

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

**Desktop only:** After 10 minutes in sleep state, the window automatically closes.

### Display Behavior

- **Memory hidden on start**: Memory percentage is not displayed during `start` state
- **Project change resets**: Model and memory are cleared when switching to a different project

## Animations

- **Floating**: Gentle motion (±3px horizontal, ±5px vertical, ~3.2s cycle)
- **Blink**: Idle state blinks every 3.2 seconds
- **Loading dots**: Thinking/planning/packing/working states show animated progress dots
  - Thinking/planning/packing: 3x slower animation for contemplative feel
  - Working: Normal speed animation
- **Matrix rain**: Working state shows falling green code effect (Desktop only)
- **Sunglasses**: Working state character wears Matrix-style sunglasses
- **Sparkle**: Session start and working states show rotating sparkle effect
- **Thought bubble**: Thinking, planning, and packing states show animated thought bubble
- **Zzz**: Sleep state shows blinking Z animation
- **Memory bar**: Gradient colors based on usage thresholds:
  - 0-74%: Green
  - 75-89%: Yellow (warning)
  - 90-100%: Red (critical)

## Window Mode

The Desktop App supports two window modes:

| Mode | Description |
|------|-------------|
| `multi` | One window per project (max 5) - **Default** |
| `single` | One window with project lock support |

### Multi-Window Mode (Default)

- Each project gets its own window
- Windows arranged by state and name:
  - **Right side**: Active states (thinking, planning, working, packing, notification, alert)
  - **Left side**: Inactive states (start, idle, done, sleep)
  - Within each group, sorted by project name (Z first = rightmost)
- Max 5 windows (or screen limit)
- 10px gap between windows

### Single-Window Mode

- Only one window at a time
- Project lock feature available
- When switching projects, the same window is reused

### Switching Modes

Use the system tray menu or API:

```bash
curl -X POST http://127.0.0.1:19280/window-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"single"}'
```

## Project Lock

Lock the monitor to a specific project to prevent display updates from other projects.

> **Note:** Project lock is only available in **single-window mode**.

### Lock Modes

| Mode | Description |
|------|-------------|
| `first-project` | First incoming project is automatically locked |
| `on-thinking` | Lock when entering thinking state (default) |

### CLI Commands

```bash
# Claude Code example: lock current project
python3 ~/.claude/hooks/vibemon.py --lock

# Lock specific project
python3 ~/.claude/hooks/vibemon.py --lock my-project

# Unlock
python3 ~/.claude/hooks/vibemon.py --unlock

# Get current status
python3 ~/.claude/hooks/vibemon.py --status

# Get/Set lock mode
python3 ~/.claude/hooks/vibemon.py --lock-mode
python3 ~/.claude/hooks/vibemon.py --lock-mode on-thinking

# Reboot ESP32 device
python3 ~/.claude/hooks/vibemon.py --reboot
```

For Codex or Kiro, use the equivalent bridge path:

```bash
python3 ~/.codex/hooks/vibemon.py --lock
python3 ~/.kiro/hooks/vibemon.py --lock
```

OpenClaw uses its plugin bridge instead of a Python hook CLI.

## Desktop App Features

- **Single instance**: Only one app instance can run at a time
- **Frameless window**: Clean floating design
- **Always on Top**: Stays visible above other windows (configurable modes)
- **System Tray**: Quick access from menubar/taskbar
- **Draggable**: Move window anywhere on screen
- **Snap to corner**: Auto-snaps to screen corners (30px threshold)
- **Click to focus terminal**: Click window to switch to iTerm2/Ghostty tab (macOS only)

### Always on Top Modes

| Mode | Description |
|------|-------------|
| `active-only` | Only active states (thinking, planning, working, packing, notification, alert) stay on top - **Default** |
| `all` | All windows stay on top regardless of state |
| `disabled` | No windows stay on top |

When `active-only` is selected:
- Active states (thinking, planning, working, packing, notification, alert) immediately enable always on top
- Inactive states (start, idle, done, sleep) immediately disable always on top (prevents focus stealing)

Change via system tray menu: Always on Top → Select mode

### Click to Focus Terminal (macOS)

When running Claude Code in multiple terminal tabs, clicking a VibeMon window automatically switches to the corresponding terminal tab.

**Supported Terminals:**
- iTerm2 (full tab switching support)
- Ghostty (application activation)

**Requirements:**
- macOS only (uses AppleScript)
- iTerm2 or Ghostty terminal

### Character Only Mode

Shrinks the window to show just the character, hiding the title bar, device frame, status text, and metric rows.

- Toggled via the system tray menu (**Character Only Mode**)
- When enabled, project/memory/usage info can still be shown via **Speech Bubble** fields instead

### Speech Bubble

A small, transparent, click-through window per project that displays selected info fields (project name, memory, 5h usage, weekly usage) next to the character. Positioned automatically so it never overlaps the character window and stays on-screen, with an animated slide when it needs to move.

- Toggled per field via the system tray menu (**Speech Bubble** submenu: Project / Memory / Usage 5h / Usage Week)
- Intended to pair with **Character Only Mode**, which hides the same info from the main window

### System Tray Menu

- View active windows and their states
- Manually change state (per window)
- Switch character (Clawd/Codex/Kiro/Claw)
- Rearrange windows (multi-window mode only)
- Toggle Always on Top
- Toggle window mode (Multi/Single)
- Toggle Character Only Mode
- Speech Bubble field toggles (Project/Memory/Usage 5h/Usage Week)
- Open at Login toggle
- Project lock (in single mode)
- Claude Stats
- WebSocket status (Connected/Disconnected)
- Set Token (WebSocket token configuration)
- HTTP Server port display
- Version display
- Docs (opens vibemon.io/docs in browser)
- Quit

## Build

```bash
cd desktop

npm run build:mac     # macOS (DMG, ZIP)
npm run build:win     # Windows (NSIS, Portable)
npm run build:linux   # Linux (AppImage, DEB)
npm run build:all     # All platforms
```
