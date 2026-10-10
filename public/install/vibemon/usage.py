#!/usr/bin/env python3
"""
VibeMon Plan-Usage Cache Refresher

Fetches Claude Code and Codex CLI plan usage and stores it in the shared
usage cache (~/.vibemon/cache/usage.json) — the same file that
~/.claude/statusline.py and the platform hooks read.

Claude: Anthropic's OAuth usage API (the same endpoint the official /usage
command uses, queried directly with the local Claude Code login token — no
active session required), falling back to a `claude -p "/usage"` subprocess
when a login token isn't available or the API call fails.

Codex: the same account-level usage API Codex CLI's own `/status` polls,
queried with the local Codex login token, falling back to the newest local
session log.

Intended to be run by the VibeMon Desktop app on startup or on a schedule, so
usage data stays fresh even when no Claude Code session is rendering the
statusline. Refreshes are serialized separately from the short cache-write
lock shared with statusline.py, so network I/O never blocks statusline writes.

Usage:
  python3 ~/.vibemon/usage.py                 # refresh now
  python3 ~/.vibemon/usage.py --max-age 600   # skip when cache is newer than 600s

Prints the resulting usage cache JSON to stdout. Exit code 0 on success
(refreshed, fresh enough, or another refresh already in flight), 1 on failure.
"""

from __future__ import annotations

from account_context import cache_key
from cache_io import cache_lock
from http_client import open_credential_request

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from usage_cache import (
    build_bucket,
    get_fresh_provider,
    is_usage_bucket,
    load_usage_cache as _load_usage_cache,
    parse_usage_output,
    parse_epoch,
    reverse_jsonl,
    save_usage_cache as _save_usage_cache,
    week_bucket_key,
)


# The Desktop app runs this refresher on a schedule; without CREATE_NO_WINDOW
# every helper process pops a console window on Windows.
NO_WINDOW_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)

