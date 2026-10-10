"""Shared plan-usage parsing and cache helpers for VibeMon."""

from __future__ import annotations

from account_context import cache_key

import json
import math
import os
import re
import time
from datetime import datetime
from typing import Any

from cache_io import update_json_cache


def reverse_jsonl(path: str):
    """Read complete JSONL records from at most the newest 1 MiB."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            position = f.tell()
            remainder = b""
            remaining_bytes = 1024 * 1024
            while position > 0 and remaining_bytes > 0:
                chunk_size = min(65536, position, remaining_bytes)
                remaining_bytes -= chunk_size
                position -= chunk_size
                f.seek(position)
                remainder = f.read(chunk_size) + remainder
                lines = remainder.split(b"\n")
                remainder = lines[0]
                for line in reversed(lines[1:]):
                    if not line:
                        continue
                    try:
                        value = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    if isinstance(value, dict):
                        yield value
            if position == 0 and remainder:
                try:
                    value = json.loads(remainder)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return
                if isinstance(value, dict):
                    yield value
    except OSError:
        return



def parse_epoch(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        pass
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(text).timestamp()
        except ValueError:
            return None
    return None


def normalize_percent(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return round(number) if math.isfinite(number) and 0 <= number <= 100 else None


def is_usage_bucket(name: Any) -> bool:
    """True for usage bucket keys: "session" plus any "week_*" bucket
    ("week_all", or a model-scoped bucket like "week_fable")."""
    return name == "session" or (isinstance(name, str) and name.startswith("week_"))


def week_bucket_key(label: Any) -> str | None:
    """Cache bucket key for a model-scoped weekly limit label, e.g.
    "Fable" -> "week_fable", "Sonnet only" -> "week_sonnet"."""
    if not isinstance(label, str):
        return None
    slug = re.sub(r"\s+only$", "", label.strip().lower())
    slug = re.sub(r"[^a-z0-9]+", "_", slug).strip("_")
    if not slug or slug == "all_models":
        return None
    return f"week_{slug}"


def model_week_bucket(bucket_data: Any) -> dict[str, Any] | None:
    """The model-scoped weekly bucket (any `week_*` key other than
    `week_all`) from a provider's cache entry — the one with the highest
    pct when several exist, since that's the binding limit."""
    if not isinstance(bucket_data, dict):
        return None
    best: dict[str, Any] | None = None
    for name, bucket in bucket_data.items():
        if name == "week_all" or not is_usage_bucket(name) or name == "session":
            continue
        if not isinstance(bucket, dict) or not isinstance(bucket.get("pct"), int):
            continue
        if best is None or bucket["pct"] > best["pct"]:
            best = bucket
    return best


def build_bucket(bucket: Any, pct_key: str, reset_key: str = "resets_at") -> dict[str, Any] | None:
    """Build a `{pct, resets_at}` cache bucket from a raw API/log window.

    Single source for the per-path field names: `utilization` (Claude legacy
    fields), `percent` (Claude limits[]), `used_percent` (Codex), and
    `used_percentage` (Claude Code rate_limits). Codex's live API alone
    names the reset field `reset_at` (singular) — every other path uses
    `resets_at`.
    """
    if not isinstance(bucket, dict):
        return None
    try:
        pct = normalize_percent(bucket.get(pct_key))
    except (TypeError, ValueError):
        return None
    if pct is None:
        return None
    entry: dict[str, Any] = {"pct": pct}
    resets_at = parse_epoch(bucket.get(reset_key))
    if resets_at is not None:
        entry["resets_at"] = resets_at
    return entry


def usage_from_rate_limits(data: dict[str, Any]) -> dict[str, Any] | None:
    rate_limits = data.get("rate_limits")
    if not isinstance(rate_limits, dict):
        return None

    session = build_bucket(rate_limits.get("five_hour"), "used_percentage")
    week = build_bucket(rate_limits.get("seven_day"), "used_percentage")
    if session is None and week is None:
        return None
    result: dict[str, Any] = {}
    if session is not None:
        result["session"] = session
    if week is not None:
        result["week_all"] = week
    return result


