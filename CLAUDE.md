# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time status monitor for AI assistants (Claude Code, Codex, Kiro, OpenClaw) with pixel art character.

**Platforms:**
- ESP32 Hardware (172×320 or 170×320 LCD, selected via BOARD_TYPE) - Primary, always-on desk companion
- Desktop App (Electron) - Alternative for non-hardware users

**Supported ESP32 boards (compile-time selection via `BOARD_TYPE` in `credentials.h`):**
- ESP32-C6-LCD-1.47 — ST7789V2, 172×320, GPIO22 PWM backlight
- ESP32-C6-LCD-1.9  — ST7789V2, 170×320, GPIO15 direct backlight active-low (touch optional)

## Development Environment

### Desktop App
```bash
cd desktop
npm install
npm start
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Main Loop (ESP32/.ino)                 │
│  Serial/WiFi → JSON Parse → State Update → Render   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              Desktop App (Electron)                 │
│  HTTP Server (19280) → Multi-Window Manager         │
│        ↓                      ↓                     │
│  System Tray ←── IPC ──→ Multiple Windows (canvas)  │
└─────────────────────────────────────────────────────┘
```

### Key Files
- **ESP32**: `esp32.ino` (main orchestrator), `config.h` (constants), `TFT_Compat.h` (LovyanGFX wrapper, defines `TFT_eSPI`/`TFT_eSprite` aliases), `LGFX_ESP32C6.hpp` (dual-board display driver, `configure(boardType)` called before `init()`), `sprites.h` (rendering), `img_clawd.h`/`img_codex.h`/`img_kiro.h`/`img_claw.h` (per-character 128×128 RGB565 bitmaps used by `sprites.h`), `ui_elements.h` (status text, icons), `state.h` (globals, timers, `g_boardType`), `display.h` (screen drawing), `project_lock.h` (lock logic), `input.h` (JSON parsing), `wifi_manager.h` (WiFi/HTTP/WebSocket), `wifi_portal.h` (captive portal HTML), `credentials.h.example` (WiFi/WebSocket/board config template → copy to `credentials.h`)
- **Desktop**: `main.js` (entry point), `modules/*.cjs` (http-server, http-utils, multi-window-manager, state-manager, tray-manager, validators, ws-client), `renderer.js` + `index.html` (renderer)
- **Shared**: `desktop/shared/` folder (config, constants)
- **Config Data**: `desktop/shared/data/constants.json` (single source of truth - window dimensions, animation settings, limits)
- **Tools**: `tools/png_to_rgb565.py` (PNG → ESP32 `img_*.h` RGB565 header; magenta `0xF81F` = transparent), `tools/rgb565_to_png.py` (reverse, regenerates `images/img_*.png`)
- **Documentation**: `README.md`, `CLAUDE.md`, `docs/*`, `desktop/README.md` (npm package)

## Key Patterns

