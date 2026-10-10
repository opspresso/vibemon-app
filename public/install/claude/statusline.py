#!/usr/bin/env python3
"""
Claude Code Statusline Hook
Displays status line and sends context usage to VibeMon
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


# The statusline re-renders on every tick; without CREATE_NO_WINDOW each `git`
# call would flash a console window on Windows.
NO_WINDOW_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Prefer the matching checkout's helpers; installed scripts use ~/.vibemon.
VIBEMON_HOME = Path.home() / ".vibemon"
for helper_dir in (Path(__file__).resolve().parent.parent / "vibemon", VIBEMON_HOME):
    if (helper_dir / "usage_cache.py").is_file():
        sys.path.insert(0, str(helper_dir))
        break

from cache_io import update_json_cache

from usage_cache import (  # noqa: E402
    normalize_percent,
    load_usage_cache as _load_usage_cache,
    model_week_bucket,
    save_usage_cache as _save_usage_cache,
    usage_from_rate_limits,
)

# ============================================================================
# Configuration Loading
# ============================================================================


def load_config() -> None:
    """Load vibemon config (cache_path only, shared with hooks/vibemon.py)
    and statusline display config, and set both as environment variables.

    statusline.json values win over any same-named legacy keys still
    present in config.json, for backward compatibility with installs that
    haven't re-run the installer since the config split.
    """
    vibemon_home = Path.home() / ".vibemon"

    def _load(path: Path) -> dict[str, Any]:
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, IOError):
            return {}

    config = _load(vibemon_home / "config.json")
    statusline_config = _load(vibemon_home / "statusline.json")

    # cache_path is a shared vibemon setting: statusline.py must agree with
    # hooks/vibemon.py on where the cache lives, even though it doesn't use
    # any of config.json's other (monitor-target) keys.
    cache_path = config.get("cache_path")
    if cache_path:
        os.environ.setdefault("VIBEMON_CACHE_PATH", str(cache_path))

    # Map statusline-only config keys to environment variables
    key_mapping = {
        "show_project": ("VIBEMON_SHOW_PROJECT", lambda v: "1" if v else "0"),
        "show_git": ("VIBEMON_SHOW_GIT", lambda v: "1" if v else "0"),
        "show_model": ("VIBEMON_SHOW_MODEL", lambda v: "1" if v else "0"),
        "show_tokens": ("VIBEMON_SHOW_TOKENS", lambda v: "1" if v else "0"),
        "show_cost": ("VIBEMON_SHOW_COST", lambda v: "1" if v else "0"),
        "show_duration": ("VIBEMON_SHOW_DURATION", lambda v: "1" if v else "0"),
        "show_lines": ("VIBEMON_SHOW_LINES", lambda v: "1" if v else "0"),
        "show_memory": ("VIBEMON_SHOW_MEMORY", lambda v: "1" if v else "0"),
        "show_usage": ("VIBEMON_SHOW_USAGE", lambda v: "1" if v else "0"),
        "show_usage_reset": ("VIBEMON_SHOW_USAGE_RESET", lambda v: "1" if v else "0"),
        "show_version": ("VIBEMON_SHOW_VERSION", lambda v: "1" if v else "0"),
        "show_statusline": ("VIBEMON_SHOW_STATUSLINE", lambda v: "1" if v else "0"),
    }
    merged = {**config, **statusline_config}  # statusline.json wins on overlap
    for config_key, (env_key, converter) in key_mapping.items():
        if config_key in merged and merged[config_key] is not None:
            value = converter(merged[config_key])
            if value:
                os.environ.setdefault(env_key, value)


load_config()

VIBE_MONITOR_MAX_PROJECTS = 10


def _show_flag(env_key: str, default: bool) -> bool:
    """Resolve a statusline segment toggle from env (backed by config show_*)."""
    val = os.environ.get(env_key)
    if val is None:
        return default
    return val != "0"


# Statusline segment toggles (config keys: show_*). Defaults match the curated
# layout — every segment on except the work-duration timer.
SHOW_PROJECT = _show_flag("VIBEMON_SHOW_PROJECT", True)
SHOW_GIT = _show_flag("VIBEMON_SHOW_GIT", True)
SHOW_MODEL = _show_flag("VIBEMON_SHOW_MODEL", True)
SHOW_TOKENS = _show_flag("VIBEMON_SHOW_TOKENS", True)
SHOW_COST = _show_flag("VIBEMON_SHOW_COST", True)
SHOW_DURATION = _show_flag("VIBEMON_SHOW_DURATION", False)
SHOW_LINES = _show_flag("VIBEMON_SHOW_LINES", True)
SHOW_MEMORY = _show_flag("VIBEMON_SHOW_MEMORY", True)
SHOW_USAGE = _show_flag("VIBEMON_SHOW_USAGE", True)
SHOW_USAGE_RESET = _show_flag("VIBEMON_SHOW_USAGE_RESET", True)
SHOW_VERSION = _show_flag("VIBEMON_SHOW_VERSION", True)

# Master display toggle: gates only the statusline output. Data collection
# (cache save, plan-usage refresh) still runs when this is off.
SHOW_STATUSLINE = _show_flag("VIBEMON_SHOW_STATUSLINE", True)

# Lock file timeout constants
LOCK_TIMEOUT_SECONDS = 5

# ============================================================================
# Utility Functions
# ============================================================================


def detach_stdio() -> None:
    """Redirect stdin/stdout/stderr to /dev/null (call after os.fork() in the child).

    Claude Code captures the statusline by reading this process's stdout until
    EOF. A forked child inherits that same fd, so the pipe won't reach EOF
    until the child also closes it — even after the parent has already
    exited. Without this, a slow child (lock contention in save_to_cache, or
    the claude -p "/usage" subprocess) stalls the statusline itself.
    """
    try:
        devnull_fd = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(devnull_fd, fd)
        if devnull_fd > 2:
            os.close(devnull_fd)
    except OSError:
        pass


def read_input() -> str:
    """Read input from stdin.

    Claude Code writes UTF-8, but Python decodes stdin with the locale
    encoding — on a cp949/cp1252 Windows console a non-ASCII prompt or path
    in the payload would raise UnicodeDecodeError here and the outer backstop
    would swallow the whole statusline. Mirror the hook adapters' hardening.
    """
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        pass
    return sys.stdin.read()


def parse_json(data: str) -> dict[str, Any]:
    """Parse JSON string to dictionary (non-object JSON yields {})."""
    try:
        value = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


# ============================================================================
# Git Functions
# ============================================================================

# Branch emoji mapping based on branch name prefix
BRANCH_EMOJIS = {
    "main": "🌿",
    "master": "🌿",
    "develop": "🌱",
    "development": "🌱",
    "dev": "🌱",
    "feature": "✨",
    "feat": "✨",
    "fix": "🐛",
    "bugfix": "🐛",
    "hotfix": "🔥",
    "release": "📦",
    "chore": "🧹",
    "refactor": "♻️",
    "docs": "📝",
    "doc": "📝",
    "test": "🧪",
    "experiment": "🧪",
    "exp": "🧪",
}


def get_branch_emoji(branch: str) -> str:
    """Get emoji for branch based on name or prefix."""
    if not branch:
        return "🌿"

    branch_lower = branch.lower()

    # Check exact match first (main, master, develop, etc.)
    if branch_lower in BRANCH_EMOJIS:
        return BRANCH_EMOJIS[branch_lower]

    # Check prefix match (feature/xxx, fix/xxx, etc.)
    if "/" in branch_lower:
        prefix = branch_lower.split("/", 1)[0]
        if prefix in BRANCH_EMOJIS:
            return BRANCH_EMOJIS[prefix]

    # Default emoji
    return "🌿"


def get_git_root(directory: str) -> str | None:
    """Get git repository root directory."""
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


def get_project_name(directory: str) -> str:
    """Get project name from git root or directory basename."""
    if not directory:
        return ""

    # Try git root first (handles subdirectory cases)
    git_root = get_git_root(directory)
    if git_root:
        name = os.path.basename(git_root)
        if name:
            return name

    # Fallback to directory basename
    return os.path.basename(directory)


def get_git_info(directory: str) -> str:
    """Get git branch and status information.

    Optimized to use single git command with status --porcelain --branch
    which provides both branch name and change status in one call.
    """
    if not directory:
        return ""

    try:
        # Single git command: get branch and status in one call
        # --porcelain=v1 --branch gives: "## branch...tracking" as first line
        # followed by changed files (if any)
        result = subprocess.run(
            [
                "git",
                "--no-optional-locks",
                "-C",
                directory,
                "status",
                "--porcelain=v1",
                "--branch",
            ],
            capture_output=True,
            text=True,
            timeout=2,
            creationflags=NO_WINDOW_FLAGS,
        )
        if result.returncode != 0:
            return ""

        lines = result.stdout.splitlines()
        if not lines:
            return ""

        # Parse branch from first line: "## branch" or "## branch...origin/branch"
        header = lines[0]
        if not header.startswith("## "):
            return ""

        branch_part = header[3:]  # Remove "## "
        # Handle "branch...origin/branch [ahead 1]" format
        branch = branch_part.split("...")[0].split()[0]

        if not branch or branch == "HEAD":
            # Detached HEAD state
            return ""

        # Truncate long branch names to 13 chars
        if len(branch) > 13:
            branch = branch[:13] + "..."

        # Check if there are any changes (lines after the header)
        has_changes = len(lines) > 1

        if has_changes:
            return f" git:({branch} *)"
        return f" git:({branch})"

    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


# ============================================================================
# Context Window Functions
# ============================================================================


def get_context_usage(data: dict[str, Any]) -> str:
    """Return measured context utilization, or an empty display for unknown."""
    window = data.get("context_window")
    if not isinstance(window, dict):
        return ""
    percent = normalize_percent(window.get("used_percentage"))
    if percent is not None:
        return f"{percent}%"
    usage = window.get("current_usage")
    size = window.get("context_window_size")
    if not isinstance(usage, dict) or not isinstance(size, (int, float)) or isinstance(size, bool) or size <= 0:
        return ""
    keys = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    if not any(key in usage for key in keys):
        return ""
    values = [usage.get(key, 0) for key in keys]
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0 for value in values):
        return ""
    percent = normalize_percent(sum(values) * 100 / size)
    return f"{percent}%" if percent is not None else ""


# ============================================================================
# VibeMon Cache Functions
# ============================================================================


from account_context import project_cache_key, cache_key


def get_cache_path() -> str:
    """Get the cache file path."""
    cache_path = os.environ.get(
        "VIBEMON_CACHE_PATH", "~/.vibemon/cache/projects.json"
    )
    return os.path.expanduser(cache_path)


def save_to_cache(project: str, model: str, memory: int | None, cwd: str | None = None) -> None:
    """Save scoped context under the shared cross-process cache lock."""
    if not project:
        return

    project = project_cache_key(project, cwd=cwd)
    cache_path = get_cache_path()
    timestamp = int(time.time())

    def update(cache):
        # If new project and cache is full, remove oldest to make room
        if project not in cache and len(cache) >= VIBE_MONITOR_MAX_PROJECTS:
            # Sort by timestamp and remove oldest
            sorted_items = sorted(
                cache.items(),
                key=lambda x: x[1].get("ts", 0) if isinstance(x[1], dict) else 0,
                reverse=True,
            )
            cache = dict(sorted_items[: VIBE_MONITOR_MAX_PROJECTS - 1])

        # Update cache with new project data
        cache[project] = {"model": model, "memory": memory, "ts": timestamp}

        return cache

    update_json_cache(cache_path, update, timeout=LOCK_TIMEOUT_SECONDS)


# ============================================================================
# ANSI Colors
# ============================================================================

C_RESET = "\033[0m"
C_DIM = "\033[2m"
C_CYAN = "\033[36m"
C_GREEN = "\033[32m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_MAGENTA = "\033[35m"
C_BLUE = "\033[34m"
C_ORANGE = "\033[38;5;208m"

# ============================================================================
# Formatting Functions
# ============================================================================


def format_number(num: int | float | str | None) -> str:
    """Format number with K/M suffix."""
    if num is None or num == "null" or num == 0:
        return "0"

    try:
        num_float = float(num)
        int_num = int(num_float)

        if int_num >= 1_000_000:
            return f"{num_float / 1_000_000:.1f}M"
        if int_num >= 1_000:
            return f"{num_float / 1_000:.1f}K"
        return str(int_num)
    except (ValueError, TypeError):
        return "0"


def format_duration(ms: int | float | str | None) -> str:
    """Format duration in milliseconds to human readable format."""
    if ms is None or ms == "null" or ms == 0:
        return "0s"

    try:
        total_seconds = int(ms) // 1000
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)

        if hours > 0:
            return f"{hours}h{minutes}m"
        if minutes > 0:
            return f"{minutes}m{seconds}s"
        return f"{seconds}s"
    except (ValueError, TypeError):
        return "0s"


def format_cost(cost: float | str | None) -> str:
    """Format cost in USD."""
    if cost is None or cost == "null":
        return "$0.00"

    try:
        return f"${float(cost):.2f}"
    except (ValueError, TypeError):
        return "$0.00"


# ============================================================================
# Progress Bar Functions
# ============================================================================


def build_progress_bar(percent_str: str | int | float, width: int = 10) -> str:
    """Build a colored progress bar.

    Args:
        percent_str: Percentage value (can be "85%", "85", 85, or 85.5)
        width: Bar width in characters
    """
    # Remove % sign if present and convert to string
    cleaned = str(percent_str).rstrip("%").strip()

    if not cleaned:
        return ""

    # Parse as float first to handle "12.5"
    try:
        percent_value = float(cleaned)
    except (ValueError, TypeError):
        return ""

    # Clamp to valid range
    percent_value = max(0.0, min(100.0, percent_value))
    percent = int(percent_value)

    # Filled segment count follows the percentage proportionally, so the bar
    # visually reflects its actual ratio (no artificial floor/ceiling).
    filled = round(percent_value * width / 100)
    empty = width - filled

    # Build the bar - filled segments use one color by total ratio, empty in dim
    if percent > 90:
        color = C_RED
    elif percent > 70:
        color = C_ORANGE
    elif percent > 50:
        color = C_YELLOW
    else:
        color = C_GREEN

    filled_bar = f"{color}{'━' * filled}" if filled else ""
    empty_bar = "╌" * empty

    bar = f"{filled_bar}{C_RESET}" if filled_bar else ""
    if empty_bar:
        bar += f"{C_DIM}{empty_bar}{C_RESET}"

    return f"{bar} {percent}%"


# ============================================================================
# Plan Usage Functions
# ============================================================================

def get_usage_cache_path() -> str:
    """Get the plan-usage cache file path (next to the statusline cache)."""
    cache_dir = os.path.dirname(get_cache_path())
    return os.path.join(cache_dir, "usage.json")


def load_usage_cache() -> dict[str, Any] | None:
    """Load cached plan usage, or None if missing/unreadable."""
    return _load_usage_cache(get_usage_cache_path())


def save_usage_cache(usage: dict[str, Any]) -> bool:
    """Merge provider updates and stamp each provider independently."""
    return _save_usage_cache(get_usage_cache_path(), usage)


def build_usage_segment(cache: dict[str, Any] | None) -> str:
    """Render the plan-usage segment: 📊 S <bar> W <bar> [F <bar>].

    The trailing bar is the model-scoped weekly limit (e.g. the Fable
    weekly bucket), labeled with the first letter of the model name.
    """
    if not isinstance(cache, dict):
        return ""

    seg: list[str] = []
    for label, key in (("S", "session"), ("W", "week_all")):
        entry = cache.get(key)
        if isinstance(entry, dict) and entry.get("pct") is not None:
            bar = build_progress_bar(entry["pct"], width=6)
            if bar:
                seg.append(f"{label} {bar}")

    model_week = model_week_bucket(cache)
    if model_week is not None:
        label = model_week.get("label")
        initial = label[0].upper() if isinstance(label, str) and label else "M"
        bar = build_progress_bar(model_week["pct"], width=6)
        if bar:
            seg.append(f"{initial} {bar}")

    if not seg:
        return ""
    return f"{C_CYAN}📊{C_RESET} " + " ".join(seg)


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def parse_reset_time(resets: str) -> float | None:
    """Parse a `/usage` reset string into a local epoch timestamp.

    Handles forms like "Jun 12 at 3:20pm (Asia/Seoul)" and "Jun 13 at 2am ...".
    The trailing timezone label is ignored: `/usage` already renders the clock
    in the user's local zone, so a naive local datetime is correct. The year is
    inferred (rolled forward across a year boundary). Returns None if
    unparseable.
    """
    if not resets:
        return None

    m = re.search(
        r"([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])",
        resets,
    )
    if not m:
        return None

    month = _MONTHS.get(m.group(1).lower())
    if not month:
        return None

    day = int(m.group(2))
    hour = int(m.group(3))
    minute = int(m.group(4) or 0)
    meridiem = m.group(5).lower()
    if meridiem == "pm" and hour != 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0

    now = datetime.now()
    for year in (now.year, now.year + 1):
        try:
            dt = datetime(year, month, day, hour, minute)
        except ValueError:
            return None
        # Use this year's date unless it's well in the past (year rollover).
        if (dt - now).total_seconds() >= -86400:
            return dt.timestamp()
    return None


def format_usage_reset(cache: dict[str, Any] | None) -> str:
    """Render time remaining until the session usage window resets (⏳).

    Color by urgency: red < 30m, orange < 1h, dim otherwise.
    """
    if not isinstance(cache, dict):
        return ""
    session = cache.get("session")
    if not isinstance(session, dict):
        return ""

    resets_at = session.get("resets_at")
    target = float(resets_at) if isinstance(resets_at, (int, float)) else None
    if target is None:
        target = parse_reset_time(session.get("resets", ""))
    if target is None:
        return ""

    remaining = int(target - time.time())
    # Reset windows are at most days away; a far-future value means the date
    # was misparsed (e.g. an unexpected year rollover) — don't show it.
    if remaining <= 0 or remaining > 30 * 86400:
        return ""

    total_minutes = remaining // 60
    hours = total_minutes // 60
    minutes = total_minutes % 60
    display = f"{hours}h{minutes}m" if hours > 0 else f"{minutes}m"

    if remaining <= 1800:
        color = C_RED
    elif remaining <= 3600:
        color = C_ORANGE
    else:
        color = C_DIM

    return f"{color}⏳ {display}{C_RESET}"


# ============================================================================
# Statusline Output
# ============================================================================


def build_statusline(
    model: str,
    dir_name: str,
    git_info: str,
    context_usage: str,
    input_tokens: int | str,
    output_tokens: int | str,
    cost: float | str,
    duration: int | str,
    lines_added: int | str,
    lines_removed: int | str,
    usage_segment: str = "",
    usage_reset: str = "",
    version: str = "",
) -> str:
    """Build the status line string.

    Each segment is gated by a SHOW_* toggle (config keys: show_*), so users
    can curate which fields appear. Default layout:
    📂 project │ 🌿 branch │ 🤖 model │ 📥📤 tokens │ 💰 cost │ +/- lines │
    🧠 memory │ 📊 usage │ ⏳ reset │ version  (work-duration ⏱️ off by default)
    """
    SEP = " │ "
    parts: list[str] = []

    # Directory (📂 icon)
    if SHOW_PROJECT:
        parts.append(f"{C_BLUE}📂 {dir_name}{C_RESET}")

    # Git info (emoji based on branch type)
    if SHOW_GIT and git_info:
        # Extract branch and status from " git:(branch *)" format
        branch_info = git_info.replace(" git:(", "").rstrip(")")
        # Get branch name without status indicator for emoji lookup
        branch_name = branch_info.rstrip(" *")
        emoji = get_branch_emoji(branch_name)
        parts.append(f"{C_GREEN}{emoji} {branch_info}{C_RESET}")

    # Model (🤖 icon) - remove "Claude " prefix
    if SHOW_MODEL:
        short_model = model.removeprefix("Claude ")
        parts.append(f"{C_MAGENTA}🤖 {short_model}{C_RESET}")

    # Token usage (📥 in / 📤 out)
    if SHOW_TOKENS and input_tokens and str(input_tokens) != "0":
        in_fmt = format_number(input_tokens)
        out_fmt = format_number(output_tokens)
        parts.append(f"{C_CYAN}📥 {in_fmt} 📤 {out_fmt}{C_RESET}")

    # Cost (💰 icon)
    if SHOW_COST and cost and str(cost) != "0" and cost != "null":
        cost_fmt = format_cost(cost)
        parts.append(f"{C_YELLOW}💰 {cost_fmt}{C_RESET}")

    # Duration (⏱️ icon)
    if SHOW_DURATION and duration and str(duration) != "0" and duration != "null":
        duration_fmt = format_duration(duration)
        parts.append(f"{C_DIM}⏱️ {duration_fmt}{C_RESET}")

    # Lines changed (+/-)
    if SHOW_LINES and lines_added and str(lines_added) != "0":
        lines_part = f"{C_GREEN}+{lines_added}{C_RESET}"
        if lines_removed and str(lines_removed) != "0":
            lines_part += f" {C_RED}-{lines_removed}{C_RESET}"
        parts.append(lines_part)

    # Context usage with progress bar (🧠 icon)
    if SHOW_MEMORY and context_usage:
        progress_bar = build_progress_bar(context_usage)
        if progress_bar:
            parts.append(f"🧠 {progress_bar}")

    # Plan usage with progress bars (📊 icon)
    if SHOW_USAGE and usage_segment:
        parts.append(usage_segment)

    # Session usage reset countdown (⏳ icon)
    if SHOW_USAGE_RESET and usage_reset:
        parts.append(usage_reset)

    # Claude Code version - always last
    if SHOW_VERSION and version:
        parts.append(f"{C_DIM}v{version}{C_RESET}")

    return SEP.join(parts)


# ============================================================================
# Background Cache Save
# ============================================================================


def save_cache_background(project: str, model: str, memory: int | None, cwd: str | None = None) -> None:
    """Save to cache in background process.

    Uses fork on POSIX systems for efficiency, falls back to synchronous
    save on Windows or if fork fails.
    """
    # Check if fork is available (not on Windows)
    if not hasattr(os, "fork"):
        save_to_cache(project, model, memory, cwd)
        return

    try:
        pid = os.fork()
        if pid == 0:
            # Child process - save cache and exit
            detach_stdio()
            try:
                save_to_cache(project, model, memory, cwd)
            except Exception:
                pass
            os._exit(0)
        # Parent process continues immediately
    except OSError:
        # Fork failed - save synchronously
        save_to_cache(project, model, memory, cwd)


# ============================================================================
# Main
# ============================================================================


def main() -> None:
    """Main entry point."""
    # The rendered line carries emoji and box-drawing characters. Claude Code
    # reads this as UTF-8, but Python encodes stdout with the locale encoding,
    # so on a cp949/cp1252 Windows console every render would die with
    # UnicodeEncodeError instead of printing.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        pass

    # Disable statusline for team sub-agents spawned via Task tool
    # Task tool agents run with CLAUDE_CODE_ENTRYPOINT=local-agent
    # STATUSLINE_DISABLED=1 allows manual override
    entrypoint = os.environ.get("CLAUDE_CODE_ENTRYPOINT", "cli")
    if entrypoint == "local-agent" or os.environ.get("STATUSLINE_DISABLED") == "1":
        return

    input_raw = read_input()

    # Parse JSON once and reuse
    data = parse_json(input_raw)

    # Extract model info
    model_data = data.get("model", {})
    model_display = (
        model_data.get("display_name", "Claude")
        if isinstance(model_data, dict)
        else "Claude"
    )

    # Extract workspace info
    workspace_data = data.get("workspace", {})
    current_dir = (
        workspace_data.get("current_dir", "")
        if isinstance(workspace_data, dict)
        else ""
    )
    dir_name = get_project_name(current_dir) if current_dir else ""

    # Get additional info. git_info is purely for display, so skip the
    # `git status` subprocess entirely when it won't be shown.
    git_info = get_git_info(current_dir) if (SHOW_GIT and SHOW_STATUSLINE) else ""
    context_usage = get_context_usage(data)

    # Extract context window data
    context_window = data.get("context_window", {})
    if isinstance(context_window, dict):
        input_tokens = context_window.get("total_input_tokens", 0)
        output_tokens = context_window.get("total_output_tokens", 0)
    else:
        input_tokens = output_tokens = 0

    # Extract cost data
    cost_data = data.get("cost", {})
    if isinstance(cost_data, dict):
        cost = cost_data.get("total_cost_usd", 0)
        duration = cost_data.get("total_duration_ms", 0)
        lines_added = cost_data.get("total_lines_added", 0)
        lines_removed = cost_data.get("total_lines_removed", 0)
    else:
        cost = duration = lines_added = lines_removed = 0

    # Plan usage: prefer the official rate_limits field from this same
    # payload (Claude Code >= v2.1.80, always fresh, no subprocess). Persist
    # it to the usage cache (under the "claude" key) so hooks/vibemon.py
    # (which reads the file, not this process's stdin) also sees the
    # up-to-date value. Fall back to the claude -p "/usage" subprocess cache
    # for older Claude Code versions.
    usage_cache = usage_from_rate_limits(data)
    if usage_cache is not None:
        save_usage_cache({"claude": usage_cache})
    else:
        raw_cache = load_usage_cache()
        usage_cache = raw_cache.get(cache_key("claude")) if isinstance(raw_cache, dict) else None
    usage_segment = build_usage_segment(usage_cache)

    # A reset countdown requires an observed provider reset time.
    usage_reset = format_usage_reset(usage_cache)

    # Extract Claude Code version
    version = data.get("version", "") or ""
    if not isinstance(version, str):
        version = str(version)

    # Save project metadata to cache in background
    # Convert measured percentages; preserve unknown context as None.
    memory_int = int(context_usage.rstrip("%")) if context_usage else None
    save_cache_background(dir_name, model_display, memory_int, current_dir)

    # Display toggle: data was collected above; only the rendered line is gated.
    if not SHOW_STATUSLINE:
        return

    # Output statusline
    print(
        build_statusline(
            model_display,
            dir_name,
            git_info,
            context_usage,
            input_tokens,
            output_tokens,
            cost,
            duration,
            lines_added,
            lines_removed,
            usage_segment,
            usage_reset,
            version,
        ),
        end="",
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Last-resort backstop: an unexpected payload must degrade to an
        # empty status line, not a traceback that breaks the line entirely.
        # Per-field guards inside main() handle everything anticipated.
        pass
