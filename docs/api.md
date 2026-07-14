# HTTP API Reference

Default port: `19280`

> For the ESP32 device API, see [vibemon-esp32](https://github.com/opspresso/vibemon-esp32).

## Security & Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Payload size | 10KB | Maximum request body size |
| Rate limit | 100 req/min | Per IP address |
| Request timeout | 30 sec | Prevents Slowloris attacks |
| CORS | localhost only | Only allows localhost origins |

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
| `character` | - | `clawd`, `codex`, `kiro`, `claw`, or `daangni` |
| `terminalId` | 100 chars | Terminal session ID with prefix: `iterm2:w0t0p0:UUID` (from `ITERM_SESSION_ID`) or `ghostty:12345` (from `GHOSTTY_PID`) |

> `character` is a visual rendering choice, typically selected by the agent bridge. It is not a general agent identity field.

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| GET / | Dashboard HTML page |
| GET /dashboard-data | Dashboard data (windows, modes, lock) |
| POST/GET /status | Update / get status |
| GET /windows | List all active windows |
| POST /close | Close specific project window |
| POST /show | Show window |
| GET /health | Health check |
| GET /debug | Window/display debug info |
| POST /quit | Quit application |
| POST /lock | Lock to project |
| POST /unlock | Unlock project |
| GET/POST /lock-mode | Get / set lock mode |
| GET/POST /window-mode | Get / set window mode sub-mode |
| GET/POST /app-mode | Get / set app mode |
| GET/POST /character-lock | Get / set character lock |

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
| `character` | string | `clawd`, `codex`, `kiro`, `claw`, or `daangni` |
| `terminalId` | string | Terminal ID for click-to-focus (e.g., `iterm2:w0t0p0:UUID` or `ghostty:12345`) |

> An unrecognized `state` value is rejected with a `400` error.

Agent bridges usually set `character` automatically:
- `clawd` for Claude Code
- `codex` for Codex
- `kiro` for Kiro
- `claw` for OpenClaw

**Response:**
```json
{"success": true, "project": "my-project", "state": "working", "windowCount": 2}
```

> `skipped: true` is added when neither `state` nor the info fields (`tool`, `model`, `memory`, `usage5h`, `usageWeek`, `character`) changed (optimization). If a project is blocked (project locked or max windows), `success` is `false` with an `error` field, plus `lockedProject` (blocked by lock) or `windowCount` (max windows reached).

### GET /status

Get current status.

```bash
curl http://127.0.0.1:19280/status
```

**Response:**
```json
{
  "windowCount": 2,
  "projects": {
    "my-project": {"state": "working", "tool": "Bash", "model": "opus", "memory": 45, "usage5h": 36, "usageWeek": 37},
    "other-project": {"state": "idle"}
  }
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

### POST /show

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

### GET /window-mode

Get current window mode.

```bash
curl http://127.0.0.1:19280/window-mode
```

**Response:**
```json
{"mode": "multi", "windowCount": 2, "lockedProject": null}
```

### POST /window-mode

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

### GET /app-mode

Get current app mode.

```bash
curl http://127.0.0.1:19280/app-mode
```

**Response:**
```json
{"mode": "window", "windowCount": 2}
```

### POST /app-mode

Set app mode (`character`, `window`, or `input`).

```bash
curl -X POST http://127.0.0.1:19280/app-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"character"}'
```

**Response:**
```json
{"success": true, "mode": "character", "windowCount": 1}
```

> On an invalid `mode`, the response is `{"success": false, "error": "Invalid mode: <mode>", "validModes": ["character", "window", "input"]}`.

### GET /character-lock

Get current character lock.

```bash
curl http://127.0.0.1:19280/character-lock
```

**Response:**
```json
{"character": "auto"}
```

### POST /character-lock

Force every window to show one character regardless of what each project's status reports (`auto`, or one of `clawd`, `codex`, `kiro`, `claw`, `daangni`). `auto` restores each project's own character on its next status update.

```bash
curl -X POST http://127.0.0.1:19280/character-lock \
  -H "Content-Type: application/json" \
  -d '{"character":"daangni"}'
```

**Response:**
```json
{"success": true, "character": "daangni"}
```

> On an invalid `character`, the response is `{"success": false, "error": "Invalid character: <character>", "validCharacters": ["auto", "clawd", "codex", "kiro", "claw", "daangni"]}`.

---

## Project Lock

### POST /lock

Lock to a specific project.

```bash
curl -X POST http://127.0.0.1:19280/lock \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'
```

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | Project name to lock |

**Response:**
```json
{"success": true, "lockedProject": "my-project"}
```

> Only works in single-window mode. Returns `{"success": false, "error": "Lock only available in single-window mode"}` in multi-window mode. If the locked project has no active window, the response includes `"warning": "No active window for this project"`.

### POST /unlock

Unlock project.

```bash
curl -X POST http://127.0.0.1:19280/unlock
```

**Response:**
```json
{"success": true, "lockedProject": null}
```

> Only works in single-window mode. Returns `{"success": false, "error": "Unlock only available in single-window mode"}` in multi-window mode.

### GET /lock-mode

Get current lock mode.

```bash
curl http://127.0.0.1:19280/lock-mode
```

**Response:**
```json
{
  "mode": "on-thinking",
  "modes": {"first-project": "First Project", "on-thinking": "On Thinking"},
  "lockedProject": null,
  "windowMode": "single"
}
```

### POST /lock-mode

Set lock mode (`first-project` or `on-thinking`).

```bash
curl -X POST http://127.0.0.1:19280/lock-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"first-project"}'
```

**Response:**
```json
{"success": true, "mode": "first-project", "lockedProject": null}
```

> On an invalid `mode`, the response is `{"success": false, "error": "Invalid mode: <mode>", "validModes": [...]}` listing the accepted mode keys.

---

## Dashboard

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

### GET /debug

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

### POST /quit

Quit the application.

```bash
curl -X POST http://127.0.0.1:19280/quit
```

---

## HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Bad request (validation error) |
| `404` | Not found |
| `408` | Request timeout |
| `413` | Payload too large (>10KB) |
| `429` | Too many requests (rate limited) |
| `500` | Internal server error |

### Error Response Format

```json
{"error": "Error message description"}
```

> Routes not matching any known endpoint return a plain-text `404 Not Found` body, not JSON.
