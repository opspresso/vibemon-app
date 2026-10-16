#!/usr/bin/env python3
"""
VibeMon Hook Core
Shared transport and helpers for the per-tool hooks (Claude Code, Codex CLI,
Kiro IDE and CLI, OpenCode). Each tool's vibemon.py is a thin adapter that defines its
EVENT_STATE_MAP / CHARACTER / payload builder and calls run().

Installed to ~/.vibemon/vibemon_core.py by install.py.
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from account_context import cloud_context, project_cache_key
from project_context import get_project_name, parse_json, read_input
import session_activity
from session_activity import Transition
from http_client import open_credential_request
from usage_cache import CACHE_STALE_SECONDS, get_fresh_provider, is_finite_number, is_fresh_observation, load_usage_cache, model_week_bucket, valid_percent, reverse_jsonl

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

IS_WINDOWS = os.name == "nt"

# Hooks run from GUI parents (the Desktop app) as well as terminals. Without
# CREATE_NO_WINDOW every helper process flashes a console window on Windows.
NO_WINDOW_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ============================================================================
# Configuration Loading
# ============================================================================


def load_config() -> None:
    """Load configuration from config.json and set as environment variables."""
    config_file = Path.home() / ".vibemon" / "config.json"
    if not config_file.exists():
        return

    try:
        with open(config_file, encoding="utf-8") as f:
            config = json.load(f)
    except (json.JSONDecodeError, IOError):
        return
    if not isinstance(config, dict):
        return

    # Map config keys to environment variables
    key_mapping = {
        "debug": ("DEBUG", lambda v: "1" if v else "0"),
        "cache_path": ("VIBEMON_CACHE_PATH", str),
        "auto_launch": ("VIBEMON_AUTO_LAUNCH", lambda v: "1" if v else "0"),
        "http_urls": (
            "VIBEMON_HTTP_URLS",
            lambda v: ",".join(u for u in v if isinstance(u, str))
            if isinstance(v, list) else v if isinstance(v, str) else "",
        ),
        "serial_port": ("VIBEMON_SERIAL_PORT", str),
        "vibemon_url": ("VIBEMON_URL", str),
        "vibemon_token": ("VIBEMON_TOKEN", str),
    }

    for config_key, (env_key, converter) in key_mapping.items():
        if config_key in config and config[config_key] is not None:
            value = converter(config[config_key])
            if value:
                os.environ.setdefault(env_key, value)


load_config()

# ============================================================================
# Configuration
# ============================================================================

DEBUG = os.environ.get("DEBUG", "0") == "1"

# Error messages
ERR_NO_TARGET = '{"error":"No monitor target available. Set VIBEMON_HTTP_URLS or VIBEMON_SERIAL_PORT"}'
ERR_NO_ESP32 = '{"error":"No ESP32 target available. Set VIBEMON_HTTP_URLS (with ESP32 URL) or VIBEMON_SERIAL_PORT"}'
ERR_INVALID_MODE = (
    '{"error":"Invalid mode: %s. Valid modes: first-project, on-thinking"}'
)

VALID_LOCK_MODES = frozenset(["first-project", "on-thinking"])

# Serial configuration
SERIAL_DEBOUNCE_MS = 100
SERIAL_LOCK_MAX_RETRIES = 10
SERIAL_LOCK_RETRY_INTERVAL = 0.05
SERIAL_BAUD_RATE = "115200"

# HTTP configuration
HTTP_TIMEOUT_SECONDS = 5

# Codex session logs, searched for the active thread's context usage.
CODEX_SESSIONS_DIR = str(
    Path(os.environ.get("CODEX_HOME") or "~/.codex").expanduser() / "sessions"
)

# Desktop launch configuration
DESKTOP_LAUNCH_WAIT_SECONDS = 3


@dataclass(frozen=True)
class Config:
    """Immutable configuration container."""

    http_urls: tuple[str, ...]
    serial_port: str | None
    cache_path: str
    auto_launch: bool
    vibemon_url: str | None
    vibemon_token: str | None


# Cached configuration (computed once)
_config: Config | None = None


def parse_http_urls(urls_str: str | None) -> tuple[str, ...]:
    """Parse comma-separated HTTP URLs."""
    if not urls_str:
        return ()
    return tuple(url.strip() for url in urls_str.split(",") if url.strip())


def get_config() -> Config:
    """Get configuration from environment variables (cached)."""
    global _config
    if _config is None:
        _config = Config(
            http_urls=parse_http_urls(os.environ.get("VIBEMON_HTTP_URLS")),
            serial_port=os.environ.get("VIBEMON_SERIAL_PORT"),
            cache_path=os.path.expanduser(
                os.environ.get("VIBEMON_CACHE_PATH", "~/.vibemon/cache/projects.json")
            ),
            auto_launch=os.environ.get("VIBEMON_AUTO_LAUNCH", "0") == "1",
            vibemon_url=os.environ.get("VIBEMON_URL"),
            vibemon_token=os.environ.get("VIBEMON_TOKEN"),
        )
    return _config


# ============================================================================
# Utility Functions
# ============================================================================


def debug_log(msg: str) -> None:
    """Print debug message to stderr."""
    if DEBUG:
        print(f"[DEBUG] {msg}", file=sys.stderr)


def resolve_serial_port(port_pattern: str | None) -> str | None:
    """Resolve a serial port setting: `~` expands and `*` picks the first match."""
    if not port_pattern:
        return None
    port_pattern = os.path.expanduser(port_pattern.strip())

    if "*" in port_pattern:
        matches = sorted(glob.glob(port_pattern))
        if matches:
            debug_log(f"Found serial ports: {matches}, using: {matches[0]}")
            return matches[0]
        debug_log(f"No serial port found matching: {port_pattern}")
        return None

    return port_pattern


# ============================================================================
# State Functions
# ============================================================================


def get_transition(
    event_name: str,
    data: dict[str, Any],
    event_state_map: dict[str, str],
    refine: Callable[[str, dict[str, Any], str], Transition | None] | None = None,
) -> Transition | None:
    """Map a hook event to the transition it reports.

    Returns None for events outside the tool's map (e.g. a hook registration
    left behind by an older install) or events the adapter filters out, so
    the caller skips reporting instead of guessing a state.
    """
    state = event_state_map.get(event_name)
    if state is None:
        return None
    if event_name == "PreToolUse" and session_activity.is_input_tool(data.get("tool_name")):
        # The tool asks the user a question: the turn waits for an answer.
        state = "notification"
    transition = refine(event_name, data, state) if refine else Transition(state)
    if transition is not None and data.get("permission_mode") == "plan" and transition.state in ("thinking", "working"):
        return Transition("planning", transition.settles)
    return transition


def get_project_metadata(project: str, cwd: str | None = None) -> dict[str, Any]:
    """Get model and memory from cache for a project.

    Entries older than CACHE_STALE_SECONDS are treated as unknown (empty
    dict) rather than returned as-is, since statusline.py (the only writer)
    may not have run for this project recently and the cached model/memory
    could be misleadingly stale (e.g. left over from a prior session).
    """
    if not project:
        return {}

    config = get_config()

    if not os.path.exists(config.cache_path):
        return {}

    try:
        with open(config.cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

    if not isinstance(cache, dict):
        return {}
    entry = cache.get(project_cache_key(project, cwd=cwd), {})
    if not isinstance(entry, dict):
        return {}

    if not is_fresh_observation(entry.get("ts"), CACHE_STALE_SECONDS, time.time()):
        return {}

    return entry


def get_codex_context_usage(data: dict[str, Any]) -> float | None:
    """Return the active Codex thread's context-window usage percentage."""
    transcript_path = data.get("transcript_path") or data.get("transcriptPath")
    if not isinstance(transcript_path, str) or not os.path.isfile(transcript_path):
        thread_id = (
            data.get("session_id")
            or data.get("sessionId")
            or data.get("thread_id")
            or data.get("threadId")
            or os.environ.get("CODEX_THREAD_ID")
        )
        if not isinstance(thread_id, str) or not thread_id:
            return None
        matches = glob.glob(
            os.path.join(CODEX_SESSIONS_DIR, "**", f"*{thread_id}.jsonl"),
            recursive=True,
        )
        if not matches:
            return None
        transcript_path = max(matches, key=os.path.getmtime)

    for entry in reverse_jsonl(transcript_path):
        if entry.get("type") != "event_msg":
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "token_count":
            continue
        info = payload.get("info")
        if not isinstance(info, dict):
            continue
        usage = info.get("last_token_usage")
        if not isinstance(usage, dict):
            continue
        total_tokens = usage.get("total_tokens")
        context_window = info.get("model_context_window")
        if not is_finite_number(total_tokens) or total_tokens < 0:
            continue
        if (
            not is_finite_number(context_window)
            or context_window <= 0
        ):
            continue
        percent = (total_tokens / context_window) * 100
        if is_finite_number(percent):
            return max(0, min(100, percent))
    return None


