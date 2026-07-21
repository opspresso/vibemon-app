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
- **Main process**: `src/main.js` (entry point), `src/modules/*.cjs` (http-server, http-utils, character-window-manager, bubble-window-manager, state-manager, tray-manager, settings-window-manager, validators, ws-client, hook-installer, update-checker, usage-refresher, usage-cache-reader, vibemon-config-manager, window-position)
- **Renderer**: `src/index.html` + `src/renderer.js` + `src/styles.css` (character window), `src/preload.js` (contextBridge/IPC), `src/bubble.html` + `src/bubble/vibemon-bubble.js` + `src/bubble/vibemon-bubble.css` (speech bubble), `src/dashboard.html` (HTTP dashboard), `src/settings.html` + `src/settings-preload.js` (Settings window, opened via tray → Settings...)
- **Rendering engine**: `src/engine/vibemon-engine.js` (2D pixel-art engine, vendored from vibemon-static, default) and `src/engine/vibemon-engine-3d.js` (three.js articulated pet on a transparent WebGL canvas) + `src/engine/monster-states.js` (pure state/theme definitions, no three import) + `src/vendor/three.module.min.js`/`three.core.min.js` (vendored three.js — CSP `script-src 'self'` requires local files). `src/assets/characters/*.png` are the 2D sprites (remote-first from static.vibemon.io, bundled as offline fallback) and the tray icon source
- **Shared**: `src/shared/` folder (config, constants, characters, registry-cache)
- **Config Data**: `src/shared/data/constants.json` (ports/limits, window size, timeouts — ms values use an `_MS` suffix), `src/shared/data/states.json` + `src/shared/data/characters.json` (bundled fallbacks for the canonical registry in [vibemon-static](https://github.com/opspresso/vibemon-static); keep in sync via `npm run check:registry`)
- **Documentation**: `README.md` (repo + npm package), `CLAUDE.md`, `docs/*`

## Key Patterns

- **Single character window**: `CharacterWindowManager` keeps exactly one frameless window (`entry = { window, state, projectId }`) that is retargeted — not recreated — when focus moves to another project. `routeStatusUpdate()` is the single ingestion entry point shared by HTTP `POST /status` and the WebSocket client; it drops the internal `.vibemon` project (the usage refresher's `claude -p "/usage"` session, reported by hooks predating the suppression guards) so it never reaches the registry, focus, or window.
- **Focus selection**: The focused project holds the window while it is busy — currently in an active state (`ACTIVE_STATES`), or within `FOCUS_HYSTERESIS_MS` (4s) of its last active update, so the momentary `done`/`idle` gaps between tools can't let concurrent sessions steal the window from each other. `alert`/`notification` from another project take focus immediately. Once the focused project settles past the window, the most recently updated project takes focus. State timeouts record state without moving focus (`selectFocus()`, `routeStatusUpdate(..., { preserveFocus })`).
- **State registry**: Every incoming status is recorded in `stateRegistry` (LRU, max `MAX_STATE_REGISTRY_SIZE`=50) regardless of focus, so an unfocused project's latest state is shown the moment it gains focus.
- **State-based rendering**: `state` → eyes/effects on the 2D sprite (registry `eyeType`/`effect`) or joint animation on the 3D pet (`STATE_ANIMATIONS` in monster-states.js), speech bubble background color (`STATE_COLORS`), tray icon background.
- **Render mode**: persisted `renderMode` setting (`'2d'` default, or `'3d'`) selects which engine the character window boots — `src/engine/vibemon-engine.js` (2D pixel-art sprite) or `src/engine/vibemon-engine-3d.js` (3D pet); renderer.js dynamic-imports by mode (`electronAPI.getRenderMode()`), and `setRenderMode()` reloads the open window and replays its state. Switch via tray menu (**Render Mode**) or Settings → VibeMon.
- **Rendering engine (3D)**: `src/engine/vibemon-engine-3d.js` builds a procedural digital vibe monster (primitives + flat materials, no models/textures) — a squishy horned egg body with big glinted eyes, cheek blushes, nub arms, a spade tail, and a "vibe flame" (unlit MeshBasicMaterial) burning above its head — with THREE.Group pivots for body/arms/tail chain/flame. Each state sets a `vibe` energy level driving the flame's size/flicker and tail sway (sleep 0.25× → alert 2.6×), and state motion is creature behavior (gazing around, waving, tail-tapping, scanning, orbit-drifting, heartbeat pulsing, coiling, popping up, pirouetting, nodding off, sinking, shivering, darting glances) except working, which mimes a typing frenzy (`STATE_ANIMATIONS`/`MOVES` in monster-states.js). Each of the 10 states maps to a target pose + named procedural moves (`monster-states.js`: `STATE_ANIMATIONS`, `MOVES`, `CHARACTER_THEMES`); poses blend smoothly on state change, the loop is capped at ~30fps, and the WebGL canvas fills the 172x160 window with the floating animation done in-scene. `tests/monster-states.test.js`/`tests/engine-3d.test.js` guard that every registry state has an animation and every move/joint referenced is implemented.
- **Speech bubble**: All status/metric text renders in the bubble window (`bubble.html` via `BubbleWindowManager`), not on the character canvas. Working text is tool-based via `TOOL_TEXTS` (Bash→Running, Read→Reading, ...); loading dots animate 3x slower for thinking/planning/packing. Placement uses a d3-force simulation; the bubble is forced beside the character when it's pinned to the top/bottom edge, and above/below when pinned to the left/right edge (`computePlacement()`).
- **JSON fields**: `{"state", "tool", "project", "model", "memory", "usage5h", "usageWeek", "usage5hResetsIn", "usageWeekResetsIn", "usageWeekModel", "usageWeekModelResetsIn", "usageWeekModelLabel", "character", "terminalId"}` (`*ResetsIn` = minutes until the usage window resets, shown in the speech bubble; `usageWeekModel*` = the model-scoped weekly limit — e.g. the Fable weekly bucket — with its display label, rendered as percentage only ("Fable 12%") since its window resets with the weekly one; `terminalId` enables click-to-focus)
- **Characters**: `vibemon` (purple robot, default), `codex` (blue cloud, light eyes on a dark screen), `clawd` (orange), `kiro` (white ghost), `claw` (red), `daangni` (peach/teal, manual only); unknown names from bridges fall back to the default
- **Canonical registry (vibemon-static)**: the state/character registries live in the [vibemon-static](https://github.com/opspresso/vibemon-static) repo and are served from static.vibemon.io (`/data/states.json`, `/data/characters.json`, `/characters/{name}.png`). `src/shared/registry-cache.cjs` resolves them at startup (validated cached remote copy → bundled `src/shared/data/*.json`) and refreshes the cache in the background (`UPDATE_CHECK_INTERVAL_MS`); a refreshed registry applies on the next launch. Remote payloads are sanitized: states must be a superset of the bundled state names, unknown eyeType/effect are clamped to engine-drawable values, and character names/image filenames must match strict patterns. Character images load remote-first with the bundled asset as fallback (renderer builds candidate URL lists; CSP allows `https://static.vibemon.io`).
- **State registry**: per-state color/text/active/loading/eyeType/effect. `states.cjs` derives `VALID_STATES`/`ACTIVE_STATES`/`LOADING_STATES`/`STATE_COLORS`/`STATE_TEXTS` for the speech bubble, tray, focus selection, and validation; the renderer fetches the same registry via `preload.js` → `electronAPI.getStateRegistry()` (the 2D engine consumes `eyeType`/`effect`; the 3D engine keys its animations by state name). **To change a state**: edit the vibemon-static registry entry, then sync the bundled fallback (`npm run check:registry -- --fix`). `tests/states.test.js` guards the registry invariants and that every eyeType/effect value has an engine drawing branch.
- **Character registry**: default + per-character displayName/color/image/eyes/effect (+ optional `eyeColor` — blink/happy stroke color, default `#000000` — and `glassesColor` — glasses frame color, default `#111111` — for characters with a dark face like codex; `color` is the eye-cover fill, i.e. the color behind the eyes); `eyes` anchors the eye-cover overlays — glasses/blink/happy — drawn over the PNG. Eye/effect anchors are in canvas pixels (0–128), used by the vendored 2D engine; the 3D engine instead maps characters to color themes (`CHARACTER_THEMES` in monster-states.js, registry `color`/`eyeColor` as fallback for unknown names). Consumed by the renderer (via `preload.js` → `electronAPI.getCharacterRegistry()`), tray icon (PNG downscaled to 22px), menus (displayName labels), and validation (`characters.cjs` derives `DEFAULT_CHARACTER`/`CHARACTER_CONFIG`/`CHARACTER_NAMES`/`CHARACTER_COLORS`). **To add a character**: add a 128x128 PNG and one registry entry to vibemon-static, then sync the bundled fallbacks (`npm run check:registry -- --fix`). `tests/characters.test.js` guards the registry invariants.
- **Character Lock**: Persisted `characterLock` setting (`'auto'` default, or a `CHARACTER_NAMES` entry) forces the window to show one character regardless of what each project's status reports; applied in `routeStatusUpdate()` so it covers stateRegistry, window state, and the IPC payload uniformly. Switch via tray menu (**Character Lock**) or `POST /character-lock`.
- **Snap to corner**: The window can be dragged freely, including past screen edges while the drag is in progress; once movement settles (150ms debounce, i.e. the drag ends) it is clamped back fully on-screen, snapping flush to a corner if it landed within 30px of one. Snap/persist only applies to user drags: during screen lock, system sleep, and display attach/detach (where macOS moves windows itself) tracking is suspended, and the window is restored to its saved position once its display is available again (`suspendPositionTracking()`/`restoreWindowPosition()`, wired to `powerMonitor`/`screen` events in `main.js`)
- **Remembered position**: The window's settled position is persisted (`windowPosition`) and used as the spawn point the next time the window is created
- **Window close timer**: The window auto-closes after 10min in sleep state; reopens on new status
- **Click to focus terminal**: Click the character to switch to the corresponding iTerm2 or Ghostty tab (macOS only, uses `terminalId` from `ITERM_SESSION_ID` or `GHOSTTY_PID`)
- **Interaction expression + manual drag**: From the moment the character is pressed (pointerdown) until release, the renderer temporarily overrides the engine state with `start` (greeting) and restores the last reported state afterwards. The display area is deliberately *not* an app-region drag surface (that would swallow pointerdown), so dragging is manual: pointerdown anchors the drag (`window-drag-start` IPC → `beginUserDrag()`), pointermove asks the main process to move the window along with the cursor (`window-drag-move` → `moveUserDrag()`, reading the cursor via `screen.getCursorScreenPoint()`), and the resulting `move` events feed the usual snap/persist debounce. Clicks that dragged the window don't trigger click-to-focus
- **Open at Login**: Configurable via system tray menu; uses Electron `app.setLoginItemSettings()` to auto-start on macOS login
- **Usage cache refresh**: `UsageRefresher` (`usage-refresher.cjs`) runs `~/.vibemon/usage.py` (installed by the docs installer) shortly after startup and every `USAGE_REFRESH_INTERVAL_MS`, refreshing the shared plan-usage cache (`~/.vibemon/cache/usage.json`) that the AI-tool hooks attach to `POST /status` as `usage5h`/`usageWeek`; the script's `--max-age` flag and file lock keep it collision-free with `~/.claude/statusline.py`'s own refresh. `usage.py` fetches usage via `claude -p "/usage"`, itself a real Claude Code session, so `UsageRefresher` sets `VIBEMON_SUPPRESS_HOOKS=1` in its spawn env — inherited down to that subprocess — so its own hooks (installed by vibemon-docs) skip reporting status instead of surfacing it as a phantom `.vibemon` project
- **Tray usage display**: `usage-cache-reader.cjs` reads the same `~/.vibemon/cache/usage.json` directly (independent of `usage5h`/`usageWeek` on any tracked project's status) so `tray-manager.cjs` can show Claude and Codex plan usage (5h + weekly %, each with a heat-colored bar icon rendered via node-canvas and time-to-reset, grouped under a per-provider header) below the AI Tool Hooks item in the tray menu, account-level regardless of which project is focused; buckets with stale or missing data are omitted rather than shown as a placeholder
- **Auto-update**: `UpdateChecker` (`update-checker.cjs`) wraps `electron-updater` against the GitHub Releases provider; checks periodically in the background (`UPDATE_CHECK_INTERVAL_MS`, packaged builds only) and surfaces a one-click "⬆ Update to vX" tray menu item that downloads and installs (`autoUpdater.quitAndInstall`) — no auto-download without a user click. Windows Authenticode verification is skipped (`verifyUpdateCodeSignature` override): the self-signed cert can never chain to a trusted root, so integrity relies on HTTPS + the latest.yml sha512 check
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
| `sleep` | Navy | After 5min in idle |
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
