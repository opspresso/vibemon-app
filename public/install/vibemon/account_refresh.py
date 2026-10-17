"""Refresh known profiles in isolated child environments, with a bounded total deadline."""
from __future__ import annotations

import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from account_identity import AccountIdentity
from account_sources import Profile, tool_profile
from account_store import JsonAccountStore

REFRESH_DEADLINE_SECONDS = 45
PROFILE_TIMEOUT_SECONDS = 20
CREDENTIAL_ENVIRONMENT = ('OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_KEYCHAIN_SERVICE')


def profile_environments(store, environment: dict, providers: set[str]) -> list[tuple[str, dict]]:
    """Keep each profile's settings and explicit labels; never copy another profile's keys."""
    profiles = store.read().get('profiles', {})
    targets = {}
    for value in profiles.values():
        if not isinstance(value, dict) or value.get('provider') not in providers:
            continue
        provider = value['provider']
        if not isinstance(value.get('root'), str) or not Path(value['root']).is_absolute():
            continue
        if not isinstance(value.get('instance'), str):
            continue
        target = Profile(provider, value['root'], value['instance'], value.get('explicit_home') is True, str(value.get('context') or ''))
        try: identity = AccountIdentity.restore(value.get('account'))
        except ValueError: continue
        if identity.provider != provider:
            continue
        targets[target.key] = (target, identity, value.get('cachePath'))
    for provider in providers:
        target = tool_profile(provider, environment)
        targets.setdefault(target.key, (target, None, None))

    result = []
    for target, identity, cache_path in targets.values():
        env = target.environment(environment)
        env['VIBEMON_INSTANCE_ID'] = target.instance
        if isinstance(cache_path, str) and Path(cache_path).is_absolute(): env['VIBEMON_CACHE_PATH'] = cache_path
        current = tool_profile(target.provider, environment)
        if target.key != current.key:
            for variable in CREDENTIAL_ENVIRONMENT: env.pop(variable, None)
        for variable in list(env):
            if variable in ('VIBEMON_ACCOUNT_ID', 'VIBEMON_ACCOUNT_NAME') or variable.startswith('VIBEMON_') and variable.endswith(('_ACCOUNT_ID', '_ACCOUNT_NAME')):
                env.pop(variable, None)
        if identity is not None and identity.kind == 'manual':
            env[f'VIBEMON_{target.provider.upper()}_ACCOUNT_ID'] = identity.id
            env[f'VIBEMON_{target.provider.upper()}_ACCOUNT_NAME'] = identity.display_name
        elif target.key == current.key:
            # A launcher can name the current profile before it was registered.
            for name in (f'VIBEMON_{target.provider.upper()}_ACCOUNT_ID', f'VIBEMON_{target.provider.upper()}_ACCOUNT_NAME', 'VIBEMON_ACCOUNT_ID', 'VIBEMON_ACCOUNT_NAME'):
                if environment.get(name): env[name] = environment[name]
        env['VIBEMON_SUPPRESS_HOOKS'] = '1'
        result.append((target.provider, env))
    return result


def refresh_profiles(script: str, registry: str, environment: dict, providers: set[str], max_age: int,
                     run=subprocess.run, now=time.monotonic) -> bool:
    store = JsonAccountStore(registry)
    jobs = profile_environments(store, environment, providers)
    attempts = store.read().get('refreshAttempts', {})
    def attempted(job):
        entry = attempts.get(tool_profile(job[0], job[1]).key)
        return entry.get('at', 0) if isinstance(entry, dict) and isinstance(entry.get('at'), (int, float)) else 0
    jobs.sort(key=attempted)
    deadline = now() + REFRESH_DEADLINE_SECONDS
    def refresh(job):
        provider, env = job
        remaining = deadline - now()
        if remaining <= 0: return False
        try:
            result = run([sys.executable, script, '--provider', provider, '--max-age', str(max_age)], env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=min(PROFILE_TIMEOUT_SECONDS, remaining), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            success = result.returncode == 0
        except (OSError, subprocess.SubprocessError):
            success = False
        key = tool_profile(provider, env).key
        try:
            store.update(lambda data: {**data, 'refreshAttempts': {**data.get('refreshAttempts', {}), key: {'at': time.time(), 'ok': success}}})
        except (OSError, ValueError):
            return False
        return success
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(refresh, jobs))
    return bool(results) and all(results)