def _resets_in_minutes(entry: dict[str, Any]) -> int | None:
    """Minutes remaining until a usage bucket's `resets_at` (epoch seconds),
    or None if that bucket has no resets_at (e.g. populated by the older
    `claude -p "/usage"` subprocess fallback, which only has a display string).
    """
    resets_at = entry.get("resets_at")
    if not is_finite_number(resets_at):
        return None
    minutes = max(0, round((resets_at - time.time()) / 60))
    return minutes if minutes <= 2**53 - 1 else None


def _load_usage_provider(provider: str) -> dict[str, Any] | None:
    """Load one provider only when that provider's usage is fresh."""
    config = get_config()
    usage_path = os.path.join(os.path.dirname(config.cache_path), "usage.json")
    return get_fresh_provider(load_usage_cache(usage_path), provider, CACHE_STALE_SECONDS)


def _usage_fields(bucket_data: dict[str, Any] | None) -> dict[str, Any]:
    """Build {usage5h, usageWeek, usage5hResetsIn, usageWeekResetsIn,
    usageWeekModel, usageWeekModelResetsIn, usageWeekModelLabel} from a
    provider's `{session, week_all, week_<model>}` cache entry. The
    usageWeekModel* fields carry the model-scoped weekly limit (e.g. the
    Fable weekly bucket) when the plan has one. The ResetsIn fields
    (minutes until reset) are included only when the entry has a `resets_at`
    epoch. Keys are omitted when a value is unavailable, so the API can
    remove stale values instead of overwriting them with 0.
    """
    if not isinstance(bucket_data, dict):
        return {}

    result: dict[str, Any] = {}
    session = bucket_data.get("session")
    session_pct = session.get("pct") if isinstance(session, dict) else None
    if valid_percent(session_pct):
        result["usage5h"] = session_pct
        resets_in = _resets_in_minutes(session)
        if resets_in is not None:
            result["usage5hResetsIn"] = resets_in
    week = bucket_data.get("week_all")
    week_pct = week.get("pct") if isinstance(week, dict) else None
    if valid_percent(week_pct):
        result["usageWeek"] = week_pct
        resets_in = _resets_in_minutes(week)
        if resets_in is not None:
            result["usageWeekResetsIn"] = resets_in
    model_week = model_week_bucket(bucket_data)
    if model_week is not None:
        result["usageWeekModel"] = model_week["pct"]
        resets_in = _resets_in_minutes(model_week)
        if resets_in is not None:
            result["usageWeekModelResetsIn"] = resets_in
        label = model_week.get("label")
        if isinstance(label, str) and label:
            result["usageWeekModelLabel"] = label
    return result


