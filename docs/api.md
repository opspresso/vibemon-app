# HTTP API Reference

Default port: `19280`

> For the ESP32 device API, see [vibemon-esp32](https://github.com/opspresso/vibemon-esp32).

## Security & Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Payload size | 10KB | Maximum request body size |
| Rate limit | 600 req/min | Per IP address |
| Request timeout | 30 sec | Prevents Slowloris attacks |
| Browser origin | localhost only | Requests with a non-local browser `Origin` are rejected |
| Content type | `application/json` | Required for JSON mutation endpoints |

### Input Validation

| Field | Max Length | Format |
|-------|------------|--------|
| `state` | - | One of valid states |
| `project` | 128 chars | String |
| `tool` | 64 chars | String |
| `model` | 64 chars | String |
| `memory` | - | Integer 0-100 (context-window usage) |
| `usage5h` | - | Integer 0-100 (5-hour plan-usage window) |
| `usageWeek` | - | Integer 0-100 (weekly plan-usage window) |
| `usage5hResetsIn` | - | Non-negative integer (minutes until the 5-hour window resets) |
| `usageWeekResetsIn` | - | Non-negative integer (minutes until the weekly window resets) |
| `usageWeekModel` | - | Integer 0-100 (model-scoped weekly plan-usage window, e.g. the Fable bucket) |
| `usageWeekModelResetsIn` | - | Non-negative integer (minutes until the model-scoped weekly window resets) |
| `usageWeekModelLabel` | 64 chars | Display label for the model-scoped weekly window (e.g. `Fable`) |
| `character` | - | `vibemon`, `clawd`, `codex`, `kiro`, `claw`, or `daangni` (unknown names fall back to `vibemon`) |
| `terminalId` | 100 chars | Terminal session ID with prefix: `iterm2:w0t0p0:UUID` (from `ITERM_SESSION_ID`) or `ghostty:12345` (from `GHOSTTY_PID`) |

> `character` is a visual rendering choice, typically selected by the agent bridge. It is not a general agent identity field.

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| GET / | Dashboard HTML page |
| GET /dashboard-data | Dashboard data (focused project, character lock, tracked projects) |
| POST/GET /status | Update / get status |
| POST /close | Close the character window |
| POST /show | Show the character window |
| GET /health | Health check |
| GET /debug | Window/display debug info |
| POST /quit | Quit application |
| GET/POST /character-lock | Get / set character lock |

## Status

### POST /status

Update a project's status. The character window follows one "focused"
project at a time: a project in an active state (thinking, planning,
working, packing, notification, alert) takes focus; otherwise the most
recently updated project keeps it. Updates for unfocused projects are still
recorded and become visible when that project gains focus.

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
| `usage5hResetsIn` | number | Minutes until the 5-hour window resets |
| `usageWeekResetsIn` | number | Minutes until the weekly window resets |
| `usageWeekModel` | number | Model-scoped weekly plan-usage window (0-100), e.g. the Fable bucket |
| `usageWeekModelResetsIn` | number | Minutes until the model-scoped weekly window resets |
| `usageWeekModelLabel` | string | Display label for the model-scoped weekly window (e.g. `Fable`) |
| `character` | string | `vibemon`, `clawd`, `codex`, `kiro`, `claw`, or `daangni` |
| `terminalId` | string | Terminal ID for click-to-focus (e.g., `iterm2:w0t0p0:UUID` or `ghostty:12345`) |

> An unrecognized `state` value is rejected with a `400` error.

Agent bridges usually set `character` automatically:
- `clawd` for Claude Code
- `codex` for Codex CLI
- `kiro` for Kiro
- `claw` for OpenClaw
- bridges without their own character fall back to `vibemon`

**Response:**
```json
{"success": true, "project": "my-project", "state": "working", "focusedProject": "my-project"}
```

> `skipped: true` is added when the update didn't change the visible window —
> either because neither `state` nor the info fields (`tool`, `model`,
> `memory`, `usage5h`, `usageWeek`, `usage5hResetsIn`, `usageWeekResetsIn`,
> `usageWeekModel`, `usageWeekModelResetsIn`, `usageWeekModelLabel`,
> `character`, `terminalId`) changed, or because another project currently
> holds focus (the update is still recorded).

### GET /status

Get every tracked project's latest state, plus which one the character
window currently follows.

```bash
curl http://127.0.0.1:19280/status
```

**Response:**
```json
{
  "focusedProject": "my-project",
  "projects": {
    "my-project": {"state": "working", "tool": "Bash", "model": "opus", "memory": 45, "usage5h": 36, "usageWeek": 37},
    "other-project": {"state": "idle"}
  }
}
```

---

## Window Management

### POST /close

Close the character window (only succeeds when it currently follows the
given project). It reappears on the next status update.

```bash
curl -X POST http://127.0.0.1:19280/close \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'
```

**Response:**
```json
{"success": true, "project": "my-project"}
```

### POST /show

Show the character window.

```bash
# Show the window regardless of which project it follows
curl -X POST http://127.0.0.1:19280/show

# Show only if it follows a specific project
curl -X POST http://127.0.0.1:19280/show \
  -H "Content-Type: application/json" \
  -d '{"project":"my-project"}'
```

**Request Body (optional):**

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | Project the window must follow (defaults to whichever it follows) |

**Response:**
```json
{"success": true, "project": "my-project"}
```

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

Force the window to show one character regardless of what each project's
status reports (`auto`, or one of `vibemon`, `clawd`, `codex`, `kiro`, `claw`,
`daangni`). `auto` restores each project's own character on its next status
update.

```bash
curl -X POST http://127.0.0.1:19280/character-lock \
  -H "Content-Type: application/json" \
  -d '{"character":"daangni"}'
```

**Response:**
```json
{"success": true, "character": "daangni"}
```

> On an invalid `character`, the response is `{"success": false, "error": "Invalid character: <character>", "validCharacters": ["auto", "vibemon", "clawd", "codex", "kiro", "claw", "daangni"]}`.

---

## Dashboard

### GET /

Serve the dashboard HTML page showing tracked projects and the focused one.

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
  "version": "2.4.1",
  "focusedProject": "my-project",
  "characterLock": "auto",
  "projects": [
    {"project": "my-project", "state": "working", "focused": true},
    {"project": "other-project", "state": "idle", "focused": false}
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
  "window": {"projectId": "my-project", "bounds": {...}, "state": "working"},
  "focusedProjectId": "my-project",
  "trackedProjects": ["my-project", "other-project"],
  "alwaysOnTopMode": "all",
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
| `403` | Browser origin is not localhost |
| `404` | Not found |
| `408` | Request timeout |
| `413` | Payload too large (>10KB) |
| `415` | JSON endpoint called without `application/json` |
| `429` | Too many requests (rate limited) |
| `500` | Internal server error |

### Error Response Format

```json
{"error": "Error message description"}
```

> Routes not matching any known endpoint return a plain-text `404 Not Found` body, not JSON.
