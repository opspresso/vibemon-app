# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time status monitor for AI assistants (Claude Code, Codex, Kiro, OpenClaw) with pixel art character.

Desktop App (Electron) with system tray. The ESP32 hardware display lives in the separate [vibemon-esp32](https://github.com/opspresso/vibemon-esp32) repository.

## Development Environment

```bash
npm install
npm start
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Desktop App (Electron)                 │
│  HTTP Server (19280) → Multi-Window Manager         │
│        ↓                      ↓                     │
│  System Tray ←── IPC ──→ Multiple Windows (canvas)  │
└─────────────────────────────────────────────────────┘
```

### Key Files
- **Desktop**: `src/main.js` (entry point), `src/preload.js` (Electron contextBridge/IPC), `src/modules/*.cjs` (http-server, http-utils, multi-window-manager, bubble-window-manager, state-manager, tray-manager, settings-window-manager, validators, ws-client, hook-installer, update-checker, vibemon-config-manager), `src/renderer.js` + `src/index.html`/`bubble.html`/`dashboard.html` (renderer views; `renderer.js` loads the character/canvas rendering engine from the remote `vibemon-engine-standalone.js`), `src/settings.html` + `src/settings-preload.js` (Settings window UI, opened via tray → Settings...)
- **Shared**: `src/shared/` folder (config, constants)
- **Config Data**: `src/shared/data/constants.json` (single source of truth - window dimensions, animation settings, limits)
- **Documentation**: `README.md` (repo + npm package), `CLAUDE.md`, `docs/*`

## Key Patterns

- **State-based rendering**: `state` → color, eyeType, text
- **Animation**: `animFrame % N` approach (100ms tick)
- **Floating**: Cosine/Sine wave offset (X: ±3px, Y: ±5px, ~3.2s cycle)
- **Working text**: Tool-based fixed text via `getWorkingText(tool)` (Bash→Running, Read→Reading, Edit→Editing, Write→Writing, Grep/WebSearch→Searching, Glob→Scanning, WebFetch→Fetching, Task→Tasking, default→Working)
- **JSON fields**: `{"state", "tool", "project", "model", "memory", "usage5h", "usageWeek", "usage5hResetsIn", "usageWeekResetsIn", "character"}` (Desktop adds `"terminalId"` for click-to-focus; `*ResetsIn` = minutes until the usage window resets, shown in the speech bubble)
- **Characters**: `vibemon` (purple robot, default), `clawd` (orange), `kiro` (white ghost), `claw` (red), `daangni` (peach/teal, manual only); unknown names from bridges fall back to the default
- **Character Lock**: Persisted `characterLock` setting (`'auto'` default, or a `CHARACTER_NAMES` entry) forces every window to show one character regardless of what each project's status reports; applied in `MultiWindowManager.routeStatusUpdate()` so it covers stateRegistry, window state, and the IPC payload uniformly. Switch via tray menu (**Character Lock**) or `POST /character-lock`.
- **Metric rows**: memory (🧠), 5h usage (⏱️), weekly usage (📅) each render as a single line `[icon] [bar] [NN%]` at the bottom; `usage5h`/`usageWeek` are plan-usage % (0-100) from statusline's `usage.json`
- **Memory hidden on start**: Memory not displayed during `start` state
- **Project change resets**: Model/memory cleared when project changes (usage is account-global, not reset)
- **Sparkle effect (start, working)**: Animated 4-point star sparkle
- **Glasses (working)**: Frame-only glasses, lenses stay clear so the eyes underneath remain visible (EYE_GLASSES)
- **Loading dots speed**: Thinking/planning/packing states use 3x slower animation than working state
- **Snap to corner**: Windows can be dragged freely, including past screen edges while the drag is in progress; once movement settles (150ms debounce, i.e. the drag ends) the window is clamped back fully on-screen, snapping flush to a corner if it landed within 30px of one
- **Remembered position**: A window's settled position is saved (per-project for Window Mode, one shared spot for Character Mode's window) and used as the spawn point the next time a window is created for that key
- **Window close timer**: Desktop window auto-closes after 10min in sleep state; reopens on new status
- **Click to focus terminal**: Click window to switch to corresponding iTerm2 or Ghostty tab (macOS only, uses `terminalId` from `ITERM_SESSION_ID` or `GHOSTTY_PID`)
- **Open at Login**: Configurable via system tray menu; uses Electron `app.setLoginItemSettings()` to auto-start on macOS login
- **Auto-update (Desktop)**: `UpdateChecker` (`update-checker.cjs`) wraps `electron-updater` against the GitHub Releases provider; checks periodically in the background (`UPDATE_CHECK_INTERVAL_MS`, packaged builds only) and surfaces a one-click "⬆ Update to vX" tray menu item that downloads and installs (`autoUpdater.quitAndInstall`) — no auto-download without a user click
- **Settings Window (Desktop)**: `SettingsWindowManager` (`settings-window-manager.cjs`) hosts `settings.html` (sidebar tabs: VibeMon / Collector / AI Tools / About) behind `settings-preload.js`'s `settingsAPI`; every mutation goes through the same manager methods as the tray menu, `onSettingsChanged` refreshes the tray, and the page re-syncs on window focus. The Collector tab is backed by `VibemonConfigManager` (`vibemon-config-manager.cjs`), which reads/writes `~/.vibemon/config.json` directly (no python installer needed) and keeps `http_urls` pointed at this app
- **State-based always on top**: Active states (thinking, planning, working, packing, notification, alert) keep window on top; inactive states (start, idle, done, sleep) disable always on top to reduce screen obstruction
- **Always on Top Modes**: `all` (default), `active-only`, `disabled` - configurable via system tray menu
- **Always on Top**: Active states enable on top immediately; inactive states disable on top immediately (no grace period, prevents focus stealing)

