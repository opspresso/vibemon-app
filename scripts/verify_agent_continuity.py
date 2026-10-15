#!/usr/bin/env python3
"""Verify, with a real coding agent, that a turn stays active from prompt to end.

The agent runs one prompt with a 75-second command, which is longer than one
heartbeat interval. A local display records every report. The check passes
when the reports start active, have no silent gap longer than a heartbeat plus
one watcher tick, and end with ``done``.

Usage:
    python3 scripts/verify_agent_continuity.py claude
    python3 scripts/verify_agent_continuity.py codex
    python3 scripts/verify_agent_continuity.py opencode

Requirements:
- The agent CLI is installed and signed in. The run uses the account's quota.
- claude: only the repository hook runs, through ``--settings``.
- codex: Codex runs only hooks it trusts, so the run uses the installed hook
  (``~/.codex/hooks/vibemon.py``). Install the current version first.
- opencode: the run uses the installed plugin and adapter
  (``~/.config/opencode/plugins/vibemon.js``). Install the current version first.

Reports go only to the local display: the run overrides delivery targets and
the session cache through ``VIBEMON_*`` environment variables. Hooks that are
also installed for the user receive the same overrides, so a state can appear
more than once.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "install" / "vibemon"))
from session_activity import ACTIVE_STATES, HEARTBEAT_MS, WATCH_TICK_SECONDS  # noqa: E402

AGENTS = ("claude", "codex", "opencode")
SLEEP_SECONDS = 75
MAX_GAP_SECONDS = HEARTBEAT_MS / 1000 + WATCH_TICK_SECONDS + 5
PROMPT = (
    f'Run this exact shell command once and wait for it: python3 -c "import time; time.sleep({SLEEP_SECONDS})". '
    "Then reply with the single word: finished."
)


def serve(received: list[tuple[float, str, bool]]) -> ThreadingHTTPServer:
    started = time.monotonic()

    class Display(BaseHTTPRequestHandler):
        def do_POST(self):
            report = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append((time.monotonic() - started, report.get("state"), bool(report.get("heartbeat"))))
            print(f"{received[-1][0]:6.1f}s  {report.get('state')}{'  (heartbeat)' if report.get('heartbeat') else ''}", flush=True)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Display)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def command(agent: str, work: Path) -> list[str]:
    if agent == "claude":
        hook = f"python3 {ROOT / 'public' / 'install' / 'claude' / 'hooks' / 'vibemon.py'}"
        events = json.loads((ROOT / "public" / "install" / "claude" / "settings.json").read_text())["hooks"]
        settings = work / "settings.json"
        settings.write_text(json.dumps({"hooks": {
            event: [{"hooks": [{"type": "command", "command": hook, "async": True, "timeout": 10}]}] for event in events
        }}))
        # Only the repository hook runs: user and project settings stay unloaded.
        return ["claude", "-p", PROMPT, "--setting-sources", "local", "--settings", str(settings), "--allowedTools", "Bash(python3:*)"]
    if agent == "codex":
        warn_if_changed(Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "hooks" / "vibemon.py", "codex/hooks/vibemon.py")
        return ["codex", "exec", "--skip-git-repo-check", "-s", "workspace-write", PROMPT]
    home = Path(os.environ.get("OPENCODE_CONFIG_DIR", Path.home() / ".config" / "opencode"))
    warn_if_changed(home / "plugins" / "vibemon.js", "opencode/plugin/vibemon.js")
    warn_if_changed(home / "hooks" / "vibemon.py", "opencode/hooks/vibemon.py")
    return ["opencode", "run", PROMPT]


def warn_if_changed(installed: Path, source: str) -> None:
    if not installed.is_file() or installed.read_bytes() != (ROOT / "public" / "install" / source).read_bytes():
        print(f"warning: {installed} differs from public/install/{source}", file=sys.stderr)


def verdict(received: list[tuple[float, str, bool]]) -> list[str]:
    """Return the continuity failures in the received reports."""
    states = [state for _, state, _ in received]
    first = next((index for index, state in enumerate(states) if state in ACTIVE_STATES), None)
    if first is None:
        return ["no active state was reported"]
    failures = []
    if states[-1] != "done":
        failures.append(f"the last report is {states[-1]!r}, not 'done'")
    if not any(heartbeat for _, _, heartbeat in received):
        failures.append("no heartbeat arrived during the silent command")
    times = [at for at, _, _ in received[first:]]
    gaps = [later - earlier for earlier, later in zip(times, times[1:])]
    if gaps and max(gaps) > MAX_GAP_SECONDS:
        failures.append(f"a {max(gaps):.0f}-second gap exceeds {MAX_GAP_SECONDS:.0f} seconds")
    return failures


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in AGENTS:
        print(__doc__.split("Requirements:")[0].strip(), file=sys.stderr)
        return 2
    agent = sys.argv[1]
    received: list[tuple[float, str, bool]] = []
    server = serve(received)
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        environment = {
            # An inherited Claude Code session would mark the agent as a child session.
            **{key: value for key, value in os.environ.items() if key != "CLAUDECODE" and not key.startswith("CLAUDE_CODE_")},
            "VIBEMON_HTTP_URLS": f"http://127.0.0.1:{server.server_port}",
            "VIBEMON_CACHE_PATH": str(work / "projects.json"),
            "VIBEMON_URL": "", "VIBEMON_TOKEN": "", "VIBEMON_SERIAL_PORT": "",
            "VIBEMON_AUTO_LAUNCH": "0", "VIBEMON_SUPPRESS_HOOKS": "0",
        }
        result = subprocess.run(command(agent, work), cwd=work, env=environment, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=SLEEP_SECONDS + 240)
        # Asynchronous hooks may report shortly after the agent exits.
        time.sleep(WATCH_TICK_SECONDS + 5)
    server.shutdown()
    if result.returncode != 0:
        print(f"{agent} exited with {result.returncode}:\n{result.stdout[-2000:]}{result.stderr[-2000:]}", file=sys.stderr)
        return 1
    failures = verdict(received)
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    if not failures:
        print(f"PASS: {agent} stayed active from prompt to done")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
