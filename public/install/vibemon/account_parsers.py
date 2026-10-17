"""Pure adapters from provider metadata to monitoring identities. Never return tokens."""
from __future__ import annotations

import base64
import json
from typing import Any
from account_identity import AccountIdentity, authenticated, text


def jwt_claims(value: Any) -> dict:
    """Read local identity metadata, not a signature check or authorization decision."""
    if not isinstance(value, str) or len(value) > 65536:
        return {}
    parts = value.split(".")
    if len(parts) != 3:
        return {}
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        return payload if isinstance(payload, dict) else {}
    except (ValueError, UnicodeError):
        return {}


def codex_account(value: Any) -> AccountIdentity | None:
    if not isinstance(value, dict) or value.get("auth_mode") not in (None, "chatgpt", "chatgptAuthTokens"):
        return None
    tokens = value.get("tokens")
    if not isinstance(tokens, dict) or not tokens.get("access_token"):
        return None
    claims = jwt_claims(tokens.get("id_token")) or jwt_claims(tokens.get("access_token"))
    auth = claims.get("https://api.openai.com/auth")
    if not isinstance(auth, dict):
        return None
    subject = text(auth.get("chatgpt_user_id")) or text(auth.get("user_id")) or text(claims.get("sub"))
    organization = text(tokens.get("account_id")) or text(auth.get("chatgpt_account_id"))
    if not subject or not organization:
        return None
    claimed = text(auth.get("chatgpt_account_id"))
    if claimed and claimed != organization:
        return None
    details = claims.get("https://api.openai.com/profile")
    email = text(claims.get("email"), 128) or (text(details.get("email"), 128) if isinstance(details, dict) else None)
    return authenticated("codex", subject, organization, f"Codex · {email}" if email else None, "codex-token-metadata")


def claude_account(status: Any, settings: Any) -> AccountIdentity | None:
    if not isinstance(status, dict) or status.get("loggedIn") is not True or status.get("authMethod") != "claude.ai":
        return None
    email, organization = text(status.get("email"), 128), text(status.get("orgId"))
    account = settings.get("oauthAccount") if isinstance(settings, dict) else None
    if not email or not organization or not isinstance(account, dict):
        return None
    subject = text(account.get("accountUuid"))
    if not subject or account.get("emailAddress") != email or account.get("organizationUuid") != organization:
        return None
    return authenticated("claude", subject, organization, f"Claude · {email}", "claude-status-and-profile")


def kiro_account(status: Any) -> AccountIdentity | None:
    if not isinstance(status, dict):
        return None
    email = text(status.get("email"), 128)
    method = text(status.get("accountType"), 64)
    if not email or not method:
        return None
    # whoami currently reports email rather than an immutable user ID. Keep
    # the authority in the key; a changed email intentionally creates a new identity.
    authority = text(status.get("startUrl")) or ""
    return authenticated("kiro", email, method + ":" + authority, f"Kiro · {email}", "kiro-whoami-email")


def opencode_connection(entries: Any, backend: str, target, credential_id: str | None = None) -> AccountIdentity | None:
    """OpenCode v2 lists its selected connection first; IDs identify saved connections.

    The CLI intentionally omits secret values. A saved connection is not
    necessarily a verified person, so its identity stays machine/profile scoped.
    """
    from account_identity import profile
    if not isinstance(entries, list) or not text(backend, 128):
        return None
    matches = [entry for entry in entries if isinstance(entry, dict) and entry.get('id') == backend]
    if len(matches) != 1 or not isinstance(matches[0].get('connections'), list):
        return None
    connections = matches[0]['connections']
    if credential_id:
        connections = [item for item in connections if isinstance(item, dict) and item.get('id') == credential_id]
    if not connections or not isinstance(connections[0], dict):
        return None
    connection = connections[0]
    ident = text(connection.get('id'), 256)
    label = text(connection.get('label'), 128)
    if connection.get('type') != 'credential' or not ident or not label:
        return None
    resolved = profile('opencode', target.root, target.instance, f'{backend} · {label}', backend + ':' + ident)
    return AccountIdentity(resolved.provider, resolved.id, resolved.display_name, 'credential', 'opencode-selected-connection')