CLAUDE_TIMEOUT_SECONDS = 30
CLAUDE_TOKEN_TIMEOUT_SECONDS = 3
CLAUDE_API_TIMEOUT_SECONDS = 8
CLAUDE_USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_CREDENTIALS_FILE = os.path.join(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"), ".credentials.json")

CODEX_AUTH_FILE = os.path.join(os.path.expanduser(os.environ.get("CODEX_HOME") or "~/.codex"), "auth.json")
CODEX_SESSIONS_DIR = os.path.join(os.path.expanduser(os.environ.get("CODEX_HOME") or "~/.codex"), "sessions")
CODEX_USAGE_API_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_FIVE_HOUR_MAX_SECONDS = 6 * 3600
CODEX_WEEK_MIN_SECONDS = 6 * 86400
CODEX_WEEK_MAX_SECONDS = 8 * 86400


# ============================================================================
# Cache Path Resolution
# ============================================================================


def get_usage_cache_path() -> str:
    """Resolve the usage cache path next to the shared projects cache.

    `VIBEMON_CACHE_PATH` wins when set, matching how the hooks
    (vibemon_core.get_config) and statusline.py resolve the same path; the
    cache_path setting in ~/.vibemon/config.json is the fallback so every
    VibeMon component agrees on where the cache directory lives.
    """
    cache_path = os.environ.get("VIBEMON_CACHE_PATH", "").strip()
    if not cache_path:
        cache_path = "~/.vibemon/cache/projects.json"
        config_file = os.path.expanduser("~/.vibemon/config.json")
        try:
            with open(config_file, encoding="utf-8") as f:
                config = json.load(f)
            if isinstance(config, dict) and config.get("cache_path"):
                cache_path = str(config["cache_path"])
        except (FileNotFoundError, json.JSONDecodeError, IOError):
            pass
    cache_dir = os.path.dirname(os.path.expanduser(cache_path))
    return os.path.join(cache_dir, "usage.json")


def available_providers(cache: dict[str, Any] | None = None) -> set[str]:
    """Return providers that have a local client/source or existing cache."""
    providers = {
        name for name in ("claude", "codex")
        if isinstance(cache, dict) and isinstance(cache.get(cache_key(name)), dict)
    }
    if shutil.which("claude") or os.path.isfile(CLAUDE_CREDENTIALS_FILE):
        providers.add("claude")
    if (
        shutil.which("codex")
        or os.path.isfile(CODEX_AUTH_FILE)
        or os.path.isdir(CODEX_SESSIONS_DIR)
    ):
        providers.add("codex")
    return providers


# ============================================================================
# Live Usage via Anthropic OAuth API (works without an active session)
# ============================================================================


def read_claude_token() -> str | None:
    """Read the local Claude Code OAuth access token, or None if unavailable.

    The token is returned only in memory — never logged, printed, or written
    to disk beyond its existing credential store.

    macOS: reads the Keychain item Claude Code itself logs into
    ("Claude Code-credentials"). Falls back to the plain-JSON credentials
    file (~/.claude/.credentials.json) for non-macOS installs and manual
    migrations that use the same token shape.
    """
    if sys.platform == "darwin" and (not os.environ.get("CLAUDE_CONFIG_DIR") or os.environ.get("CLAUDE_KEYCHAIN_SERVICE")):
        try:
            raw = subprocess.run(
                ["security", "find-generic-password", "-s", os.environ.get("CLAUDE_KEYCHAIN_SERVICE", "Claude Code-credentials"), "-w"],
                capture_output=True,
                text=True,
                timeout=CLAUDE_TOKEN_TIMEOUT_SECONDS,
                creationflags=NO_WINDOW_FLAGS,
            ).stdout.strip()
            token = json.loads(raw).get("claudeAiOauth", {}).get("accessToken")
            if token:
                return token
        except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError, AttributeError):
            pass
    try:
        with open(CLAUDE_CREDENTIALS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("claudeAiOauth", {}).get("accessToken")
    except (FileNotFoundError, json.JSONDecodeError, IOError, AttributeError):
        return None


def _usage_response(request) -> dict[str, Any] | None:
    """Read a bounded provider summary without exposing response or credential data."""
    try:
        with open_credential_request(request, timeout=CLAUDE_API_TIMEOUT_SECONDS) as response:
            raw = response.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            return None
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def fetch_claude_usage_live() -> dict[str, Any] | None:
    """Fetch plan usage directly from Anthropic's OAuth usage API — the same
    endpoint the official /usage command uses — via the local Claude Code
    login token. Unlike the `claude -p "/usage"` text fallback below, this
    needs no active session and returns an exact reset timestamp.

    Returns the same shape as parse_usage_output() (`session`/`week_all`
    entries with `pct` and `resets_at`, plus model-scoped weekly buckets like
    `week_fable` with a `label`), or None if a token isn't available, the
    request fails, or the response doesn't look like a usage payload.
    """
    token = read_claude_token()
    if not token:
        return None

    request = urllib.request.Request(
        CLAUDE_USAGE_API_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    data = _usage_response(request)
    if data is None:
        return None

    result: dict[str, Any] = {}

    # The limits[] array is the authoritative shape: it carries the session
    # and weekly-all buckets plus model-scoped weekly limits (kind
    # "weekly_scoped" with scope.model.display_name, e.g. "Fable") that the
    # legacy top-level fields don't expose.
    limits = data.get("limits")
    if isinstance(limits, list):
        for item in limits:
            if not isinstance(item, dict):
                continue
            entry = build_bucket(item, "percent")
            if entry is None:
                continue
            kind = item.get("kind")
            if kind == "session":
                result["session"] = entry
            elif kind == "weekly_all":
                result["week_all"] = entry
            elif kind == "weekly_scoped":
                scope = item.get("scope")
                model = scope.get("model") if isinstance(scope, dict) else None
                label = model.get("display_name") if isinstance(model, dict) else None
                key = week_bucket_key(label)
                if key:
                    result[key] = {**entry, "label": str(label).strip()}

    if "session" not in result:
        session = build_bucket(data.get("five_hour"), "utilization")
        if session is not None:
            result["session"] = session
    if "week_all" not in result:
        week = build_bucket(data.get("seven_day"), "utilization")
        if week is not None:
            result["week_all"] = week

    if not result:
        return None
    return result


# ============================================================================
# Codex: Live Usage via ChatGPT API (falls back to local session logs)
# ============================================================================


def read_codex_token() -> tuple[str, str] | None:
    """Read the local Codex CLI OAuth token, or None if unavailable.

    Codex CLI stores its login as a plain JSON file (no OS keychain
    involved), so this works the same way on every platform. The token is
    returned only in memory — never logged, printed, or written to disk
    beyond its existing credential store.
    """
    try:
        with open(CODEX_AUTH_FILE, encoding="utf-8") as f:
            data = json.load(f)
        tokens = data.get("tokens", {})
        token = tokens.get("access_token")
        if not token:
            return None
        return token, tokens.get("account_id", "")
    except (FileNotFoundError, json.JSONDecodeError, IOError, AttributeError):
        return None


def _codex_window_kind(bucket: Any) -> str | None:
    if not isinstance(bucket, dict):
        return None
    try:
        window_seconds = float(bucket.get("limit_window_seconds") or 0)
        if window_seconds <= 0:
            window_seconds = float(bucket.get("window_minutes") or 0) * 60
    except (TypeError, ValueError):
        return None
    if 0 < window_seconds <= CODEX_FIVE_HOUR_MAX_SECONDS:
        return "session"
    if CODEX_WEEK_MIN_SECONDS <= window_seconds <= CODEX_WEEK_MAX_SECONDS:
        return "week_all"
    return None


def fetch_codex_usage_live() -> dict[str, Any] | None:
    """Fetch plan usage directly from the same account-level usage endpoint
    Codex CLI's own `/status` polls, via the local Codex login token. Needs
    no active session and costs no tokens.

    Returns the same shape as fetch_claude_usage_live() (`session`/
    `week_all` entries with `pct` and `resets_at`), or None if a token isn't
    available, the request fails, or the response has no usable window.
    Credit-balance (premium) plans with no percentage window are skipped —
    there's no meaningful `pct` to report for those.
    """
    creds = read_codex_token()
    if creds is None:
        return None
    token, account_id = creds

    request = urllib.request.Request(
        CODEX_USAGE_API_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "ChatGPT-Account-Id": account_id,
            "User-Agent": "codex-cli",
        },
    )
    data = _usage_response(request)
    if data is None:
        return None

    rate_limit = data.get("rate_limit") if isinstance(data.get("rate_limit"), dict) else {}
    # primary_window/secondary_window aren't fixed to 5h/weekly — whichever
    # window is currently active comes back as "primary". Classify by its
    # actual length instead (mirrors claude-codex-battery's approach).
    session: dict[str, Any] | None = None
    week: dict[str, Any] | None = None
    for raw_window in (rate_limit.get("primary_window"), rate_limit.get("secondary_window")):
        if not isinstance(raw_window, dict):
            continue
        kind = _codex_window_kind(raw_window)
        if kind == "session":
            session = build_bucket(raw_window, "used_percent", reset_key="reset_at")
        elif kind == "week_all":
            week = build_bucket(raw_window, "used_percent", reset_key="reset_at")

    if session is None and week is None:
        return None

    result: dict[str, Any] = {}
    if session is not None:
        result["session"] = session
    if week is not None:
        result["week_all"] = week
    return result


def get_codex_usage_from_sessions() -> dict[str, Any] | None:
    """Fall back to the newest local Codex session log when the live API is
    unavailable — the same `rate_limits` snapshot Codex CLI itself writes to
    `~/.codex/sessions/**/*.jsonl` as it runs.

    Returns the same shape as fetch_codex_usage_live(), or None if no
    session log has a usable rate_limits entry.
    """
    if not os.path.isdir(CODEX_SESSIONS_DIR):
        return None

    files: list[tuple[str, float]] = []
    for dirpath, _dirnames, filenames in os.walk(CODEX_SESSIONS_DIR):
        for name in filenames:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, name)
            try:
                files.append((path, os.path.getmtime(path)))
            except OSError:
                continue
    files.sort(key=lambda item: item[1], reverse=True)

    for path, mtime in files[:8]:
        if time.time() - mtime > 1800:
            continue
        for obj in reverse_jsonl(path):
            observed_at = parse_epoch(obj.get("timestamp", mtime))
            if observed_at is None or not -30 <= time.time() - observed_at <= 1800:
                continue
            payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else obj
            rate_limits = payload.get("rate_limits") if isinstance(payload, dict) else None
            if not isinstance(rate_limits, dict):
                continue
            session = None
            week = None
            for raw_window in (rate_limits.get("primary"), rate_limits.get("secondary")):
                kind = _codex_window_kind(raw_window)
                if kind == "session":
                    session = build_bucket(raw_window, "used_percent")
                elif kind == "week_all":
                    week = build_bucket(raw_window, "used_percent")
            if session is None and week is None:
                continue
            result: dict[str, Any] = {"updated_at": observed_at}
            if session is not None:
                result["session"] = session
            if week is not None:
                result["week_all"] = week
            return result

    return None