## App Mode

Three mutually-exclusive top-level modes (desktop app only), switched via system tray menu or the `/app-mode` API:

- **Character mode**: Default. Exactly one character window + following speech bubble, subject to the same 10-minute sleep-state close timeout as any other window (see "Window close timer" above) — reappears on the next status update. Shows whichever project is currently focused — an active-state (`ACTIVE_STATES`) project always takes focus, otherwise the most recently updated project keeps it (see `selectFocus()`/`pickInitialFocus()` in `multi-window-manager.cjs`). The window can be dragged past the screen edge but is clamped fully back on-screen once the drag settles; the speech bubble is forced beside the character when it's pinned to the top/bottom edge, and above/below when pinned to the left/right edge (`computePlacement()` in `bubble-window-manager.cjs`).
- **Window mode**: Per-project windows (`multi` or `single` sub-mode).
- **Input mode**: No windows shown at all; status is still collected into `stateRegistry` in the background so switching to another mode immediately restores it (`onResyncNeeded` callback replays it through the normal ingestion pipeline).

`multi-window-manager.cjs`'s `routeStatusUpdate()` is the single entry point (shared by HTTP `/status` and the WebSocket client) that branches on the current app mode.

### Window Mode sub-modes
- **Multi mode**: Each project gets its own window (max 5, or fewer if the screen is smaller)
- **Single mode** (default): One window, reused for each project; supports project lock

### Multi-Window Mode
- Windows tile into a 2D grid: filled row-first from the top-right, wrapping to the next row down once a row's width is full; stops creating new windows once the grid (both across and down) is full
- Within the fill order, active states come first (rightmost of the top row), then inactive states, sorted by name descending (Z first) within each group
- Auto-rearranges when state changes or window closes
- 10px gap between windows

### Single-Window Mode
- System tray's Project Lock submenu shows up to 10 recently-used projects

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /status` | Create/update window for project |
| `GET /status` | Returns current state |
| `GET /health` | Health check |
| `POST /lock` | Lock to project |
| `POST /unlock` | Unlock project |
| `GET /lock-mode` | Get current lock mode |
| `POST /lock-mode` | Set lock mode |
| `GET /windows` | List all active windows |
| `POST /close` | Close specific project window |
| `POST /show` | Show window |
| `GET /window-mode` | Get current window mode sub-mode (multi/single) |
| `POST /window-mode` | Set window mode sub-mode |
| `GET /app-mode` | Get current app mode (character/window/input) |
| `POST /app-mode` | Set app mode |
| `GET /character-lock` | Get current character lock (auto/character name) |
| `POST /character-lock` | Set character lock |
| `GET /debug` | Window/display debug info |
| `GET /` | Dashboard HTML page |
| `GET /dashboard-data` | Dashboard data (windows, modes, lock) |
| `POST /quit` | Quit application |

## States

| State | Color | Description |
|-------|-------|-------------|
| `start` | Cyan | Session begins |
| `idle` | Green | Waiting for input |
| `thinking` | Purple | Processing prompt |
| `planning` | Teal | Plan mode active |
| `working` | Blue | Tool executing |
| `packing` | Gray | Context compacting |
| `notification` | Yellow | User input needed |
| `done` | Green | Tool completed |
| `sleep` | Navy | 5min inactivity |
| `alert` | Red | Critical error/failure |

## Testing

```bash
# Test multiple windows
curl -X POST http://127.0.0.1:19280/status \
  -H "Content-Type: application/json" \
  -d '{"state":"working","project":"project-a"}'

curl -X POST http://127.0.0.1:19280/status \
  -H "Content-Type: application/json" \
  -d '{"state":"thinking","project":"project-b"}'

# List windows
curl http://127.0.0.1:19280/windows
```
