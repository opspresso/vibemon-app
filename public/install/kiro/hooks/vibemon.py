#!/usr/bin/env python3
"""
VibeMon Hook for Kiro IDE
Desktop App + ESP32 (USB Serial / HTTP)
Shared transport lives in vibemon_core.py (~/.vibemon/vibemon_core.py).
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

# Locate vibemon_core.py: repo checkout first (public/install/vibemon/), then the
# installed copy (~/.vibemon/).
for _core_dir in (
    Path(__file__).resolve().parent.parent.parent / "vibemon",
    Path.home() / ".vibemon",
):
    if (_core_dir / "vibemon_core.py").is_file():
        sys.path.insert(0, str(_core_dir))
        break

try:
    import vibemon_core as core
except ImportError:
    print(
        "[vibemon] vibemon_core.py not found — re-run the installer: "
        "curl -fsSL https://vibemon.io/install/install.py | python3",
        file=sys.stderr,
    )
    sys.exit(0)

# Character configuration
CHARACTER = "kiro"

# Event to state mapping (immutable)
EVENT_STATE_MAP: dict[str, str] = {
    "SessionStart": "start",
    "UserPromptSubmit": "thinking",
    "PreToolUse": "working",
    "PostToolUse": "thinking",
    "Stop": "done",
    "SessionEnd": "done",
}

# Kiro's v1 config uses PascalCase trigger names while hook payloads currently
# use lower camel case. Legacy names remain aliases for in-flight upgrades.
EVENT_ALIASES: dict[str, str] = {
    "sessionStart": "SessionStart",
    "agentSpawn": "SessionStart",
    "userPromptSubmit": "UserPromptSubmit",
    "promptSubmit": "UserPromptSubmit",
    "preToolUse": "PreToolUse",
    "postToolUse": "PostToolUse",
    "stop": "Stop",
    "agentStop": "Stop",
    "sessionEnd": "SessionEnd",
}


def locate_transcript(data: dict[str, Any]) -> str:
    """Return the Kiro CLI V3 session record, or "" when none exists.

    V3 writes ~/.kiro/sessions/<workspace>/<session_id>/messages.jsonl and
    records turn_end there when the user cancels a turn, which runs no hook.
    """
    session = data.get("session_id")
    if not isinstance(session, str) or not re.fullmatch(r"sess_[0-9A-Za-z-]+", session):
        return ""
    home = Path(os.environ.get("KIRO_HOME") or Path.home() / ".kiro")
    matches = sorted((home / "sessions").glob(f"*/{session}/messages.jsonl"))
    return str(matches[0]) if matches else ""


def build_payload(
    state: str, tool: str, project: str, data: dict[str, Any]
) -> dict[str, Any]:
    """Build payload dict for sending to monitor. Kiro has no statusline
    cache, so model/memory are not reported."""
    return {
        "state": state,
        "tool": tool,
        "project": project,
        "model": "",
        "character": CHARACTER,
        "terminalId": core.get_terminal_id(),
    }


if __name__ == "__main__":
    core.run(
        event_state_map=EVENT_STATE_MAP,
        build_payload=build_payload,
        start_event="SessionStart",
        argv_event_fallback=True,
        event_aliases=EVENT_ALIASES,
        locate_transcript=locate_transcript,
    )
    sys.exit(0)