# ============================================================================
# Cache I/O (same lock protocol as ~/.claude/statusline.py)
# ============================================================================


def load_usage_cache() -> dict[str, Any] | None:
    """Load cached plan usage, or None if missing/unreadable."""
    return _load_usage_cache(get_usage_cache_path())


def save_usage_cache(usage: dict[str, Any]) -> bool:
    """Persist a full-view refresh, stamping each provider independently.

    `replace=True`: every source here (usage API limits[], `claude -p
    "/usage"` text, Codex API/session log) reports the provider's complete
    bucket set, so buckets missing from it no longer exist and must be
    dropped — otherwise they linger stale and force a refresh every run.
    """
    return _save_usage_cache(get_usage_cache_path(), usage, replace=True)


def refresh_usage(providers: set[str] | None = None) -> str:
    """Refresh the usage cache for Claude and Codex independently, so one
    provider's outage doesn't block the other's refresh.

    Claude: Anthropic's OAuth usage API directly (no active session
    required), falling back to `claude -p "/usage"` when a token can't be
    found or the API call fails. Codex: the ChatGPT usage API, falling back
    to the newest local session log.

    A non-blocking refresh lock ensures only one network refresh runs at a
    time. Cache writes use a separate short-lived lock shared with
    statusline.py. Returns "refreshed", "busy" (another refresh in flight),
    "failed" (neither provider produced usable data), or "failed-to-save".
    """
    requested = providers or {"claude", "codex"}
    identity = hashlib.sha256("\0".join(cache_key(provider) for provider in sorted(requested)).encode()).hexdigest()
    lockfile = f"{get_usage_cache_path()}.{identity}.refresh.lock"
    claude_usage: dict[str, Any] | None = None
    codex_usage: dict[str, Any] | None = None
    try:
        with cache_lock(lockfile, timeout=0):
            claude_usage = fetch_claude_usage_live() if "claude" in requested else None
            if "claude" in requested and claude_usage is None:
                # Resolved to an absolute path first: on Windows `claude` is a
                # `claude.cmd` npm shim, and CreateProcess only appends `.exe` to a
                # bare name, so spawning it by name fails with FileNotFoundError.
                claude_cli = shutil.which("claude")
                try:
                    result = subprocess.run(
                        [claude_cli or "claude", "-p", "/usage"],
                        capture_output=True,
                        text=True,
                        timeout=CLAUDE_TIMEOUT_SECONDS,
                        creationflags=NO_WINDOW_FLAGS,
                        # This subprocess is a real Claude Code session; without the
                        # flag its installed hooks would report a phantom project.
                        env={**os.environ, "VIBEMON_SUPPRESS_HOOKS": "1"},
                    )
                    claude_usage = parse_usage_output(result.stdout) or None
                except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
                    claude_usage = None

            if "codex" in requested:
                codex_usage = fetch_codex_usage_live() or get_codex_usage_from_sessions()
            if not claude_usage and not codex_usage:
                return "failed"

            cache: dict[str, Any] = {}
            if claude_usage:
                cache["claude"] = claude_usage
            if codex_usage:
                cache["codex"] = codex_usage
            if not save_usage_cache(cache):
                return "failed-to-save"
            return "refreshed"
    except BlockingIOError:
        return "busy"
    except OSError:
        return "failed"



