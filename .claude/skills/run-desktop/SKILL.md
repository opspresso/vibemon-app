---
name: run-desktop
description: Run and drive the VibeMon Electron app — launch it, put a character on screen, switch between the 2D and 3D engines, and screenshot the window. Use when asked to start the app, take a screenshot of it, check a rendering change in the real app, or interact with its windows.
---

VibeMon is a tray-only Electron app: `pnpm start` shows no window, because the
character window is created on demand by a `POST /status` to its local HTTP
server. For automated regression checks, use `pnpm test:overlays` and the isolated
monitoring fixture in `tests/native/monitoring-smoke.cjs`. For interactive
agent verification, use the UI tools provided by the current session.
The optional `driver.mjs` is a manual CDP utility; do not use it when session
instructions require the provided computer-use tools.

The manual driver isolates the Electron store with `--user-data-dir`. It
launches the full application, which still manages `~/.vibemon/config.json`
and refreshes local provider usage. Use the native fixtures when shared hook
configuration must remain untouched.

## Optional manual driver

One shot: pass the commands as arguments. They run in order, the app is closed
at the end, and the exit code is non-zero if any command failed.

```bash
node .claude/skills/run-desktop/driver.mjs \
  "launch 3d" "lock codex" "status working" "engine" "ss codex-3d" "logs"
```

Then **open the PNG and look at it.** Screenshots land in `/tmp/vibemon-shots/`
(override with `SCREENSHOT_DIR`).

Run it with no arguments for an interactive `driver>` REPL instead (same
commands, `quit` to exit).

The real app must not be running — it owns port 19280, and `launch` fails fast
with a clear error if the port is taken.

### Commands

| command | what it does |
|---|---|
| `launch [2d\|3d]` | seed the render mode, boot the app, wait for its HTTP server |
| `status <state> [character] [project]` | `POST /status` → creates/updates the character window, waits for it |
| `lock <character\|auto>` | `POST /character-lock` — pins the character against other bridges |
| `focus` | what the window is *actually* showing (focused project / character / state) |
| `ss [name]` | screenshot over an opaque backdrop, prints `focus` alongside |
| `ss-raw [name]` | screenshot the true transparent frame |
| `engine` | which engine booted: `vibemon-canvas` (2D) vs `vibemon-canvas-3d` (WebGL) |
| `page <character\|bubble>` | retarget commands at the character window or the speech bubble |
| `windows` | list open windows |
| `eval <js>` / `text [sel]` | evaluate in the page / dump innerText |
| `wait <ms>` | pause the sequence (e.g. to let an animation settle) |
| `logs` | renderer console, uncaught errors, CSP violations, and main-process output since launch |
| `quit` | close the app (implicit at the end of a one-shot run) |

States: `start`, `idle`, `thinking`, `planning`, `working`, `packing`,
`notification`, `done`, `sleep`, `alert`. Characters: `vibemon`, `clawd`,
`codex`, `kiro`, `claw`, `daangni`.

## Run (human path)

```bash
pnpm start    # tray icon only; POST a status to see the character window
curl -X POST http://127.0.0.1:19280/status -H 'Content-Type: application/json' \
  -d '{"state":"working","character":"codex","project":"manual"}'
```

## Gotchas

- **Launching gives you no window.** The dock icon is hidden and the character
  window is created by `POST /status` (port 19280). `launch` alone proves only
  that the main process booted — always follow it with `status`.

- **Another VibeMon bridge will steal the window.** A developer machine
  usually has the Claude Code hook posting real statuses to the same port, so
  the window follows *their* project, not yours — the `/status` reply then
  says `"skipped": true`. Two defenses, use both: `lock <character>` pins the
  character regardless of which project has focus, and `ss` prints `focus`
  next to every screenshot so an image that surprises you is explainable
  rather than mysterious.

- **The preload buffers initial state.** The first status reaches late renderer
  subscribers after image loading. The driver waits for engine readiness and
  does not resend synthetic states to hide initialization failures.

- **Render mode is persisted state, not a flag.** It lives in electron-store
  (`<userData>/config.json`), read when the character window is created.
  `launch` seeds it before boot; switching modes means `quit` then
  `launch <mode>`.

- **The window is transparent and frameless.** A raw screenshot is hard to
  read against a dark reviewer background, so `ss` injects an opaque backdrop
  and reverts it. Use `ss-raw` when the transparency itself is what you're
  checking.

- **Screenshots are in device pixels.** On a retina display the PNG is 2x the
  window's logical size (e.g. 268x276 for a 134x138 window).

## Troubleshooting

- **`launch` fails with "port 19280 is already in use"** — the real app (or a
  previous driver run) still holds it: `lsof -nP -iTCP:19280 -sTCP:LISTEN`
  and identify its owner. Stop only a test instance you launched; preserve the
  real app and unrelated processes.
- **`status` times out waiting for the character window** — check `logs`; a
  renderer crash (bad vendored engine, CSP violation) shows up there.
- **3D shows the default purple monster for every character** — the registry
  entry lost its `theme`; check `src/shared/data/characters.json` and re-sync
  with `pnpm check:registry -- --fix`.
