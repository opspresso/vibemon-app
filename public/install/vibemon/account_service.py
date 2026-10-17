"""Identity selection and session binding use cases behind source and storage ports."""
from __future__ import annotations

import json
import time
from dataclasses import asdict
from account_identity import AccountIdentity, fingerprint, named, text

SESSION_TOUCH_SECONDS = 3600
MAX_SESSIONS = 1024


def identity_hint(value) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {key: clean for key in ['provider', 'credential_id', 'agent_id', 'revision', 'manual_id', 'manual_name', 'runtime', 'runtime_id']
        if (clean := text(value.get(key), 256)) is not None}


def session_key(target, session: str, environment: dict, hint: dict | None = None) -> str:
    ident = environment.get(f'VIBEMON_{target.provider.upper()}_ACCOUNT_ID') or environment.get('VIBEMON_ACCOUNT_ID') or ''
    return fingerprint('session-v1', target.key, session, ident, json.dumps(identity_hint(hint), sort_keys=True))


class AccountService:
    def __init__(self, source, store, now=time.time):
        self.source, self.store, self.now = source, store, now

    def resolve(self, target, environment: dict, cwd: str | None = None, hint: dict | None = None) -> AccountIdentity:
        hint = identity_hint(hint)
        if target.provider == 'openclaw' and hint.get('manual_id'):
            return named(target.provider, hint['manual_id'], hint.get('manual_name'))
        ident = environment.get(f'VIBEMON_{target.provider.upper()}_ACCOUNT_ID') or environment.get('VIBEMON_ACCOUNT_ID')
        label = environment.get(f'VIBEMON_{target.provider.upper()}_ACCOUNT_NAME') or environment.get('VIBEMON_ACCOUNT_NAME')
        if ident:
            return named(target.provider, ident, label)
        identity = self.source.resolve(target, environment, cwd, hint)
        if label:
            identity = AccountIdentity(identity.provider, identity.id, label, identity.kind, identity.evidence)
        return identity

    def bind(self, target, environment: dict, session: str | None, event: str = '', cwd: str | None = None, hint: dict | None = None, cache_path: str | None = None) -> AccountIdentity:
        """Freeze account ownership for a session; a new SessionStart may rebind a resume.

        Old heartbeat payloads retain their original account independently of
        this registry. Resolving credentials never runs inside the file lock.
        """
        session = text(session)
        hint = identity_hint(hint)
        key = session_key(target, session, environment, hint) if session else None
        before = self.store.read()
        existing = before.get('sessions', {}).get(key) if key else None
        now = self.now()
        identity = None
        if event != 'SessionStart' and isinstance(existing, dict):
            try: identity = AccountIdentity.restore(existing.get('account'))
            except ValueError: pass
            seen = existing.get('seenAt', existing.get('boundAt', 0))
            if identity and isinstance(seen, (int, float)) and now - seen < SESSION_TOUCH_SECONDS:
                return identity
        # Elapsed time cannot change a running session's owner. Retain the
        # bounded registry by last activity, and re-identify only a new start.
        probed = identity is None
        identity = identity or self.resolve(target, environment, cwd, hint)
        chosen = {'identity': identity}

        def save(current):
            sessions = {k: v for k, v in current.get('sessions', {}).items()
                if isinstance(v, dict) and isinstance(v.get('boundAt'), (int, float))}
            # Two first hooks can probe concurrently. The first committed
            # binding owns that session; subsequent activity must use it.
            winner = sessions.get(key) if key else None
            if event == 'SessionStart' and isinstance(winner, dict) and winner.get('boundAt', 0) <= now:
                winner = None
            if isinstance(winner, dict):
                try: chosen['identity'] = AccountIdentity.restore(winner.get('account'))
                except ValueError: pass
            identity = chosen['identity']
            if key and not isinstance(winner, dict):
                sessions[key] = {'account': identity.record(), 'profile': target.key, 'sessionId': session, 'boundAt': now, 'seenAt': now}
            if key and key in sessions:
                sessions[key] = {**sessions[key], 'seenAt': max(now, sessions[key].get('seenAt', now))}
            sessions = dict(sorted(sessions.items(), key=lambda item: item[1].get('seenAt', item[1]['boundAt']), reverse=True)[:MAX_SESSIONS])
            profiles = dict(current.get('profiles', {}))
            previous = profiles.get(target.key, {})
            previous = previous if isinstance(previous, dict) else {}
            if probed and (not isinstance(previous.get('checkedAt'), (int, float)) or previous['checkedAt'] <= now):
                profiles[target.key] = {**asdict(target), 'key': target.key, 'account': identity.record(), 'checkedAt': now, 'cachePath': cache_path}
            return {**current, 'version': 1, 'profiles': profiles, 'sessions': sessions}

        self.store.update(save)
        return chosen['identity']
