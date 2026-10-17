"""Compose identity sources, local bindings and the public hook account context."""
from __future__ import annotations
import hashlib
import os
import socket
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from dataclasses import replace
from pathlib import Path

from account_identity import AccountIdentity, named, fingerprint
from account_service import AccountService, identity_hint
from account_sources import LocalAccountSource, tool_profile
from account_store import JsonAccountStore

_current: ContextVar = ContextVar('vibemon_account', default=None)
_source = LocalAccountSource()


def provider_name(character: str) -> str:
    return {'clawd': 'claude', 'claw': 'openclaw'}.get(character, character)


def registry_path() -> str:
    return str(Path.home() / '.vibemon' / 'accounts.json')


def prepare_account(provider: str, data: dict | None = None, root: str | None = None) -> AccountIdentity:
    data = data or {}
    target = tool_profile(provider, root=root)
    hint = identity_hint(data.get('account_hint'))
    if provider == 'openclaw':
        target = replace(target, context=hint.get('agent_id') or 'main')
    elif provider == 'kiro':
        target = replace(target, context=hint.get('runtime') or 'kiro-ide')
    service = AccountService(_source, JsonAccountStore(registry_path()))
    return service.bind(target, dict(os.environ), data.get('session_id'), data.get('hook_event_name', ''),
        data.get('cwd') if isinstance(data.get('cwd'), str) and Path(data['cwd']).is_dir() else None,
        hint)


@contextmanager
def using_account(identity: AccountIdentity):
    token = _current.set(identity)
    try: yield identity
    finally: _current.reset(token)


def current_account(provider: str) -> AccountIdentity:
    active = _current.get()
    if active is not None and active.provider == provider:
        return active
    ident = os.environ.get(f'VIBEMON_{provider.upper()}_ACCOUNT_ID') or os.environ.get('VIBEMON_ACCOUNT_ID')
    label = os.environ.get(f'VIBEMON_{provider.upper()}_ACCOUNT_NAME') or os.environ.get('VIBEMON_ACCOUNT_NAME')
    if ident:
        return named(provider, ident, label)
    identity = tool_profile(provider).unidentified()
    return AccountIdentity(provider, identity.id, label or identity.display_name, identity.kind, identity.evidence)


def activity_key(identity: AccountIdentity, session: str, root: str | None = None) -> str:
    return fingerprint('activity-v1', tool_profile(identity.provider, root=root).key, identity.id, session)


def account_id(provider: str) -> str:
    return current_account(provider).id


def cache_key(provider: str) -> str:
    if ':' in provider:
        return provider
    identity = account_id(provider)
    return provider if identity == 'default' else f'{provider}:{identity}'


def project_cache_key(project: str, provider: str = 'claude', cwd: str | None = None) -> str:
    workspace = str(Path(cwd or os.getcwd()).resolve())
    key = '\0'.join((workspace, project))
    return f'{cache_key(provider)}:{hashlib.sha256(key.encode()).hexdigest()}'


def observation_time(epoch_ms: int | None = None) -> str:
    moment = datetime.now(timezone.utc) if epoch_ms is None else datetime.fromtimestamp(epoch_ms / 1000, timezone.utc)
    return moment.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def cloud_context(character: str, project: str, cwd: str | None = None, observed_at: str | None = None,
                  identity: AccountIdentity | None = None, source_scope: str | None = None) -> dict:
    provider = provider_name(character)
    account = identity or current_account(provider)
    if account.provider != provider:
        raise ValueError('Account belongs to another coding tool')
    instance = os.environ.get('VIBEMON_INSTANCE_ID') or socket.gethostname()
    workspace = str(Path(cwd or os.getcwd()).resolve())
    parts = (provider, account.id, instance, workspace, project)
    key = '\0'.join(parts + ((source_scope,) if source_scope else ()))
    return {'account': account.public(), 'sourceId': 'agent:' + hashlib.sha256(key.encode()).hexdigest(),
        'observedAt': observed_at if observed_at is not None else observation_time()}