def parse_usage_output(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if not text:
        return result

    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        match = re.search(r"(\d+(?:\.\d+)?)%\s+used", line)
        pct = normalize_percent(match.group(1)) if match else None
        if pct is None:
            continue
        entry: dict[str, Any] = {"pct": pct}
        reset_match = re.search(r"resets\s+(.+?)\s*$", line)
        if reset_match:
            entry["resets"] = reset_match.group(1).strip()
        if "current session:" in low:
            result["session"] = entry
            continue
        week_match = re.search(r"current week \(([^)]+)\):", line, re.IGNORECASE)
        if not week_match:
            continue
        scope = week_match.group(1).strip()
        if scope.lower() == "all models":
            result["week_all"] = entry
            continue
        key = week_bucket_key(scope)
        if key:
            label = re.sub(r"\s+only$", "", scope, flags=re.IGNORECASE).strip()
            result[key] = {**entry, "label": label}
    return result


def load_usage_cache(cache_path: str) -> dict[str, Any] | None:
    try:
        with open(cache_path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return None


def provider_updated_at(cache: dict[str, Any] | None, provider: str) -> float:
    if not isinstance(cache, dict):
        return 0
    data = cache.get(cache_key(provider))
    if isinstance(data, dict):
        try:
            return float(data.get("updated_at", cache.get("ts", 0)))
        except (TypeError, ValueError):
            return 0
    return 0


def get_fresh_provider(
    cache: dict[str, Any] | None,
    provider: str,
    max_age_seconds: int,
    now: float | None = None,
) -> dict[str, Any] | None:
    if not isinstance(cache, dict):
        return None
    data = cache.get(cache_key(provider))
    if not isinstance(data, dict):
        return None
    current_time = time.time() if now is None else now
    observed_at = provider_updated_at(cache, provider)
    if observed_at <= 0 or current_time - observed_at > max_age_seconds:
        return None

    fresh = dict(data)
    for bucket_name in [name for name in data if is_usage_bucket(name)]:
        bucket = data.get(bucket_name)
        if not isinstance(bucket, dict):
            continue
        try:
            bucket_updated_at = float(bucket.get("updated_at", observed_at))
        except (TypeError, ValueError):
            bucket_updated_at = 0
        resets_at = parse_epoch(bucket.get("resets_at"))
        if (
            bucket_updated_at <= 0
            or current_time - bucket_updated_at > max_age_seconds
            or (resets_at is not None and resets_at <= current_time)
        ):
            fresh.pop(bucket_name, None)

    if not any(is_usage_bucket(name) and isinstance(value, dict) for name, value in fresh.items()):
        return None
    return fresh


def save_usage_cache(
    cache_path: str,
    updates: dict[str, Any],
    now: float | None = None,
    replace: bool = False,
) -> bool:
    """Merge provider updates into the cache file.

    `replace=False` (default) keeps existing usage buckets that the update
    doesn't mention — required for partial writers like statusline.py, whose
    rate_limits payload only carries session/week_all and must not wipe the
    model-scoped weekly buckets written by the API path. `replace=True` is
    for authoritative full-view refreshes (usage.py): usage buckets absent
    from the update are dropped, so a bucket the provider stopped reporting
    can't linger stale and force a network refresh on every run.

    In both modes, usage buckets whose `resets_at` has already passed are
    pruned — they are dead weight the read path ignores anyway.
    """
    def update(payload):
        updated_at = int(time.time() if now is None else now)
        for provider, value in updates.items():
            provider = cache_key(provider)
            if not isinstance(value, dict):
                continue
            observed_at = parse_epoch(value.get("updated_at", updated_at))
            if observed_at is None or observed_at <= 0 or observed_at > updated_at + 30:
                continue
            existing = payload.get(provider)
            merged = dict(existing) if isinstance(existing, dict) else {}
            if replace:
                for key in [name for name in merged if is_usage_bucket(name)]:
                    if key not in value:
                        merged.pop(key)
            for key, item in value.items():
                if is_usage_bucket(key) and isinstance(item, dict):
                    merged[key] = {**item, "updated_at": observed_at}
                else:
                    merged[key] = item
            for key in [name for name in merged if is_usage_bucket(name)]:
                bucket = merged[key]
                resets_at = parse_epoch(bucket.get("resets_at")) if isinstance(bucket, dict) else None
                if resets_at is not None and resets_at <= updated_at:
                    merged.pop(key)
            payload[provider] = {**merged, "updated_at": observed_at}
        # Retain ts for older installed hooks; freshness decisions use the
        # provider-level updated_at above.
        payload["ts"] = updated_at
        return payload

    return update_json_cache(cache_path, update)
