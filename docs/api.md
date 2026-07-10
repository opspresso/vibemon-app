# HTTP API Reference

Default port: Desktop App `19280`, ESP32 WiFi `80`

## Security & Limits (Desktop only)

| Limit | Value | Description |
|-------|-------|-------------|
| Payload size | 10KB | Maximum request body size |
| Rate limit | 100 req/min | Per IP address |
| Request timeout | 30 sec | Prevents Slowloris attacks |
| CORS | localhost only | Only allows localhost origins |

> **Note:** ESP32 HTTP server does not enforce these limits. ESP32 security relies on local network isolation and SSID sanitization.

### Input Validation

| Field | Max Length | Format |
|-------|------------|--------|
| `state` | - | One of valid states |
| `project` | 100 chars | String |
| `tool` | 50 chars | String |
| `model` | 50 chars | String |
| `memory` | - | Integer 0-100 (context-window usage) |
| `usage5h` | - | Integer 0-100 (5-hour plan-usage window) |
| `usageWeek` | - | Integer 0-100 (weekly plan-usage window) |
| `character` | - | `clawd`, `codex`, `kiro`, or `claw` |
| `terminalId` | 100 chars | Desktop only. Terminal session ID with prefix: `iterm2:w0t0p0:UUID` (from `ITERM_SESSION_ID`) or `ghostty:12345` (from `GHOSTTY_PID`) |

> `character` is a visual rendering choice, typically selected by the agent bridge. It is not a general agent identity field.

---

## Platform Support

| Endpoint | Desktop | ESP32 WiFi |
|----------|---------|------------|
| GET / | ✓ | - |
| GET /dashboard-data | ✓ | - |
| POST/GET /status | ✓ | ✓ |
| GET /windows | ✓ | - |
| POST /close | ✓ | - |
| POST /show | ✓ | - |
| GET /health | ✓ | ✓ |
| GET /debug | ✓ | - |
| POST /quit | ✓ | - |
| POST /lock | ✓ | ✓ |
| POST /unlock | ✓ | ✓ |
| GET/POST /lock-mode | ✓ | ✓ |
| GET/POST /window-mode | ✓ | - |
| GET /stats | ✓ | - |
| GET /stats/data | ✓ | - |
| POST /reboot | - | ✓ |
| POST /wifi-reset | - | ✓ |

## Status

### POST /status

Update monitor status.

```bash
curl -X POST http://127.0.0.1:19280/status \
  -H "Content-Type: application/json" \
  -d '{"state":"working","tool":"Bash","project":"my-project"}'
```

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | `start`, `idle`, `thinking`, `planning`, `working`, `packing`, `notification`, `done`, `sleep`, `alert` |
| `tool` | string | Tool name (e.g., `Bash`, `Read`, `Edit`) |
| `project` | string | Project name |
| `model` | string | Model name (e.g., `opus`, `sonnet`) |
| `memory` | number | Context-window usage (0-100) |
| `usage5h` | number | 5-hour plan-usage window (0-100) |
| `usageWeek` | number | Weekly plan-usage window (0-100) |
| `character` | string | `clawd`, `codex`, `kiro`, or `claw` |
| `terminalId` | string | Desktop only. Terminal ID for click-to-focus (e.g., `iterm2:w0t0p0:UUID` or `ghostty:12345`) |

Agent bridges usually set `character` automatically:
- `clawd` for Claude Code
- `codex` for Codex
- `kiro` for Kiro
- `claw` for OpenClaw

**Response (Desktop):**
```json
{"success": true, "project": "my-project", "state": "working", "windowCount": 2}
```

> `skipped: true` is added when neither `state` nor the info fields (`tool`, `model`, `memory`, `usage5h`, `usageWeek`, `character`) changed (optimization). If a project is blocked (project locked or max windows), `success` is `false` with an `error` field, plus `lockedProject` (blocked by lock) or `windowCount` (max windows reached).

**Response (ESP32 WiFi):**
```json
{"success": true}
```

> If blocked by project lock: `{"success": false, "blocked": true}`

### GET /status

Get current status.

```bash
curl http://127.0.0.1:19280/status
```

