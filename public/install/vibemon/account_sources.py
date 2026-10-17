"""Bounded local provider adapters. Credentials never leave this process or enter records."""
from __future__ import annotations

import json
import os
import queue
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from account_identity import AccountIdentity, fingerprint, profile, text
from account_parsers import claude_account, codex_account, jwt_claims, kiro_account, opencode_connection

MAX_METADATA_BYTES = 1024 * 1024
PROBE_TIMEOUT_SECONDS = 3
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
HOME_VARIABLES = {'claude': 'CLAUDE_CONFIG_DIR', 'codex': 'CODEX_HOME', 'kiro': 'KIRO_HOME', 'opencode': 'OPENCODE_CONFIG_DIR', 'openclaw': 'OPENCLAW_STATE_DIR'}
DEFAULT_HOMES = {'claude': '.claude', 'codex': '.codex', 'kiro': '.kiro', 'opencode': '.config/opencode', 'openclaw': '.openclaw'}


@dataclass(frozen=True)
class Profile:
    provider: str
    root: str
    instance: str
    explicit_home: bool = False
    context: str = ""

    @property
    def key(self) -> str:
        return fingerprint('profile-v1', self.provider, self.instance, self.root, str(self.explicit_home), self.context)

    def environment(self, environment: dict[str, str]) -> dict[str, str]:
        result = dict(environment)
        if self.explicit_home:
            result[HOME_VARIABLES[self.provider]] = self.root
        else:
            result.pop(HOME_VARIABLES[self.provider], None)
        return result

    def unidentified(self, reason: str = 'Account not identified') -> AccountIdentity:
        label = f'{self.context or Path(self.root).name} @ {self.instance} · {reason}'
        return profile(self.provider, self.root + ('#explicit-home' if self.explicit_home else '') + ('#' + self.context if self.context else ''), self.instance, label)


def tool_profile(provider: str, environment: dict[str, str] | None = None, root: str | None = None) -> Profile:
    env = os.environ if environment is None else environment
    if provider not in HOME_VARIABLES:
        raise ValueError('Unsupported coding tool')
    home = Path(env.get('HOME') or env.get('USERPROFILE') or str(Path.home()))
    configured = env.get(HOME_VARIABLES[provider]) or root
    if provider == 'opencode' and not configured:
        configured = str(Path(env.get('XDG_CONFIG_HOME') or home / '.config') / 'opencode')
    default = home / DEFAULT_HOMES[provider]
    if configured and (configured == '~' or configured.startswith('~/')):
        configured = str(home / configured[2:]) if configured != '~' else str(home)
    location = Path(configured) if configured else default
    explicit = bool(env.get(HOME_VARIABLES[provider])) or location.resolve() != default.resolve()
    return Profile(provider, str(location.resolve()), text(env.get('VIBEMON_INSTANCE_ID')) or socket.gethostname(), explicit)


def read_json(path: Path, maximum: int = MAX_METADATA_BYTES) -> Any:
    try:
        with path.open('rb') as source:
            value = source.read(maximum + 1)
        if len(value) > maximum:
            return None
        return json.loads(value)
    except (OSError, ValueError, UnicodeError):
        return None


def command_json(arguments: list[str], environment: dict[str, str], cwd: str | None = None) -> Any:
    executable = shutil.which(arguments[0], path=environment.get('PATH'))
    if not executable:
        return None
    try:
        completed = subprocess.run([executable, *arguments[1:]], env=environment, cwd=cwd,
            stdin=subprocess.DEVNULL, capture_output=True, timeout=PROBE_TIMEOUT_SECONDS, creationflags=NO_WINDOW)
        if completed.returncode or len(completed.stdout) > MAX_METADATA_BYTES:
            return None
        return json.loads(completed.stdout)
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return None


