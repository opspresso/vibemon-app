#!/usr/bin/env python3
"""
VibeMon Hook for Kiro IDE and Kiro CLI
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
# installed copy (~/.vibemon/). An installed hook (~/.codex/hooks/) must not
# load a vibemon_core.py from an unrelated ~/vibemon or ~/.config/vibemon.
_checkout = Path(__file__).resolve().parent.parent.parent
for _core_dir in (
    *([_checkout / "vibemon"] if _checkout.parts[-2:] == ("public", "install") else []),
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
    """Return the Kiro CLI session record, or "" when none exists.

    A cancelled turn runs no hook, but both engines record it:
    - V3 writes ~/.kiro/sessions/<workspace>/<session_id>/messages.jsonl with turn_end.
    - V2 writes ~/.kiro/sessions/cli/<session_id>.jsonl with a cancellation message.
    """
    session = data.get("session_id")
    if not isinstance(session, str):
        return ""
    # Resolve KIRO_HOME as install.py's tool_home() does.
    configured = os.environ.get("KIRO_HOME", "").strip()
    sessions = (Path(configured).expanduser().resolve() if configured else Path.home() / ".kiro") / "sessions"
    if re.fullmatch(r"sess_[0-9A-Za-z-]+", session):
        matches = sorted(sessions.glob(f"*/{session}/messages.jsonl"))
        return str(matches[0]) if matches else ""
    if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", session):
        record = sessions / "cli" / f"{session}.jsonl"
        return str(record) if record.is_file() else ""
    return ""


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
        account_provider="kiro",
        profile_root=str(Path(__file__).resolve().parents[1]),
        event_state_map=EVENT_STATE_MAP,
        build_payload=build_payload,
        start_event="SessionStart",
        argv_event_fallback=True,
        event_aliases=EVENT_ALIASES,
        locate_transcript=locate_transcript,
    )
    sys.exit(0)
