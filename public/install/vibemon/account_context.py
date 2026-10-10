"""Non-secret account identity shared by hooks, statusline, and usage refresh."""
from __future__ import annotations
import hashlib
import os
import re
import socket
from datetime import datetime, timezone
from pathlib import Path


def provider_name(character: str) -> str:
    return {"clawd": "claude", "claw": "openclaw"}.get(character, character)


def account_id(provider: str) -> str:
    value = os.environ.get(f"VIBEMON_{provider.upper()}_ACCOUNT_ID") or os.environ.get("VIBEMON_ACCOUNT_ID") or "default"
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", value):
        raise ValueError("Invalid VibeMon account ID")
    return value


def cache_key(provider: str) -> str:
    # Old default-account cache files remain readable. Named accounts never
    # fall back to that key, which could belong to another login.
    if ":" in provider:
        return provider
    identity = account_id(provider)
    return provider if identity == "default" else f"{provider}:{identity}"


def project_cache_key(project: str, provider: str = "claude", cwd: str | None = None) -> str:
    workspace = str(Path(cwd or os.getcwd()).resolve())
    key = "\0".join((workspace, project))
    return f"{cache_key(provider)}:{hashlib.sha256(key.encode()).hexdigest()}"


def cloud_context(character: str, project: str, cwd: str | None = None) -> dict:
    provider = provider_name(character)
    identity = account_id(provider)
    display_name = os.environ.get(f"VIBEMON_{provider.upper()}_ACCOUNT_NAME") or os.environ.get("VIBEMON_ACCOUNT_NAME") or f"{provider} {identity}"
    if not display_name.strip() or len(display_name) > 128:
        raise ValueError("Invalid VibeMon account name")
    instance = os.environ.get("VIBEMON_INSTANCE_ID") or socket.gethostname()
    workspace = str(Path(cwd or os.getcwd()).resolve())
    key = "\0".join((provider, identity, instance, workspace, project))
    return {
        "account": {"id": identity, "provider": provider, "displayName": display_name},
        "sourceId": "agent:" + hashlib.sha256(key.encode()).hexdigest(),
        "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