**Response (Desktop):**
```json
{
  "windowCount": 2,
  "projects": {
    "my-project": {"state": "working", "tool": "Bash", "model": "opus", "memory": 45, "usage5h": 36, "usageWeek": 37},
    "other-project": {"state": "idle"}
  }
}
```

**Response (ESP32 WiFi):**
```json
{
  "state": "working",
  "project": "my-project",
  "lockedProject": "my-project",
  "lockMode": "on-thinking",
  "projectCount": 1
}
```

### GET /windows

List all active windows with their states and positions.

```bash
curl http://127.0.0.1:19280/windows
```

**Response:**
```json
{
  "windowCount": 2,
  "windows": [
    {"project": "my-project", "state": "working", "bounds": {"x": 1748, "y": 23, "width": 172, "height": 348}},
    {"project": "other-project", "state": "idle", "bounds": {"x": 1566, "y": 23, "width": 172, "height": 348}}
  ]
}
```

---

## Window Management

### POST /close

Close a specific project window.

```bash
curl -X POST http://127.0.0.1:19280/close \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'
```

**Response:**
```json
{"success": true, "project": "my-project", "windowCount": 1}
```

### POST /show (Desktop only)

Show window and position to top-right corner.

```bash
# Show first window
curl -X POST http://127.0.0.1:19280/show

# Show specific project window
curl -X POST http://127.0.0.1:19280/show \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'
```

**Request Body (optional):**

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | Project name to show (defaults to first window) |

**Response:**
```json
{"success": true, "project": "my-project"}
```

> When `project` is omitted, the response's `project` field is the literal string `"first"`, not the actual project ID of the shown window.

### GET /window-mode (Desktop only)

Get current window mode.

```bash
curl http://127.0.0.1:19280/window-mode
```

**Response:**
```json
{"mode": "multi", "windowCount": 2, "lockedProject": null}
```

### POST /window-mode (Desktop only)

Set window mode (`multi` or `single`).

```bash
curl -X POST http://127.0.0.1:19280/window-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"single"}'
```

**Response:**
```json
{"success": true, "mode": "single", "windowCount": 1, "lockedProject": null}
```

> On an invalid `mode`, the response is `{"success": false, "error": "Invalid mode: <mode>", "validModes": ["multi", "single"]}`.

---

## Project Lock

### POST /lock

Lock to a specific project.

```bash
# Desktop
curl -X POST http://127.0.0.1:19280/lock \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'

# ESP32
curl -X POST http://192.168.0.185/lock \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'
```

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | Project name to lock. Defaults to current project if omitted (ESP32 only). |

**Response:**
```json
{"success": true, "lockedProject": "my-project"}
```

> **Desktop:** Only works in single-window mode. Returns `{"success": false, "error": "Lock only available in single-window mode"}` in multi-window mode. If the locked project has no active window, the response includes `"warning": "No active window for this project"`.
>
> **ESP32:** Always available. When locking a new project, the display transitions to `idle` state and clears `tool`, `model`, `memory`.

### POST /unlock

Unlock project.

```bash
# Desktop
curl -X POST http://127.0.0.1:19280/unlock

# ESP32
curl -X POST http://192.168.0.185/unlock
```

**Response:**
```json
{"success": true, "lockedProject": null}
```

> **Desktop:** Only works in single-window mode. Returns `{"success": false, "error": "Unlock only available in single-window mode"}` in multi-window mode.

### GET /lock-mode

Get current lock mode.

```bash
# Desktop
curl http://127.0.0.1:19280/lock-mode

# ESP32
curl http://192.168.0.185/lock-mode
```

**Response (Desktop):**
```json
{
  "mode": "on-thinking",
  "modes": {"first-project": "First Project", "on-thinking": "On Thinking"},
  "lockedProject": null,
  "windowMode": "single"
}
```

**Response (ESP32 WiFi):**
```json
{
  "mode": "on-thinking",
  "modes": {"first-project": "First Project", "on-thinking": "On Thinking"},
  "lockedProject": null
}
```

> `windowMode` is Desktop-only (ESP32 has no window mode concept).

### POST /lock-mode

Set lock mode (`first-project` or `on-thinking`).