def codex_auth(environment: dict[str, str], cwd: str | None = None) -> dict | None:
    """Ask the installed CLI to resolve its active auth, including OS keyring storage.

    Only initialize and read methods are sent. No thread, inference, login,
    refresh or logout request is made. Secret material stays in this adapter.
    """
    executable = shutil.which('codex', path=environment.get('PATH'))
    if not executable:
        return None
    process = None
    messages: queue.Queue = queue.Queue(maxsize=64)
    deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
    try:
        process = subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'], env=environment, cwd=cwd,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)

        def read():
            size = 0
            try:
                while True:
                    line = process.stdout.readline(MAX_METADATA_BYTES + 1)
                    size += len(line)
                    if not line or size > MAX_METADATA_BYTES:
                        break
                    try: value = json.loads(line)
                    except (ValueError, UnicodeError): continue
                    try: messages.put_nowait(value)
                    except queue.Full: break
            except (OSError, ValueError):
                pass
            try: messages.put_nowait(None)
            except queue.Full: pass

        threading.Thread(target=read, daemon=True).start()

        def request(ident, method, params):
            process.stdin.write((json.dumps({'id': ident, 'method': method, 'params': params}) + '\n').encode())
            process.stdin.flush()
            while True:
                item = messages.get(timeout=max(.001, deadline - time.monotonic()))
                if item is None:
                    return None
                if isinstance(item, dict) and item.get('id') == ident:
                    return item.get('result')

        if request(1, 'initialize', {'clientInfo': {'name': 'vibemon_identity', 'title': 'VibeMon', 'version': '1'}}) is None:
            return None
        process.stdin.write(b'{"method":"initialized"}\n'); process.stdin.flush()
        result = request(2, 'account/read', {'refreshToken': False})
        if not isinstance(result, dict) or result.get('requiresOpenaiAuth') is False:
            return None
        account = result.get('account')
        if not isinstance(account, dict) or account.get('type') not in ('chatgpt', 'apiKey'):
            return None
        # Read the CLI's selected credential, not a potentially obsolete
        # auth.json beside a newer keyring login. Email alone cannot tell
        # personal and team workspaces of the same person apart.
        current = request(3, 'getAuthStatus', {'includeToken': True, 'refreshToken': False})
        if not isinstance(current, dict) or current.get('authMethod') not in ('chatgpt', 'chatgptAuthTokens', 'apikey'):
            return None
        token = current.get('authToken')
        if current.get('authMethod') == 'apikey':
            return {'auth_mode': 'apikey', 'credential_ref': fingerprint('api-key-v1', 'codex', token)} if text(token, 65536) else None
        claims = jwt_claims(token)
        auth = claims.get('https://api.openai.com/auth')
        if not isinstance(auth, dict):
            return None
        return {'auth_mode': 'chatgpt', 'tokens': {'access_token': token, 'account_id': auth.get('chatgpt_account_id')}}
    except (OSError, ValueError, KeyError, queue.Empty, subprocess.SubprocessError):
        return None
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=.5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
            for stream in (process.stdin, process.stdout):
                if stream: stream.close()


class LocalAccountSource:
    """Ports are injectable so fixtures never inspect the operator's credentials."""
    def __init__(self, read=read_json, command=command_json, codex=codex_auth):
        self.read, self.command, self.codex = read, command, codex

    def resolve(self, target: Profile, environment: dict[str, str], cwd: str | None = None, hint: dict | None = None) -> AccountIdentity:
        env = target.environment(environment)
        identity = None
        if target.provider == 'codex':
            metadata = self.codex(env, cwd)
            identity = codex_account(metadata)
            if isinstance(metadata, dict) and metadata.get('auth_mode') == 'apikey' and text(metadata.get('credential_ref'), 64):
                reference = metadata['credential_ref']
                return profile('codex', target.root, target.instance, 'API key ' + reference[-8:], reference)
        elif target.provider == 'claude':
            root = Path(target.root)
            # Current Claude puts custom-profile state inside its config root;
            # the default profile retains the sibling ~/.claude.json location.
            candidates = [root / '.claude.json']
            default = Path(env.get('HOME') or env.get('USERPROFILE') or str(Path.home())) / '.claude'
            if not target.explicit_home and root == default.resolve():
                candidates.insert(0, default.parent / '.claude.json')
            has_metadata = False
            status = None
            for candidate in candidates:
                settings = self.read(candidate)
                if not isinstance(settings, dict) or not isinstance(settings.get('oauthAccount'), dict):
                    continue
                has_metadata = True
                # Even `auth status` initializes a never-used Claude profile.
                # Inspect an existing login only; discovery must not create one.
                status = self.command(['claude', 'auth', 'status', '--json'], env, cwd)
                identity = claude_account(status, settings)
                if identity: break
            if not identity:
                mode = status.get('authMethod') if isinstance(status, dict) else None
                for variable, method in [('ANTHROPIC_API_KEY', 'api_key'), ('ANTHROPIC_AUTH_TOKEN', 'api_key'), ('CLAUDE_CODE_OAUTH_TOKEN', 'oauth_token')]:
                    secret = text(env.get(variable), 65536)
                    if secret and (not has_metadata or mode == method):
                        reference = fingerprint('environment-credential-v1', 'claude', variable, secret)
                        return profile('claude', target.root, target.instance, 'API credential ' + reference[-8:], reference)
        elif target.provider == 'kiro':
            if (hint or {}).get('runtime') == 'kiro-cli':
                identity = kiro_account(self.command(['kiro-cli', 'whoami', '--format', 'json'], env, cwd))
        elif target.provider == 'opencode':
            backend = text((hint or {}).get('provider'), 128)
            if backend:
                identity = opencode_connection(self.command(['opencode', 'auth', 'list', '--format', 'json'], env, cwd),
                    backend, target, text((hint or {}).get('credential_id'), 256))
        elif target.provider == 'openclaw':
            return target.unidentified()
        return identity or target.unidentified()
