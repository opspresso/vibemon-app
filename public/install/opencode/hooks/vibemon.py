#!/usr/bin/env python3
"""
VibeMon Hook for opencode
Desktop App + ESP32 (USB Serial / HTTP)
Note: opencode has no Claude Code-style hooks. The opencode plugin
(~/.config/opencode/plugins/vibemon.js) bridges opencode events to these
hook events, and opencode does not report usage, so memory stays 0.
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
CHARACTER = "opencode"

# Event to state mapping (immutable)
EVENT_STATE_MAP: dict[str, str] = {
    "SessionStart": "start",
    "UserPromptSubmit": "thinking",
    "PreToolUse": "working",
    "PostToolUse": "thinking",
    "PermissionRequest": "notification",
    "PreCompact": "packing",
    "PostCompact": "thinking",
    "Stop": "done",
    "SessionEnd": "done",
}


def build_payload(
    state: str, tool: str, project: str, data: dict[str, Any]
) -> dict[str, Any]:
    """Build payload from opencode's model; plan usage is unavailable."""
    model_name = data.get("model", "")

    return {
        "state": state,
        "tool": tool,
        "project": project,
        "model": model_name if isinstance(model_name, str) else "",
        "character": CHARACTER,
        "terminalId": core.get_terminal_id(),
    }


if __name__ == "__main__":
    core.run(
        event_state_map=EVENT_STATE_MAP,
        build_payload=build_payload,
        start_event="SessionStart",
    )
    sys.exit(0)