def get_usage_metadata() -> dict[str, Any]:
    """Get Claude plan-usage percentages from the shared usage cache.

    usage.py/statusline.py cache plan usage (from the statusline payload's
    official `rate_limits` field, Anthropic's usage API, or a `claude -p
    "/usage"` subprocess as fallback) next to the project cache
    (~/.vibemon/cache/usage.json), under the "claude" key. Returns {usage5h,
    usageWeek, usage5hResetsIn, usageWeekResetsIn} for the 5-hour session
    window and the weekly (all-models) window, plus {usageWeekModel,
    usageWeekModelResetsIn, usageWeekModelLabel} when a model-scoped weekly
    bucket (e.g. week_fable) is cached.
    """
    return _usage_fields(_load_usage_provider("claude"))


def get_codex_usage_metadata() -> dict[str, Any]:
    """Get Codex plan-usage percentages from the shared usage cache.

    Same cache file and field shape as get_usage_metadata(), read from the
    "codex" key that usage.py populates from Codex CLI's account-level usage
    API (or its local session log as a fallback).
    """
    return _usage_fields(_load_usage_provider("codex"))


def get_terminal_id() -> str:
    """Get terminal ID from environment."""
    iterm_session = os.environ.get("ITERM_SESSION_ID")
    if iterm_session:
        return f"iterm2:{iterm_session}"

    ghostty_pid = os.environ.get("GHOSTTY_PID")
    if ghostty_pid:
        return f"ghostty:{ghostty_pid}"

    return ""


# ============================================================================
# Low-Level Send Functions
# ============================================================================


def _get_serial_lock_path(port: str) -> str:
    """Get lock file path for serial port."""
    return os.path.join(
        tempfile.gettempdir(), f"vibemon-serial-{port.replace('/', '_')}.lock"
    )


def _get_serial_debounce_path(port: str) -> str:
    """Get debounce file path for serial port."""
    return os.path.join(
        tempfile.gettempdir(), f"vibemon-serial-{port.replace('/', '_')}.debounce"
    )


def _get_serial_debounce_lock_path(port: str) -> str:
    """Get debounce lock file path for serial port."""
    return os.path.join(
        tempfile.gettempdir(), f"vibemon-serial-{port.replace('/', '_')}.dlock"
    )


def _acquire_lock(lock_fd: int, max_retries: int = SERIAL_LOCK_MAX_RETRIES) -> bool:
    """Try to acquire file lock with retries. Returns False immediately if
    fcntl isn't available (e.g. Windows)."""
    if fcntl is None:
        return False
    for attempt in range(max_retries):
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if attempt < max_retries - 1:
                time.sleep(SERIAL_LOCK_RETRY_INTERVAL)
    return False


