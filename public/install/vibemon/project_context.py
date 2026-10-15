"""Hook input and project naming shared by the hooks and the Claude statusline.

The statusline caches each project's model and context usage, and the hooks
read that cache back. Both name the project with get_project_name(), so the
cache key they compute is the same.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

# Hooks and the statusline run from GUI parents as well as terminals. Without
# CREATE_NO_WINDOW every git call flashes a console window on Windows.
NO_WINDOW_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def read_input() -> str:
    """Read the host's JSON payload from stdin.

    The host writes UTF-8, but Python decodes stdin with the locale encoding.
    On a cp949/cp1252 Windows console a non-ASCII prompt or path would raise,
    and the caller would report nothing.
    """
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        pass
    try:
        return sys.stdin.read()
    except (OSError, ValueError):
        return ""


def parse_json(data: str) -> dict[str, Any]:
    """Parse a payload. Valid JSON that is not an object gives an empty event."""
    try:
        value = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def get_git_root(directory: str) -> str | None:
    """Return the git repository root of `directory`, or None."""
    if not directory:
        return None
    try:
        result = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=2,
            creationflags=NO_WINDOW_FLAGS,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return None


def get_project_name(cwd: str, transcript_path: str = "") -> str:
    """Name a project: git root, then working directory, then transcript folder.

    The git root comes first, so a session in a subdirectory (for example
    vibemon/terraform) reports the repository name.
    """
    candidates = [get_git_root(cwd) if cwd else None, cwd.rstrip("/\\") if cwd else None,
                  os.path.dirname(transcript_path) if transcript_path else None, os.getcwd().rstrip("/\\")]
    for path in candidates:
        name = os.path.basename(path) if path else ""
        if name:
            return name
    return "default"
