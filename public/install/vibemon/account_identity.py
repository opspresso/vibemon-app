"""Account identity rules. No filesystem, process, credential-store or HTTP access."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

PROVIDERS = {"claude": "Claude Code", "codex": "Codex", "kiro": "Kiro", "opencode": "OpenCode", "openclaw": "OpenClaw"}
KINDS = frozenset({"account", "credential", "profile", "manual"})


def text(value: Any, maximum: int = 512) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        return None
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return None
    return value.strip()


def fingerprint(*parts: str) -> str:
    """Versioned, unambiguous identity encoding, independent of paths and delimiters."""
    return hashlib.sha256(json.dumps(list(parts), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", value) is not None


@dataclass(frozen=True)
class AccountIdentity:
    provider: str
    id: str
    display_name: str
    kind: str
    evidence: str

    def __post_init__(self):
        if not isinstance(self.provider, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", self.provider) or not valid_id(self.id):
            raise ValueError("Invalid monitoring account identity")
        if self.kind not in KINDS or not text(self.display_name, 128) or not text(self.evidence, 64):
            raise ValueError("Invalid monitoring account description")

    def public(self) -> dict[str, str]:
        return {"provider": self.provider, "id": self.id, "displayName": self.display_name}

    def record(self) -> dict[str, str]:
        return {**self.public(), "kind": self.kind, "evidence": self.evidence}

    @classmethod
    def restore(cls, value: Any) -> AccountIdentity:
        if not isinstance(value, dict):
            raise ValueError("Invalid saved account")
        return cls(value.get("provider", ""), value.get("id", ""), value.get("displayName", ""), value.get("kind", ""), value.get("evidence", ""))


def named(provider: str, ident: str, name: str | None = None) -> AccountIdentity:
    return AccountIdentity(provider, ident, name or f"{provider} {ident}", "manual", "explicit")


def authenticated(provider: str, subject: str, organization: str, label: str | None, evidence: str) -> AccountIdentity:
    if not text(subject) or (organization and not text(organization)):
        raise ValueError("Missing account subject")
    ident = "auto:" + fingerprint("account-v1", provider, subject, organization)
    name = label or f"{PROVIDERS.get(provider, provider)} {ident[-8:]}"
    return AccountIdentity(provider, ident, name[:128], "account", evidence)


def profile(provider: str, root: str, instance: str, label: str, credential: str = "") -> AccountIdentity:
    """A profile/credential identifies local configuration, never an inferred person."""
    kind = "credential" if credential else "profile"
    ident = kind + ":" + fingerprint("profile-v1", provider, instance, root, credential)
    return AccountIdentity(provider, ident, f"{PROVIDERS.get(provider, provider)} · {label}"[:128], kind, "local-profile")
