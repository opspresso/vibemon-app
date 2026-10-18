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
from account_service import AccountService, identity_hint, session_key
from account_sources import LocalAccountSource, tool_profile
from cache_io import projects_cache_path
from account_store import JsonAccountStore

_current: ContextVar = ContextVar('vibemon_account', default=None)
_source = LocalAccountSource()


def provider_name(character: str) -> str:
    return {'clawd': 'claude', 'claw': 'openclaw'}.get(character, character)


def registry_path() -> str:
    return str(Path.home() / '.vibemon' / 'accounts.json')


def profile_context(provider: str, root: str | None = None, hint: dict | None = None):
    target = tool_profile(provider, root=root)
    hint = identity_hint(hint)
    if provider == 'openclaw':
        target = replace(target, context=hint.get('agent_id') or 'main')
    elif provider == 'kiro':
        target = replace(target, context=hint.get('runtime') or 'kiro-ide')
    return target, hint


def event_context(provider: str, data: dict) -> dict:
    # Import at the composition boundary: session_activity uses observation_time.
    from session_activity import agent_process
    parent = agent_process()
    hint = identity_hint(data.get('account_hint'))
    hint.pop('runtime_id', None)
    if parent is not None:
        hint['runtime_id'] = fingerprint('runtime-v1', str(parent['pid']), parent.get('name', ''), str(parent.get('generation') or ''))
    if provider == 'kiro':
        executable = Path((parent or {}).get('name', '').replace('\\', '/')).name.lower().removesuffix('.exe')
        hint['runtime'] = 'kiro-cli' if executable in ('kiro-cli', 'q') else 'kiro-ide'
    result = {**data, 'account_hint': hint}
    if not data.get('session_id') and data.get('hook_event_name') and parent is not None:
        result['session_id'] = f"process:{parent['pid']}:{data.get('cwd', '')}"
    return result


def prepare_account(provider: str, data: dict | None = None, root: str | None = None) -> AccountIdentity:
    data = event_context(provider, data or {})
    target, hint = profile_context(provider, root, data.get('account_hint'))
    service = AccountService(_source, JsonAccountStore(registry_path()))
    return service.bind(target, dict(os.environ), data.get('session_id'), data.get('hook_event_name', ''),
        data.get('cwd') if isinstance(data.get('cwd'), str) and Path(data['cwd']).is_dir() else None, hint, cache_path=projects_cache_path())


@contextmanager
def using_account(identity: AccountIdentity):
    token = _current.set({**(_current.get() or {}), identity.provider: identity})
    try: yield identity
    finally: _current.reset(token)


def current_account(provider: str) -> AccountIdentity:
    active = (_current.get() or {}).get(provider)
    if active is not None:
        return active
    ident = os.environ.get(f'VIBEMON_{provider.upper()}_ACCOUNT_ID') or os.environ.get('VIBEMON_ACCOUNT_ID')
    label = os.environ.get(f'VIBEMON_{provider.upper()}_ACCOUNT_NAME') or os.environ.get('VIBEMON_ACCOUNT_NAME')
    if ident:
        return named(provider, ident, label)
    identity = tool_profile(provider).unidentified()
    return AccountIdentity(provider, identity.id, label or identity.display_name, identity.kind, identity.evidence)


def activity_key(provider: str | AccountIdentity, session: str, root: str | None = None, hint: dict | None = None) -> str:
    provider = provider.provider if isinstance(provider, AccountIdentity) else provider
    target, hint = profile_context(provider, root, hint)
    return session_key(target, session, dict(os.environ), hint)


def inspect_account(provider: str) -> AccountIdentity:
    target, hint = profile_context(provider)
    return _source.resolve(target, dict(os.environ), None, hint)


def known_session_account(provider: str, session: str) -> str | None:
    """Do not attribute a transcript reused by several accounts to any one of them."""
    target, _ = profile_context(provider)
    entries = JsonAccountStore(registry_path()).read().get('sessions', {})
    identities = set()
    for entry in entries.values():
        if not isinstance(entry, dict) or entry.get('profile') != target.key or entry.get('sessionId') != session:
            continue
        try: identities.add(AccountIdentity.restore(entry.get('account')).id)
        except ValueError: continue
    return next(iter(identities)) if len(identities) == 1 else None


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
