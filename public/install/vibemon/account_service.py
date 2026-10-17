"""Identity selection and session binding use cases behind source and storage ports."""
from __future__ import annotations

import time
from dataclasses import asdict
from account_identity import AccountIdentity, fingerprint, named, text

SESSION_AGE_SECONDS = 86400
MAX_SESSIONS = 1024


class AccountService:
    def __init__(self, source, store, now=time.time):
        self.source, self.store, self.now = source, store, now

    def resolve(self, target, environment: dict, cwd: str | None = None, hint: dict | None = None) -> AccountIdentity:
        ident = environment.get(f'VIBEMON_{target.provider.upper()}_ACCOUNT_ID') or environment.get('VIBEMON_ACCOUNT_ID')
        label = environment.get(f'VIBEMON_{target.provider.upper()}_ACCOUNT_NAME') or environment.get('VIBEMON_ACCOUNT_NAME')
        if ident:
            return named(target.provider, ident, label)
        identity = self.source.resolve(target, environment, cwd, hint)
        if label:
            identity = AccountIdentity(identity.provider, identity.id, label, identity.kind, identity.evidence)
        return identity

    def bind(self, target, environment: dict, session: str | None, event: str = '', cwd: str | None = None, hint: dict | None = None) -> AccountIdentity:
        """Freeze account ownership for a session; a new SessionStart may rebind a resume.

        Old heartbeat payloads retain their original account independently of
        this registry. Resolving credentials never runs inside the file lock.
        """
        session = text(session)
        key = fingerprint('session-v1', target.key, session) if session else None
        before = self.store.read()
        existing = before.get('sessions', {}).get(key) if key else None
        now = self.now()
        if event != 'SessionStart' and isinstance(existing, dict) and isinstance(existing.get('expiresAt'), (int, float)) and existing['expiresAt'] > now:
            try: return AccountIdentity.restore(existing.get('account'))
            except ValueError: pass
        identity = self.resolve(target, environment, cwd, hint)
        chosen = {'identity': identity}

        def save(current):
            sessions = {k: v for k, v in current.get('sessions', {}).items()
                if isinstance(v, dict) and isinstance(v.get('expiresAt'), (int, float)) and v['expiresAt'] > now}
            # Two first hooks can probe concurrently. The first committed
            # binding owns that session; subsequent activity must use it.
            winner = sessions.get(key) if key and event != 'SessionStart' else None
            if isinstance(winner, dict):
                try: chosen['identity'] = AccountIdentity.restore(winner.get('account'))
                except ValueError: pass
            identity = chosen['identity']
            if key:
                sessions[key] = {'account': identity.record(), 'profile': target.key, 'expiresAt': now + SESSION_AGE_SECONDS}
            sessions = dict(sorted(sessions.items(), key=lambda item: item[1]['expiresAt'], reverse=True)[:MAX_SESSIONS])
            profiles = dict(current.get('profiles', {}))
            previous = profiles.get(target.key, {})
            previous = previous if isinstance(previous, dict) else {}
            if not isinstance(previous.get('checkedAt'), (int, float)) or previous['checkedAt'] <= now:
                profiles[target.key] = {**asdict(target), 'key': target.key, 'account': identity.record(), 'checkedAt': now}
            return {'version': 1, 'profiles': profiles, 'sessions': sessions}

        self.store.update(save)
        return chosen['identity']
