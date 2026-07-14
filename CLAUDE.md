# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time status monitor for AI assistants (Claude Code, Codex, Kiro, OpenClaw) with a pixel art character.

Desktop App (Electron) with system tray. One character window + following speech bubble; no other display modes. The ESP32 hardware display lives in the separate [vibemon-esp32](https://github.com/opspresso/vibemon-esp32) repository.

## Development Environment

```bash
npm install
npm start
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Desktop App (Electron)                 │
│  HTTP Server (19280) → CharacterWindowManager       │
│        ↓                      ↓                     │
│  System Tray ←── IPC ──→ Character Window (canvas)  │
│                          + Speech Bubble Window     │
└─────────────────────────────────────────────────────┘
```

### Key Files
- **Main process**: `src/main.js` (entry point), `src/modules/*.cjs` (http-server, http-utils, character-window-manager, bubble-window-manager, state-manager, tray-manager, settings-window-manager, validators, ws-client, hook-installer, update-checker, vibemon-config-manager, window-position)
- **Renderer**: `src/index.html` + `src/renderer.js` + `src/styles.css` (character window), `src/preload.js` (contextBridge/IPC), `src/bubble.html` (speech bubble), `src/dashboard.html` (HTTP dashboard), `src/settings.html` + `src/settings-preload.js` (Settings window, opened via tray → Settings...)
- **Rendering engine**: `src/engine/vibemon-engine.js` (bundled ES module — character sprite, eyes/effects, floating animation on a transparent 128x128 canvas), `src/assets/characters/*.png` (character images; fully self-contained, no network/CDN dependency)
- **Shared**: `src/shared/` folder (config, constants, characters)
- **Config Data**: `src/shared/data/constants.json` (window size, timeouts, states, texts), `src/shared/data/characters.json` (character registry - single source of truth for characters)
- **Documentation**: `README.md` (repo + npm package), `CLAUDE.md`, `docs/*`

## Key Patterns

- **Single character window**: `CharacterWindowManager` keeps exactly one frameless window (`entry = { window, state, projectId }`) that is retargeted — not recreated — when focus moves to another project. `routeStatusUpdate()` is the single ingestion entry point shared by HTTP `POST /status` and the WebSocket client.
- **Focus selection**: An active-state (`ACTIVE_STATES`) project takes focus; otherwise the most recently updated project keeps it. A still-active focused project only loses focus after `FOCUS_HYSTERESIS_MS` (4s), except `alert`/`notification` which steal focus immediately (`selectFocus()`).
- **State registry**: Every incoming status is recorded in `stateRegistry` (LRU, max `MAX_STATE_REGISTRY_SIZE`=50) regardless of focus, so an unfocused project's latest state is shown the moment it gains focus.
- **State-based rendering**: `state` → eyes/effects on the sprite (engine `STATES`), speech bubble background color (`STATE_COLORS`), tray icon background.
- **Rendering engine**: `src/engine/vibemon-engine.js` draws the character PNG + pixel-art eyes/effects on a transparent canvas at 100ms ticks; floating via cosine/sine offset (X: ±3px, Y: ±5px, ~3.2s cycle). Layout constants (CHAR_X_BASE=22, CHAR_Y_BASE=20, CHAR_SIZE=128) must stay in sync with `styles.css`, `character-window-manager.cjs`'s window height, and `bubble-window-manager.cjs`'s CHARACTER_OFFSET.
- **Speech bubble**: All status/metric text renders in the bubble window (`bubble.html` via `BubbleWindowManager`), not on the character canvas. Working text is tool-based via `TOOL_TEXTS` (Bash→Running, Read→Reading, ...); loading dots animate 3x slower for thinking/planning/packing. Placement uses a d3-force simulation; the bubble is forced beside the character when it's pinned to the top/bottom edge, and above/below when pinned to the left/right edge (`computePlacement()`).
- **JSON fields**: `{"state", "tool", "project", "model", "memory", "usage5h", "usageWeek", "usage5hResetsIn", "usageWeekResetsIn", "character", "terminalId"}` (`*ResetsIn` = minutes until the usage window resets, shown in the speech bubble; `terminalId` enables click-to-focus)
- **Characters**: `vibemon` (purple robot, default), `clawd` (orange), `kiro` (white ghost), `claw` (red), `daangni` (peach/teal, manual only); unknown names from bridges fall back to the default
- **Character registry**: `src/shared/data/characters.json` is the single source of truth (default + per-character displayName/color/image/eyes/effect; `eyes` anchors the eye-cover overlays — glasses/blink/happy — drawn over the PNG). Consumed by the engine (via `preload.js` → `electronAPI.characterRegistry`), tray icon (PNG downscaled to 22px), menus (displayName labels), and validation (`characters.cjs` derives `DEFAULT_CHARACTER`/`CHARACTER_CONFIG`/`CHARACTER_NAMES`/`CHARACTER_COLORS`). **To add a character**: drop a 128x128 PNG into `src/assets/characters/` and add one registry entry — nothing else. `tests/characters.test.js` guards the registry invariants.
- **Character Lock**: Persisted `characterLock` setting (`'auto'` default, or a `CHARACTER_NAMES` entry) forces the window to show one character regardless of what each project's status reports; applied in `routeStatusUpdate()` so it covers stateRegistry, window state, and the IPC payload uniformly. Switch via tray menu (**Character Lock**) or `POST /character-lock`.
- **Snap to corner**: The window can be dragged freely, including past screen edges while the drag is in progress; once movement settles (150ms debounce, i.e. the drag ends) it is clamped back fully on-screen, snapping flush to a corner if it landed within 30px of one. Snap/persist only applies to user drags: during screen lock, system sleep, and display attach/detach (where macOS moves windows itself) tracking is suspended, and the window is restored to its saved position once its display is available again (`suspendPositionTracking()`/`restoreWindowPosition()`, wired to `powerMonitor`/`screen` events in `main.js`)
- **Remembered position**: The window's settled position is persisted (`windowPosition`) and used as the spawn point the next time the window is created
- **Window close timer**: The window auto-closes after 10min in sleep state; reopens on new status
- **Click to focus terminal**: Click the character to switch to the corresponding iTerm2 or Ghostty tab (macOS only, uses `terminalId` from `ITERM_SESSION_ID` or `GHOSTTY_PID`)
- **Open at Login**: Configurable via system tray menu; uses Electron `app.setLoginItemSettings()` to auto-start on macOS login
- **Auto-update**: `UpdateChecker` (`update-checker.cjs`) wraps `electron-updater` against the GitHub Releases provider; checks periodically in the background (`UPDATE_CHECK_INTERVAL_MS`, packaged builds only) and surfaces a one-click "⬆ Update to vX" tray menu item that downloads and installs (`autoUpdater.quitAndInstall`) — no auto-download without a user click
- **Settings Window**: `SettingsWindowManager` (`settings-window-manager.cjs`) hosts `settings.html` (sidebar tabs: VibeMon / Collector / AI Tools / About) behind `settings-preload.js`'s `settingsAPI`; every mutation goes through the same manager methods as the tray menu, `onSettingsChanged` refreshes the tray, and the page re-syncs on window focus. The Collector tab is backed by `VibemonConfigManager` (`vibemon-config-manager.cjs`), which reads/writes `~/.vibemon/config.json` directly (no python installer needed) and keeps `http_urls` pointed at this app
- **Always on Top Modes**: `all` (default), `active-only`, `disabled` - configurable via system tray menu. Active states (thinking, planning, working, packing, notification, alert) enable on top immediately; inactive states disable it immediately (no grace period, prevents focus stealing). The bubble window's flag is kept in sync with the character window's.

## HTTP API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /status` | Update a project's status |
| `GET /status` | All tracked project states + focused project |
| `GET /health` | Health check |
| `POST /close` | Close the character window (per project) |
| `POST /show` | Show the character window |
| `GET /character-lock` | Get current character lock (auto/character name) |
| `POST /character-lock` | Set character lock |
| `GET /debug` | Window/display debug info |
| `GET /` | Dashboard HTML page |
| `GET /dashboard-data` | Dashboard data (focused project, character lock, tracked projects) |
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
npm test        # jest
npm run lint    # eslint

# Send a status (the character follows the focused project)
curl -X POST http://127.0.0.1:19280/status \
  -H "Content-Type: application/json" \
  -d '{"state":"working","project":"project-a"}'

# Inspect tracked projects and focus
curl http://127.0.0.1:19280/status
```