def send_serial_raw(port: str, data: str) -> bool:
    """Send data via serial port with file locking (internal use).

    POSIX only: this drives the port through `stty` and a non-blocking write to
    the device file, neither of which exists on Windows (a COM port would need
    `mode COMx` plus a `\\\\.\\COMx` handle). HTTP and cloud targets still work
    there, so a configured serial_port is ignored rather than fatal.
    """
    if IS_WINDOWS:
        debug_log("Serial output is not supported on Windows; skipping")
        return False

    if not os.path.exists(port):
        return False

    lock_path = _get_serial_lock_path(port)
    lock_fd = None

    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)

        if not _acquire_lock(lock_fd):
            debug_log(
                f"Failed to acquire serial lock after {SERIAL_LOCK_MAX_RETRIES} attempts"
            )
            return False

        try:
            # Write data. Open non-blocking so a device that never asserts
            # DCD/carrier can't hang this call indefinitely. os.write() may
            # return a short count, so loop until every byte is sent. A full
            # device buffer raises BlockingIOError, which is retried briefly
            # (rather than aborting mid-frame) and gives up after the same
            # bound as the lock; a zero-byte write would otherwise spin forever.
            open_flags = os.O_WRONLY
            if hasattr(os, "O_NONBLOCK"):
                open_flags |= os.O_NONBLOCK
            if hasattr(os, "O_NOCTTY"):
                open_flags |= os.O_NOCTTY
            port_fd = os.open(port, open_flags)
            try:
                # Validate and configure the opened descriptor, not a path that
                # could be a regular file or change between checks and writing.
                if not os.isatty(port_fd):
                    debug_log("Serial target is not a terminal device")
                    return False
                subprocess.run(
                    ["stty", SERIAL_BAUD_RATE], stdin=port_fd, check=True,
                    capture_output=True, timeout=2,
                )
                payload_bytes = (data + "\n").encode()
                written = 0
                stalls = 0
                while written < len(payload_bytes):
                    try:
                        count = os.write(port_fd, payload_bytes[written:])
                    except BlockingIOError:
                        stalls += 1
                        if stalls > SERIAL_LOCK_MAX_RETRIES:
                            debug_log("Serial write stalled (device buffer full)")
                            return False
                        time.sleep(SERIAL_LOCK_RETRY_INTERVAL)
                        continue
                    if count <= 0:
                        debug_log("Serial write made no progress; aborting")
                        return False
                    written += count
            finally:
                os.close(port_fd)

            time.sleep(SERIAL_LOCK_RETRY_INTERVAL)
            return True
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)

    except (IOError, OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as e:
        debug_log(f"Serial send error: {e}")
        return False
    finally:
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except OSError:
                pass


def send_serial(port: str, data: str) -> bool:
    """Send data via serial port with debouncing.

    Uses a debounce file to coalesce rapid updates. Only the last update
    within the debounce window is actually sent to the serial port.
    """
    if IS_WINDOWS:
        return send_serial_raw(port, data)

    if not os.path.exists(port):
        return False

    if fcntl is None:
        # No locking primitive available (e.g. Windows): skip debounce
        # coordination and send directly.
        return send_serial_raw(port, data)

    debounce_path = _get_serial_debounce_path(port)
    lock_path = _get_serial_debounce_lock_path(port)
    my_id = str(uuid.uuid4())

    lock_fd = None
    debounce_temp = None
    try:
        # Write our payload to the debounce file (with lock). A blocked
        # `flock(LOCK_EX)` here would stall the hook until the lock is free,
        # and the lock is held while send_serial_raw() drives a possibly
        # unresponsive device — a hung port could deadlock every subsequent
        # hook process. Try non-blocking first and fall back to a direct
        # send when the lock is busy.
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        if not _acquire_lock(lock_fd):
            debug_log("Serial debounce: lock busy, sending directly")
            os.close(lock_fd)
            lock_fd = None
            return send_serial_raw(port, data)
        try:
            # Atomic replacement does not follow a pre-existing symlink, and
            # NamedTemporaryFile keeps the transient payload owner-readable.
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(debounce_path), prefix=".vibemon-serial-", delete=False) as f:
                debounce_temp = f.name
                json.dump({"id": my_id, "data": data, "time": time.time()}, f)
            os.replace(debounce_temp, debounce_path)
            debounce_temp = None
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
            lock_fd = None

        # Wait for debounce period
        time.sleep(SERIAL_DEBOUNCE_MS / 1000.0)

        # Check if we're still the latest (with lock)
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        if not _acquire_lock(lock_fd):
            debug_log("Serial debounce: re-lock busy, sending directly")
            os.close(lock_fd)
            lock_fd = None
            return send_serial_raw(port, data)
        try:
            with open(debounce_path, encoding="utf-8") as f:
                state = json.load(f)

            if state["id"] != my_id:
                debug_log("Serial debounce: skipped (newer update exists)")
                return True  # Another process will send

            debug_log("Serial debounce: sending (we have latest)")
            return send_serial_raw(port, state["data"])
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
            lock_fd = None

    except (IOError, OSError, json.JSONDecodeError) as e:
        debug_log(f"Serial debounce error: {e}, falling back to direct send")
        return send_serial_raw(port, data)
    finally:
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except OSError:
                pass
        if debounce_temp is not None:
            Path(debounce_temp).unlink(missing_ok=True)