```bash
# Desktop
curl -X POST http://127.0.0.1:19280/lock-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"first-project"}'

# ESP32
curl -X POST http://192.168.0.185/lock-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"first-project"}'
```

**Response:**
```json
{"success": true, "mode": "first-project", "lockedProject": null}
```

> **ESP32:** Changing lock mode resets the current lock (`lockedProject` becomes null) and persists the new mode to Flash storage.
>
> On an invalid `mode`, the response is `{"success": false, "error": "Invalid mode: <mode>", "validModes": [...]}` listing the accepted mode keys.

---

## Dashboard (Desktop only)

### GET /

Serve the dashboard HTML page showing all active windows and current modes.

```bash
open http://127.0.0.1:19280/
```

### GET /dashboard-data

Get current dashboard data as JSON (used by the dashboard page).

```bash
curl http://127.0.0.1:19280/dashboard-data
```

**Response:**
```json
{
  "health": "ok",
  "windowCount": 2,
  "windowMode": "multi",
  "lockMode": "on-thinking",
  "lockedProject": null,
  "windows": [
    {"project": "my-project", "state": "working"},
    {"project": "other-project", "state": "idle"}
  ]
}
```

---

## Statistics (Desktop only)

### GET /stats

Serve the stats dashboard HTML page.

```bash
# Open in browser
open http://127.0.0.1:19280/stats
```

### GET /stats/data

Get stats data from `~/.claude/stats-cache.json`.

```bash
curl http://127.0.0.1:19280/stats/data
```

**Response:**
```json
{
  "sessions": [...],
  "totalTokens": 12345,
  "lastUpdated": "2026-01-29T12:00:00Z"
}
```

---

## System

### GET /health

Health check endpoint.

```bash
curl http://127.0.0.1:19280/health
```

**Response:**
```json
{"status": "ok"}
```

### GET /debug (Desktop only)

Get display and window debug information.

```bash
curl http://127.0.0.1:19280/debug
```

**Response:**
```json
{
  "primaryDisplay": {"bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080}, "workArea": {...}},
  "allDisplays": [...],
  "windows": [{"projectId": "my-project", "bounds": {...}, "state": "working"}],
  "windowCount": 1,
  "maxWindows": 5,
  "alwaysOnTopMode": "active-only",
  "platform": "darwin"
}
```

### POST /quit (Desktop only)

Quit the application.

```bash
curl -X POST http://127.0.0.1:19280/quit
```

### POST /reboot (ESP32 only)

Reboot the ESP32 device.

```bash
curl -X POST http://192.168.0.185/reboot \
  -H "Content-Type: application/json" \
  -d '{"confirm":true}'
```

**Response:**
```json
{"success": true, "rebooting": true}
```

### POST /wifi-reset (ESP32 only)

Clear saved WiFi credentials and return to provisioning mode.

```bash
curl -X POST http://192.168.0.185/wifi-reset \
  -H "Content-Type: application/json" \
  -d '{"confirm":true}'
```

**Response:**
```json
{"success": true, "message": "WiFi credentials cleared. Rebooting..."}
```

**Behavior:**
- Clears `wifiSSID`, `wifiPassword` from NVS (WebSocket token is preserved)
- Device reboots automatically
- Enters provisioning mode (creates `VibeMon-Setup` AP)

See [ESP32 Setup Guide](esp32-setup.md#reset-wifi-settings) for details.

---

## HTTP Status Codes

| Code | Desktop | ESP32 |
|------|---------|-------|
| `200` | Success | Success (also used for some errors — check `success` field) |
| `400` | Bad request (validation error) | Bad request (missing body or invalid input) |
| `404` | Not found | - |
| `408` | Request timeout | - |
| `413` | Payload too large (>10KB) | - |
| `429` | Too many requests (rate limited) | - |
| `500` | Internal server error | - |

> **ESP32 note:** The ESP32 HTTP server always returns HTTP 200 for valid requests (including project-lock rejections). Check the `success` field in the response body to determine the outcome.

### Error Response Format

```json
{"error": "Error message description"}
```

> **Desktop note:** Routes not matching any known endpoint return a plain-text `404 Not Found` body, not JSON.