# ============================================================================
# Main
# ============================================================================


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh the VibeMon plan-usage cache from Anthropic's usage API "
        '(falls back to `claude -p /usage`)'
    )
    parser.add_argument(
        "--max-age",
        type=int,
        default=0,
        metavar="SECONDS",
        help="skip the refresh when the cache is newer than this (0 = always refresh)",
    )
    args = parser.parse_args()

    cache = load_usage_cache()
    candidates = available_providers(cache) or {"claude", "codex"}
    providers_to_refresh = set(candidates)
    if args.max_age > 0 and isinstance(cache, dict):
        now = time.time()
        providers_to_refresh = set()
        for name in candidates:
            original = cache.get(cache_key(name))
            fresh = get_fresh_provider(cache, name, args.max_age, now=now)
            if not isinstance(original, dict) or fresh is None:
                providers_to_refresh.add(name)
                continue
            # Any stored bucket that fell out of the fresh view is stale and
            # needs a refresh. This must cover model-scoped weekly buckets
            # (week_fable etc.): statusline.py keeps session/week_all fresh
            # from every render's rate_limits, so without this check the
            # provider always looks fresh and the model bucket would decay
            # past the stale threshold and vanish from the tray/bubble.
            if any(
                is_usage_bucket(key) and isinstance(original.get(key), dict) and key not in fresh
                for key in original
            ):
                providers_to_refresh.add(name)
        if not providers_to_refresh:
            print(json.dumps(cache))
            return 0

    outcome = refresh_usage(providers_to_refresh)
    if outcome in ("failed", "failed-to-save"):
        print(
            "failed to refresh usage: "
            + (
                "cache write failed"
                if outcome == "failed-to-save"
                else "no Claude or Codex source was available"
            ),
            file=sys.stderr,
        )
        return 1

    # "busy": another refresh is in flight; report the current cache as-is.
    cache = load_usage_cache()
    print(json.dumps(cache) if cache else "{}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