def send_http_post(
    url: str, endpoint: str, data: str | None = None
) -> tuple[bool, str | None]:
    """Send HTTP POST request."""
    try:
        full_url = f"{url.rstrip('/')}{endpoint}"
        if data:
            req = Request(
                full_url,
                data=data.encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
        else:
            req = Request(full_url, method="POST")

        with urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return True, response.read().decode("utf-8")
    except (URLError, TimeoutError, OSError):
        return False, None


def send_http_get(url: str, endpoint: str) -> tuple[bool, str | None]:
    """Send HTTP GET request."""
    try:
        with urlopen(f"{url.rstrip('/')}{endpoint}", timeout=HTTP_TIMEOUT_SECONDS) as response:
            return True, response.read().decode("utf-8")
    except (URLError, TimeoutError, OSError):
        return False, None


def send_vibemon_api(url: str, token: str, payload: dict[str, Any], context: dict | None = None) -> bool:
    """Send status to VibeMon API with Bearer token authentication.

    API: POST /api/status
    Headers: Authorization: Bearer <token>, Content-Type: application/json
    Body: { state, project, tool, model, memory, character,
            usage5h?, usageWeek?, usage5hResetsIn?, usageWeekResetsIn?,
            usageWeekModel?, usageWeekModelResetsIn?, usageWeekModelLabel? }
    """
    try:
        api_url = f"{url.rstrip('/')}/api/status"
        # VibeMon API doesn't need terminalId
        api_body: dict[str, Any] = {
            "state": payload.get("state", ""),
            "project": payload.get("project", ""),
            "tool": payload.get("tool", ""),
            "model": payload.get("model", ""),
            "character": payload.get("character", ""),
        }
        # Plan-usage fields are optional; include only when available so the API
        # REMOVEs stale values instead of overwriting them with 0.
        for key in (
            "memory",
            "usage5h",
            "usageWeek",
            "usage5hResetsIn",
            "usageWeekResetsIn",
            "usageWeekModel",
            "usageWeekModelResetsIn",
            "usageWeekModelLabel",
        ):
            if payload.get(key) is not None:
                api_body[key] = payload[key]
        api_body.update(context or cloud_context(str(payload.get("character", "vibemon")), str(payload.get("project", ""))))
        api_payload = json.dumps(api_body)

        req = Request(
            api_url,
            data=api_payload.encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )

        with open_credential_request(req, timeout=HTTP_TIMEOUT_SECONDS) as response:
            debug_log(f"VibeMon API response: {response.status}")
            return 200 <= response.status < 300
    except HTTPError as error:
        guidance = {
            401: "Replace vibemon_token in ~/.vibemon/config.json with an active write token from your Web Account page.",
            403: "The configured token needs write permission; select a write token from your Web Account page.",
            429: "Web rate limit reached; reduce hook update frequency.",
        }.get(error.code, "Check the Web service and hook configuration.")
        # Response bodies, exception text and URLs may contain credentials.
        print(f"[vibemon] Web update rejected (HTTP {error.code}). {guidance}", file=sys.stderr)
        error.close()
        return False
    except (URLError, TimeoutError, OSError) as error:
        print(f"[vibemon] Web update failed ({type(error).__name__}). Check the Web connection and vibemon_url in ~/.vibemon/config.json.", file=sys.stderr)
        return False


# ============================================================================
# Target Resolution
# ============================================================================


def _send_http_request(
    url: str, endpoint: str, data: str | None, method: str
) -> tuple[bool, str | None]:
    """Send HTTP request with specified method."""
    if method == "POST":
        return send_http_post(url, endpoint, data)
    return send_http_get(url, endpoint)


def is_localhost_url(url: str) -> bool:
    """Check if URL is localhost (Desktop App)."""
    try:
        return urlsplit(url).hostname in {"127.0.0.1", "localhost", "::1"}
    except ValueError:
        return False


def try_http_targets(
    endpoint: str,
    data: str | None = None,
    method: str = "POST",
    include_localhost: bool = True,
) -> tuple[bool, str | None]:
    """Try HTTP targets in order.

    Returns: (success, result_text)
    """
    config = get_config()

    for url in config.http_urls:
        if not include_localhost and is_localhost_url(url):
            continue
        debug_log(f"Trying HTTP: {url}")
        success, result = _send_http_request(url, endpoint, data, method)
        if success:
            return True, result

    return False, None


def try_serial_target(command_data: str) -> tuple[bool, str | None]:
    """Try Serial target.

    Returns: (success, resolved_port)
    """
    config = get_config()

    if not config.serial_port:
        return False, None

    resolved_port = resolve_serial_port(config.serial_port)
    if not resolved_port:
        return False, None

    debug_log(f"Trying Serial: {resolved_port}")
    if send_serial(resolved_port, command_data):
        return True, resolved_port

    return False, None


def try_all_targets(
    endpoint: str,
    http_data: str | None,
    serial_command: str,
    include_localhost: bool = True,
) -> tuple[bool, str | None]:
    """Try all targets: HTTP → Serial.

    Returns: (success, result_text or None)
    """
    # Try HTTP targets first
    success, result = try_http_targets(endpoint, http_data, "POST", include_localhost)
    if success:
        return True, result

    # Try Serial
    success, _ = try_serial_target(serial_command)
    if success:
        return True, None  # Serial doesn't return response

    return False, None


# ============================================================================
# Command Functions
# ============================================================================


def _print_result(result: str | None, fallback: str) -> None:
    """Print result or fallback message."""
    print(result if result else fallback)


def send_lock(project: str) -> bool:
    """Lock the monitor to a specific project."""
    debug_log(f"Locking project: {project}")

    http_data = json.dumps({"project": project})
    serial_data = json.dumps({"command": "lock", "project": project})

    success, result = try_all_targets("/lock", http_data, serial_data)

    if success:
        _print_result(result, f'{{"success":true,"locked":"{project}"}}')
        return True

    debug_log("No monitor target available")
    print(ERR_NO_TARGET)
    return False


def send_unlock() -> bool:
    """Unlock the monitor."""
    debug_log("Unlocking")

    serial_data = json.dumps({"command": "unlock"})
    success, result = try_all_targets("/unlock", None, serial_data)

    if success:
        _print_result(result, '{"success":true,"locked":null}')
        return True

    debug_log("No monitor target available")
    print(ERR_NO_TARGET)
    return False


def get_status() -> bool:
    """Get current status from monitor."""
    # Try HTTP targets
    success, result = try_http_targets("/status", method="GET")
    if success:
        print(result)
        return True

    # Try Serial (can't read response)
    serial_data = json.dumps({"command": "status"})
    success, _ = try_serial_target(serial_data)
    if success:
        print('{"info":"Status command sent via serial. Check device output."}')
        return True

    debug_log("No monitor target available")
    print(ERR_NO_TARGET)
    return False


def get_lock_mode() -> bool:
    """Get current lock mode from monitor."""
    # Try HTTP targets
    success, result = try_http_targets("/lock-mode", method="GET")
    if success:
        print(result)
        return True

    # Try Serial (can't read response)
    serial_data = json.dumps({"command": "lock-mode"})
    success, _ = try_serial_target(serial_data)
    if success:
        print('{"info":"Lock-mode command sent via serial. Check device output."}')
        return True

    debug_log("No monitor target available")
    print(ERR_NO_TARGET)
    return False


def set_lock_mode(mode: str) -> bool:
    """Set lock mode on monitor."""
    if mode not in VALID_LOCK_MODES:
        print(ERR_INVALID_MODE % mode)
        return False

    debug_log(f"Setting lock mode: {mode}")

    http_data = json.dumps({"mode": mode})
    serial_data = json.dumps({"command": "lock-mode", "mode": mode})

    success, result = try_all_targets("/lock-mode", http_data, serial_data)

    if success:
        _print_result(result, f'{{"success":true,"lockMode":"{mode}"}}')
        return True

    debug_log("No monitor target available")
    print(ERR_NO_TARGET)
    return False


def send_reboot() -> bool:
    """Reboot the ESP32 device."""
    debug_log("Rebooting ESP32")

    serial_data = json.dumps({"command": "reboot"})

    # ESP32 only - don't include localhost (Desktop)
    success, result = try_all_targets(
        "/reboot", None, serial_data, include_localhost=False
    )

    if success:
        _print_result(result, '{"success":true,"rebooting":true}')
        return True

    debug_log("No ESP32 target available")
    print(ERR_NO_ESP32)
    return False


# ============================================================================
# Send to All Targets (for status updates)
# ============================================================================


def is_monitor_running(url: str) -> bool:
    """Check if monitor is running."""
    success, _ = send_http_get(url, "/health")
    return success


def show_monitor_window(url: str) -> None:
    """Show the monitor window."""
    send_http_post(url, "/show")


def launch_desktop() -> bool:
    """Launch an installed desktop package without downloading software."""
    try:
        if IS_WINDOWS:
            roots = [
                ("LOCALAPPDATA", ("Programs", "VibeMon", "VibeMon.exe")),
                ("PROGRAMFILES", ("VibeMon", "VibeMon.exe")),
                ("PROGRAMFILES(X86)", ("VibeMon", "VibeMon.exe")),
            ]
            candidates = [Path(os.environ[key]).joinpath(*parts) for key, parts in roots if os.environ.get(key)]
            installed = next((str(path) for path in candidates if path.is_file()), None)
            executable = installed or shutil.which("VibeMon.exe")
            if not executable:
                debug_log("Installed VibeMon.exe not found; start the Desktop App manually")
                return False
            command = [executable]
            kwargs = {"creationflags": NO_WINDOW_FLAGS | getattr(subprocess, "DETACHED_PROCESS", 0)}
        elif sys.platform == "darwin":
            command = ["/usr/bin/open", "-g", "-a", "VibeMon"]
            kwargs = {"start_new_session": True}
        else:
            debug_log("Start the Desktop App manually on this platform")
            return False

        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
        time.sleep(DESKTOP_LAUNCH_WAIT_SECONDS)
        return True
    except OSError as e:
        debug_log(f"Failed to launch Desktop App: {e}")
        return False


def get_desktop_url(http_urls: tuple[str, ...]) -> str | None:
    """Get first localhost URL (Desktop App) from HTTP URLs."""
    for url in http_urls:
        if is_localhost_url(url):
            return url
    return None


def send_to_all(payload: dict[str, Any], is_start: bool = False, context: dict | bool | None = None) -> None:
    """Send payload to all configured targets concurrently."""
    config = get_config()

    # Launch Desktop App if not running (on start) - must be sequential
    desktop_url = get_desktop_url(config.http_urls)
    if desktop_url and is_start and config.auto_launch:
        if not is_monitor_running(desktop_url):
            debug_log("Desktop App not running, launching...")
            launch_desktop()
        show_monitor_window(desktop_url)

    # Every display receives the same non-secret provider/workspace identity.
    payload_str = json.dumps({**payload, **context} if isinstance(context, dict) else payload)

    # Resolve serial port once
    resolved_port: str | None = None
    if config.serial_port:
        resolved_port = resolve_serial_port(config.serial_port)
        if not resolved_port:
            debug_log(f"No serial port found for pattern: {config.serial_port}")

    # Build list of tasks to run in parallel
    tasks: list[tuple[str, Any]] = []

    for url in config.http_urls:
        # Capture url in closure
        u = url
        label = "Desktop App" if is_localhost_url(url) else f"HTTP ({url})"
        tasks.append((label, lambda u=u: send_http_post(u, "/status", payload_str)[0]))

    if resolved_port:
        # Capture resolved_port in closure
        port = resolved_port
        tasks.append(("USB serial", lambda p=port: send_serial(p, payload_str)))

    # Add VibeMon API target if configured
    if context is not False and config.vibemon_url and config.vibemon_token and payload.get("project"):
        tasks.append(
            (
                "VibeMon API",
                lambda: send_vibemon_api(
                    config.vibemon_url, config.vibemon_token, payload, context
                ),
            )
        )

    if not tasks:
        return

    # Execute all tasks concurrently
    with ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        future_to_name = {executor.submit(task): name for name, task in tasks}
        for future in as_completed(future_to_name):
            name = future_to_name[future]
            try:
                success = future.result()
                debug_log(f"Sent to {name}" if success else f"{name} failed")
            except Exception as e:
                debug_log(f"{name} failed with error: {e}")


# ============================================================================
# Command Handlers
# ============================================================================

def send_serial_input(args: list[str]) -> bool:
    """Internal serial transport entry point for the OpenClaw plugin.

    `args[0]` is the configured port setting, resolved like `serial_port`.
    """
    data = parse_json(read_input())
    port = resolve_serial_port(args[0]) if args else None
    return bool(port and data) and send_serial(port, json.dumps(data))


def send_cloud_status(provider: str) -> bool:
    """Send a plugin status with shared account identity and credential rules."""
    config = get_config()
    payload = parse_json(read_input())
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", provider) or not all(
        isinstance(payload.get(field), str) and payload[field].strip()
        for field in ("state", "project")
    ):
        return False
    if not config.vibemon_url or not config.vibemon_token:
        return False
    try:
        context = cloud_context(provider, payload["project"])
        if "sourceId" in payload or "account" in payload:
            if payload.get("sourceId") != context["sourceId"] or payload.get("account") != context["account"]:
                raise ValueError("Plugin account identity changed before delivery")
            # Keep the event time common to local and cloud delivery. The API
            # validates timestamp freshness and rejects out-of-order events.
            context["observedAt"] = payload.get("observedAt")
        if payload.get("heartbeat") is True:
            context["heartbeat"] = True
        return send_vibemon_api(config.vibemon_url, config.vibemon_token, payload, context)
    except ValueError:
        print("[vibemon] Invalid cloud account configuration", file=sys.stderr)
        return False


