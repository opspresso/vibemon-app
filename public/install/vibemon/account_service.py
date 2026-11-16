"""Identity selection and session binding use cases behind source and storage ports."""
from __future__ import annotations

import json
import time
from dataclasses import asdict
from account_identity import AccountIdentity, fingerprint, named, text

SESSION_TOUCH_SECONDS = 3600
# A session that starts before its login can be identified (for example, the
# tool asks the person to sign in) binds a provisional profile identity. Later
# events recheck that login at most this often.
PROVISIONAL_RECHECK_SECONDS = 60
MAX_SESSIONS = 1024
MAX_REPLACED = 8


def provisional(identity: AccountIdentity) -> bool:
    """A profile identity names local configuration only; no login was identified."""
    return identity.kind == 'profile'


def restore_all(values) -> list[AccountIdentity]:
    result = []
    for value in values if isinstance(values, list) else []:
        try: result.append(AccountIdentity.restore(value))
        except ValueError: continue
    return result


def replaced_records(identities: list[AccountIdentity]) -> list[dict[str, str]]:
    """The newest MAX_REPLACED distinct identities, oldest first."""
    unique = {}
    for identity in identities:
        unique.pop(identity.id, None)
        unique[identity.id] = identity
    return [identity.record() for identity in list(unique.values())[-MAX_REPLACED:]]


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

    def bind(self, target, environment: dict, session: str | None, event: str = '', cwd: str | None = None, hint: dict | None = None, cache_path: str | None = None, recheck: bool = True) -> AccountIdentity:
        """Freeze account ownership for a session; a new SessionStart may rebind a resume.

        An identified account never changes during a session. A provisional
        binding is rechecked at most once per PROVISIONAL_RECHECK_SECONDS when
        `recheck` is set. Once the login is identified, the session moves to
        that account, and the provisional identity stays listed under
        `replaced` until the caller removes what was reported under it. Before
        the login completes, the tool cannot use any account, so the session's
        activity belongs to the identified account.

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
        stale = None
        if event != 'SessionStart' and isinstance(existing, dict):
            try: identity = AccountIdentity.restore(existing.get('account'))
            except ValueError: pass
            seen = existing.get('seenAt', existing.get('boundAt', 0))
            checked = existing.get('checkedAt', existing.get('boundAt', 0))
            if identity and recheck and provisional(identity) and isinstance(checked, (int, float)) and now - checked >= PROVISIONAL_RECHECK_SECONDS:
                stale = identity
            elif identity and isinstance(seen, (int, float)) and now - seen < SESSION_TOUCH_SECONDS:
                return identity
        # Elapsed time cannot change an identified session's owner. Retain the
        # bounded registry by last activity, and re-identify only a new start
        # or a due provisional binding.
        probed = identity is None or stale is not None
        upgraded = None
        if probed:
            resolved = self.resolve(target, environment, cwd, hint)
            if identity is None:
                identity = resolved
            elif not provisional(resolved):
                identity = upgraded = resolved
        chosen = {'identity': identity}

        def save(current):
            sessions = {k: v for k, v in current.get('sessions', {}).items()
                if isinstance(v, dict) and isinstance(v.get('boundAt'), (int, float))}
            # Two first hooks can probe concurrently. The first committed
            # binding owns that session; subsequent activity must use it.
            prior = sessions.get(key) if key else None
            winner = prior
            if event == 'SessionStart' and isinstance(winner, dict) and winner.get('boundAt', 0) <= now:
                winner = None
            saved = None
            if isinstance(winner, dict):
                try: saved = chosen['identity'] = AccountIdentity.restore(winner.get('account'))
                except ValueError: pass
            if key and isinstance(winner, dict) and stale is not None and saved is not None and saved.id == stale.id:
                # Only the provisional binding read above may change. A
                # concurrent hook that already moved it keeps its account.
                entry = {**winner, 'checkedAt': now}
                if upgraded is not None:
                    entry.update(account=upgraded.record(), replaced=replaced_records([*restore_all(winner.get('replaced')), stale]))
                    chosen['identity'] = upgraded
                sessions[key] = entry
            identity = chosen['identity']
            if key and not isinstance(winner, dict):
                sessions[key] = {'account': identity.record(), 'profile': target.key, 'sessionId': session, 'boundAt': now, 'seenAt': now}
                # A resume keeps sources that still need removal, and an
                # identified resume of a provisional session replaces it.
                carried = restore_all(prior.get('replaced')) if isinstance(prior, dict) else []
                previous = restore_all([prior.get('account')]) if isinstance(prior, dict) else []
                carried += [value for value in [*previous, *([stale] if stale else [])]
                    if provisional(value) and not provisional(identity) and value.id != identity.id]
                if carried:
                    sessions[key]['replaced'] = replaced_records(carried)
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

    def replaced(self, target, environment: dict, session: str | None, hint: dict | None = None) -> list[AccountIdentity]:
        """Provisional identities that the session reported under before its login was identified."""
        session = text(session)
        if not session:
            return []
        entry = self.store.read().get('sessions', {}).get(session_key(target, session, environment, identity_hint(hint)))
        return restore_all(entry.get('replaced')) if isinstance(entry, dict) else []

    def forget_replaced(self, target, environment: dict, session: str | None, ids, hint: dict | None = None) -> None:
        """Stop listing provisional identities whose reported activity was removed."""
        session, ids = text(session), set(ids)
        if not session or not ids:
            return
        key = session_key(target, session, environment, identity_hint(hint))

        def save(current):
            sessions = dict(current.get('sessions', {}))
            entry = sessions.get(key)
            if not isinstance(entry, dict) or not isinstance(entry.get('replaced'), list):
                return current
            remaining = [value for value in entry['replaced'] if not (isinstance(value, dict) and value.get('id') in ids)]
            sessions[key] = {**entry, 'replaced': remaining} if remaining else {name: value for name, value in entry.items() if name != 'replaced'}
            return {**current, 'sessions': sessions}

        self.store.update(save)
