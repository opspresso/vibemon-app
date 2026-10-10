#!/usr/bin/env python3
"""
VibeMon Hook for Claude Code
Desktop App + ESP32 (USB Serial / HTTP)
Note: Model and Memory are read from statusline.py's cache file.
Shared transport lives in vibemon_core.py (~/.vibemon/vibemon_core.py).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Locate vibemon_core.py: repo checkout first (docs/vibemon/), then the
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
CHARACTER = "clawd"

# Event to state mapping (immutable)
EVENT_STATE_MAP: dict[str, str] = {
    "SessionStart": "start",
    "UserPromptSubmit": "thinking",
    "PreToolUse": "working",
    "PostToolUse": "thinking",
    "PostToolUseFailure": "thinking",
    "PermissionDenied": "thinking",
    "PreCompact": "packing",
    "PostCompact": "thinking",
    "Notification": "notification",
    "PermissionRequest": "notification",
    "SessionEnd": "done",
    "Stop": "done",
    "StopFailure": "done",
}


def build_payload(
    state: str, tool: str, project: str, data: dict[str, Any]
) -> dict[str, Any]:
    """Build payload dict for sending to monitor."""
    metadata = core.get_project_metadata(project, data.get("cwd"))
    usage = core.get_usage_metadata()

    return {
        "state": state,
        "tool": tool,
        "project": project,
        "model": metadata.get("model", ""),
        **({"memory": metadata["memory"]} if metadata.get("memory") is not None else {}),
        "character": CHARACTER,
        "terminalId": core.get_terminal_id(),
        **usage,
    }


if __name__ == "__main__":
    core.run(
        event_state_map=EVENT_STATE_MAP,
        build_payload=build_payload,
        start_event="SessionStart",
    )
    sys.exit(0)