# Command-line entry points, dispatched before hook input is read.
COMMAND_HANDLERS: dict[str, Any] = {
    "--send-cloud": lambda args: send_cloud_status(args[0]) if len(args) == 1 else False,
    "--launch-desktop": lambda args: launch_desktop(),
    "--send-serial": send_serial_input,
    "--lock": lambda args: send_lock(
        args[0] if args else os.path.basename(os.getcwd())
    ),
    "--unlock": lambda args: send_unlock(),
    "--status": lambda args: get_status(),
    "--lock-mode": lambda args: set_lock_mode(args[0]) if args else get_lock_mode(),
    "--reboot": lambda args: send_reboot(),
    "--watch-session": lambda args: watch_session(args),
}


def handle_command(cmd: str, args: list[str]) -> bool | None:
    """Handle CLI command."""
    handler = COMMAND_HANDLERS.get(cmd)
    if handler:
        return handler(args)
    return None


# ============================================================================
# Hook Driver
# ============================================================================


def activity_path() -> str:
    """The session activity cache shared by hooks and watchers."""
    return os.path.join(os.path.dirname(get_config().cache_path), "activity.json")


def deliver_report(payload: dict[str, Any], cwd: str, observed_at: str, *, is_start: bool = False, heartbeat: bool = False) -> None:
    """Send one report to every display with its cloud identity."""
    try:
        context: dict | bool = cloud_context(str(payload.get("character", "vibemon")), str(payload.get("project", "")), cwd, observed_at=observed_at)
        if heartbeat:
            # A heartbeat repeats the current state: it refreshes liveness but
            # is not new activity and does not compete for display focus.
            context["heartbeat"] = True
    except ValueError:
        print("[vibemon] Invalid account configuration; cloud reporting disabled for this event", file=sys.stderr)
        context = False
    send_to_all(payload, is_start, context)