- **State-based rendering**: `state` → color, eyeType, text
- **Animation**: `animFrame % N` approach (100ms tick)
- **Floating**: Cosine/Sine wave offset (X: ±3px, Y: ±5px, ~3.2s cycle)
- **Working text**: Tool-based fixed text via `getWorkingText(tool)` (Bash→Running, Read→Reading, Edit→Editing, Write→Writing, Grep/WebSearch→Searching, Glob→Scanning, WebFetch→Fetching, Task→Tasking, default→Working)
- **JSON fields**: `{"state", "tool", "project", "model", "memory", "usage5h", "usageWeek", "character"}` (Desktop adds `"terminalId"` for click-to-focus)
- **Characters**: `clawd` (orange), `codex` (green), `kiro` (white ghost), `claw` (red)
- **Metric rows**: memory (🧠), 5h usage (⏱️), weekly usage (📅) each render as a single line `[icon] [bar] [NN%]` at the bottom; `usage5h`/`usageWeek` are plan-usage % (0-100) from statusline's `usage.json`
- **Memory hidden on start**: Memory not displayed during `start` state
- **Project change resets**: Model/memory cleared when project changes (usage is account-global, not reset)
- **Sparkle effect (start, working)**: Animated 4-point star sparkle
- **Sunglasses (working)**: Dark green sunglasses with frame and shine (EYE_FOCUSED)
- **Loading dots speed**: Thinking/planning/packing states use 3x slower animation than working state
- **Snap to corner**: Window snaps to screen corners when dragged within 30px of edges (150ms debounce)
- **Window close timer**: Desktop window auto-closes after 10min in sleep state; reopens on new status
- **Click to focus terminal**: Click window to switch to corresponding iTerm2 or Ghostty tab (macOS only, uses `terminalId` from `ITERM_SESSION_ID` or `GHOSTTY_PID`)
- **Open at Login**: Configurable via system tray menu; uses Electron `app.setLoginItemSettings()` to auto-start on macOS login
- **Alert light (ESP32)**: Optional GPIO output for physical alert light; define `ALERT_PIN` in `credentials.h` to enable; HIGH during `alert` state, LOW otherwise; use GPIO2 (safe for both boards) — GPIO4 conflicts with 1.9" board MOSI
- **Board selection**: Set `#define BOARD_TYPE BOARD_1_9` or `BOARD_1_47` in `credentials.h`; configures SPI pins, panel offset, and backlight at compile time; 1.9" backlight is GPIO15 direct (active-low: LOW=on, HIGH=off); 1.47" backlight is GPIO22 PWM
- **State-based always on top**: Active states (thinking, planning, working, packing, notification, alert) keep window on top; inactive states (start, idle, done, sleep) disable always on top to reduce screen obstruction
- **Always on Top Modes**: `active-only` (default), `all`, `disabled` - configurable via system tray menu
- **Always on Top**: Active states enable on top immediately; inactive states disable on top immediately (no grace period, prevents focus stealing)

## Window Mode

Two modes available (`multi` or `single`):
- **Multi mode** (default): Each project gets own window (max 5)
- **Single mode**: One window, reused for each project; supports project lock

### Multi-Window Mode
- Windows arranged by state and name: active states (right) → inactive states (left), sorted by name descending (Z first = rightmost) within each group
- Max 5 windows (or screen limit)
- Auto-rearranges when state changes or window closes
- 10px gap between windows
- System tray shows up to 10 projects in menu

### API Endpoints

| Endpoint | Platform | Description |
|----------|----------|-------------|
| `POST /status` | All | Create/update window for project |
| `GET /status` | All | Returns current state |
| `GET /health` | All | Health check |
| `POST /lock` | All | Lock to project |
| `POST /unlock` | All | Unlock project |
| `GET /lock-mode` | All | Get current lock mode |
| `POST /lock-mode` | All | Set lock mode |
| `GET /windows` | Desktop | List all active windows |
| `POST /close` | Desktop | Close specific project window |
| `POST /show` | Desktop | Show window |
| `GET /window-mode` | Desktop | Get current window mode (multi/single) |
| `POST /window-mode` | Desktop | Set window mode |
| `GET /debug` | Desktop | Window/display debug info |
| `GET /` | Desktop | Dashboard HTML page |
| `GET /dashboard-data` | Desktop | Dashboard data (windows, modes, lock) |
| `GET /stats` | Desktop | Stats dashboard page |
| `GET /stats/data` | Desktop | Stats data from cache |
| `POST /quit` | Desktop | Quit application |
| `POST /reboot` | ESP32 | Reboot device |
| `POST /wifi-reset` | ESP32 | Clear WiFi credentials, enter provisioning mode |

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

# ESP32 Serial (macOS)
echo '{"state":"working","tool":"Bash","project":"my-project"}' > /dev/cu.usbmodem1101

# ESP32 Serial (Raspberry Pi / Linux)
stty -F /dev/ttyACM0 115200  # Set baud rate first (required)
echo '{"state":"working","tool":"Bash","project":"my-project"}' > /dev/ttyACM0
```

## Important Notes

- ESP32: Uses LovyanGFX library with `LGFX_ESP32C6.hpp` configuration (TFT_eSPI not required)
- JSON payload must end with LF (`\n`)
- WiFi mode: Create `credentials.h` from example (WiFi and WebSocket are enabled by default)
