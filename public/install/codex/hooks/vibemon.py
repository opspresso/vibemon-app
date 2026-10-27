#!/usr/bin/env python3
"""
VibeMon Hook for Codex CLI
Desktop App + ESP32 (USB Serial / HTTP)
Note: Codex provides the active model directly in hook payloads.
Shared transport lives in vibemon_core.py (~/.vibemon/vibemon_core.py).
"""

from __future__ import annotations

import os
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
else:
    _core_dir = None

try:
    import vibemon_core as core
except ImportError as error:
    # A present file can still fail to import: a helper module is missing, or
    # this Python is broken, such as an ssl module lost in an OpenSSL upgrade.
    print(
        f"[vibemon] Cannot load {_core_dir / 'vibemon_core.py'} with {sys.executable}: {error}. "
        "Reinstall VibeMon (curl -fsSL https://vibemon.io/install/install.py | python3), "
        "or repair this Python when the error names one of its modules."
        if _core_dir else
        "[vibemon] vibemon_core.py not found — re-run the installer: "
        "curl -fsSL https://vibemon.io/install/install.py | python3",
        file=sys.stderr,
    )
    sys.exit(0)

# Character configuration
CHARACTER = "codex"
# The Codex home that holds this hook (CODEX_HOME, by default ~/.codex).
PROFILE_ROOT = str(Path(__file__).resolve().parents[1])

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
    "Interrupt": "done",
    "SessionEnd": "done",
}


def build_payload(
    state: str, tool: str, project: str, data: dict[str, Any]
) -> dict[str, Any]:
    """Build payload from Codex's own model and usage data."""
    usage = core.get_codex_usage_metadata()
    model_name = data.get("model", "")
    memory = core.get_codex_context_usage(data)

    return {
        "state": state,
        "tool": tool,
        "project": project,
        "model": model_name if isinstance(model_name, str) else "",
        **({"memory": memory} if memory is not None else {}),
        "character": CHARACTER,
        "terminalId": core.get_terminal_id(),
        **usage,
    }


def refine(event: str, data: dict[str, Any], state: str) -> core.Transition | None:
    """Skip Codex's own memory generation, which runs as a session in CODEX_HOME/memories."""
    cwd = data.get("cwd")
    if isinstance(cwd, str) and cwd:
        memories = os.path.realpath(os.path.join(PROFILE_ROOT, "memories"))
        real = os.path.realpath(cwd)
        if real == memories or real.startswith(memories + os.sep):
            return None
    return core.Transition(state)


if __name__ == "__main__":
    core.run(
        account_provider="codex",
        profile_root=PROFILE_ROOT,
        event_state_map=EVENT_STATE_MAP,
        build_payload=build_payload,
        start_event="SessionStart",
        refine=refine,
        # hooks.json runs these synchronously with Codex's three-second maximum.
        sync_events=frozenset({"SessionEnd", "Interrupt"}),
    )
    sys.exit(0)