def watch_session(args: list[str]) -> bool:
    """Watcher entry point: keep one session's open turn visible until it ends."""
    if len(args) != 1 or not args[0]:
        return False
    session_activity.watch(
        activity_path(), args[0],
        lambda beat: deliver_report(beat.payload, beat.cwd, beat.observed_at, heartbeat=beat.heartbeat),
    )
    return True


def run(
    event_state_map: dict[str, str],
    build_payload: Callable[[str, str, str, dict[str, Any]], dict[str, Any]],
    start_event: str,
    argv_event_fallback: bool = False,
    event_aliases: dict[str, str] | None = None,
    refine: Callable[[str, dict[str, Any], str], Transition | None] | None = None,
    locate_transcript: Callable[[dict[str, Any]], str] | None = None,
) -> None:
    """Hook entry point, driven by a per-tool adapter.

    - event_state_map: the tool's hook-event → state mapping
    - build_payload(state, tool, project, data): builds the status payload;
      `data` is the parsed stdin event for tools that carry extra fields
      (e.g. Codex includes the active model)
    - start_event: the event that anchors desktop auto-launch
    - argv_event_fallback: treat a non-command first argv as the event name
      when stdin carries no hook_event_name (Kiro hook registrations pass the
      event name as the first argument, e.g. `vibemon.py promptSubmit`)
    - event_aliases: normalize a tool's payload event names before mapping
    - refine(event, data, state): provider-specific transition, or None to
      skip the event before metadata or delivery
    - locate_transcript(data): the session transcript path, for a tool whose
      payload carries no transcript_path, or "" when there is none
    """
    argv_event = ""
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        args = sys.argv[2:]
        result = handle_command(cmd, args)
        if result is not None:
            sys.exit(0 if result else 1)
        if argv_event_fallback:
            argv_event = cmd

    if os.environ.get("VIBEMON_SUPPRESS_HOOKS") == "1":
        # Set by VibeMon's own usage-refresher when it spawns
        # `claude -p "/usage"` to refresh the plan-usage cache — that
        # subprocess is a real Claude Code session and would otherwise report
        # status here under a ".vibemon" project (its cwd). Checked only after
        # argv dispatch so explicit `--status`/`--lock` commands still run.
        debug_log("Hook suppressed (VIBEMON_SUPPRESS_HOOKS=1)")
        return

    # Read and parse input once
    data = parse_json(read_input())

    # Extract fields from parsed data
    event_name = data.get("hook_event_name", "") or argv_event or "Unknown"
    if not isinstance(event_name, str):
        return
    if event_aliases:
        event_name = event_aliases.get(event_name, event_name)
    data = {**data, "hook_event_name": event_name}
    tool_name = data.get("tool_name", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path", "")
    if not transcript_path and locate_transcript is not None:
        transcript_path = locate_transcript(data)
        data = {**data, "transcript_path": transcript_path}
    tool_name = tool_name if isinstance(tool_name, str) else ""
    cwd = cwd if isinstance(cwd, str) else ""
    transcript_path = transcript_path if isinstance(transcript_path, str) else ""

    # A session working inside ~/.vibemon is VibeMon's own plumbing (the
    # `claude -p "/usage"` subprocess usage.py spawns with that cwd), never a
    # user project. Skip reporting regardless of VIBEMON_SUPPRESS_HOOKS so
    # spawners that don't set the env var (older Desktop apps, manual
    # usage.py runs) can't surface a phantom ".vibemon" project.
    vibemon_home = os.path.realpath(os.path.expanduser("~/.vibemon"))
    if cwd and os.path.realpath(cwd) == vibemon_home:
        debug_log("Hook skipped (cwd is the VibeMon home dir)")
        return

    transition = get_transition(event_name, data, event_state_map, refine)
    if transition is None:
        debug_log(f"Event not mapped, skipping: {event_name}")
        return
    # Stamp before git discovery and usage metadata, which can finish after a
    # newer hook; late delivery then cannot replace newer activity.
    path = activity_path()
    report = session_activity.record(path, data, transition)
    if report is None:
        debug_log(f"Event settles no open turn, skipping: {event_name}")
        return
    project_name = get_project_name(cwd, transcript_path)

    debug_log(f"Event: {event_name}, Tool: {tool_name}, Project: {project_name}")

    payload = build_payload(report.state, tool_name, project_name, data)
    session = data.get("session_id")
    if isinstance(session, str) and session and report.state in session_activity.ACTIVE_STATES:
        # Only an open turn needs what a heartbeat repeats.
        agent = session_activity.agent_process() if report.watch else None
        session_activity.remember_payload(path, session, payload, cwd, agent)
        if agent is not None:
            session_activity.start_watcher(os.path.abspath(__file__), session)

    deliver_report(payload, cwd, report.observed_at, is_start=event_name == start_event)


if __name__ == "__main__":
    result = handle_command(sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else False
    sys.exit(0 if result else 1)
