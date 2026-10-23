#!/usr/bin/env python3
"""
VibeMon Installation Script
Installs hooks and configuration for Claude Code, Codex, Kiro (IDE and CLI), OpenClaw, or
opencode.

Usage (Interactive):
  curl -fsSL https://vibemon.io/install/install.py | python3

Usage (Non-interactive for AI agents):
  curl -fsSL https://vibemon.io/install/install.py | python3 - --claude
  curl -fsSL https://vibemon.io/install/install.py | python3 - --codex
  curl -fsSL https://vibemon.io/install/install.py | python3 - --kiro
  curl -fsSL https://vibemon.io/install/install.py | python3 - --openclaw
  curl -fsSL https://vibemon.io/install/install.py | python3 - --opencode
  # Supply VIBEMON_WRITE_TOKEN through the environment.
  curl -fsSL https://vibemon.io/install/install.py | python3 - --all --yes

Usage (Windows PowerShell):
  irm https://vibemon.io/install/install.ps1 | iex
  & ([scriptblock]::Create((irm https://vibemon.io/install/install.ps1))) --claude

Uninstall:
  curl -fsSL https://vibemon.io/install/install.py | python3 - --uninstall --claude

Exit status is 0 only when every selected platform installed cleanly. A
platform whose tool isn't present is reported as skipped and does not fail a
run where another selected platform succeeded; a run in which nothing
succeeded exits 1.

Downloaded files are checked against the published manifest.json before they
are written. install.py cannot verify itself — the Desktop app does that
against the manifest's "installer" hash before running it. When
VIBEMON_MANIFEST_SHA256 is set, only a manifest.json with that sha256 is
accepted; the Desktop app sets it for unattended updates.
"""

from __future__ import annotations

import argparse
import base64
import difflib
import hashlib
import json
import os
import re
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import webbrowser
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.error import HTTPError, URLError


IS_WINDOWS = os.name == "nt"

# Whether ANSI escapes reach the terminal. Windows consoles need VT processing
# turned on explicitly; when that fails, colored() degrades to plain text.
USE_COLOR = True


def setup_console() -> None:
    """Let this script's UTF-8 symbols and ANSI colors survive a Windows console.

    A default Korean/Western Windows console is cp949/cp1252, which cannot
    encode the ✓/✗/box-drawing characters used throughout — printing one
    raises UnicodeEncodeError and aborts the install. Switching the console to
    UTF-8 (code page 65001) and reconfiguring the streams fixes that; enabling
    ENABLE_VIRTUAL_TERMINAL_PROCESSING makes the color codes render instead of
    showing up as literal escapes. No-op everywhere else.
    """
    global USE_COLOR
    if IS_WINDOWS:
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleOutputCP(65001)
            handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                # 0x0004 = ENABLE_VIRTUAL_TERMINAL_PROCESSING
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
            else:
                # Not a console (redirected/piped). The Desktop app strips ANSI
                # from captured output either way, so plain text is safe here.
                USE_COLOR = False
        except (OSError, AttributeError, ValueError):
            USE_COLOR = False
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass


setup_console()


# Approve every prompt (--yes). This overwrites user-owned settings, so it is
# never implied by a platform flag.
AUTO_APPROVE = False

# No usable prompt available: a platform flag was given, or stdin isn't a TTY.
# Prompts resolve to their `unattended` answer instead of blocking on input().
NON_INTERACTIVE = False

# Sign in to VibeMon even when a token is saved (--login).
SIGN_IN = False

# Returned by an installer when its tool isn't present. Distinct from False so
# "Kiro isn't installed here" doesn't read as "the install failed".
SKIPPED = None


def setup_tty_input():
    """Reopen stdin from the console device to allow interactive input when piped."""
    if not sys.stdin.isatty():
        try:
            sys.stdin = open("CONIN$" if IS_WINDOWS else "/dev/tty", "r")
        except OSError:
            # In non-interactive mode, this is expected and OK
            pass


# VibeMon install files base URL
DOCS_BASE_URL = "https://vibemon.io/install"
MAX_DOWNLOAD_BYTES = 1024 * 1024


def checked_download_url(value: str) -> str:
    try:
        url = urlsplit(value)
        local = os.environ.get("VIBEMON_ALLOW_HTTP_LOCAL") == "1" and url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
        if any(ord(character) <= 32 for character in value) or (url.scheme != "https" and not local) or not url.hostname or url.username is not None or url.password is not None or "?" in value or "#" in value:
            raise ValueError()
        _ = url.port
    except ValueError:
        raise ValueError("Use an HTTPS installer URL without credentials, query, or fragment") from None
    return value.rstrip("/")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


urlopen = build_opener(NoRedirect()).open

# Shared configuration example file
CONFIG_EXAMPLE_FILE = "vibemon/config.example.json"

# Claude Code statusline display configuration example file
STATUSLINE_EXAMPLE_FILE = "vibemon/statusline.example.json"

# Kiro IDE 0.x / CLI 2.x hook definitions removed during migration. Current
# Kiro loads v1 configs from ~/.kiro/hooks/*.json. SessionEnd exists only in
# CLI V3, so it has its own file: a surface that rejects the trigger then
# skips that file and keeps the main lifecycle hooks.
KIRO_HOOK_CONFIG_FILES = ("kiro/hooks/vibemon.json", "kiro/hooks/vibemon-session-end.json")
LEGACY_KIRO_HOOK_FILES = (
    "vibemon-prompt-submit.kiro.hook",
    "vibemon-agent-stop.kiro.hook",
    "vibemon-file-created.kiro.hook",
    "vibemon-file-edited.kiro.hook",
    "vibemon-file-deleted.kiro.hook",
)

# All recognized statusline-only config keys, used to migrate values out of
# a pre-split single config.json into the new statusline.json.
STATUSLINE_KEYS = frozenset({
    "show_project", "show_git", "show_model", "show_tokens", "show_cost",
    "show_duration", "show_lines", "show_memory", "show_usage",
    "show_usage_reset", "show_version", "show_statusline",
})


def colored(text: str, color: str) -> str:
    """Return colored text for terminal output."""
    if not USE_COLOR:
        return text
    colors = {
        "red": "\033[91m",
        "green": "\033[92m",
        "yellow": "\033[93m",
        "blue": "\033[94m",
        "cyan": "\033[96m",
        "reset": "\033[0m",
    }
    return f"{colors.get(color, '')}{text}{colors['reset']}"


def ask_yes_no(question: str, default: bool = True, unattended: bool = None) -> bool:
    """Ask a yes/no question and return the answer.

    `unattended` is the answer used when there is no usable prompt
    (NON_INTERACTIVE without --yes); it falls back to `default`. Pass
    unattended=False for prompts that would replace user-owned configuration,
    so an unattended run leaves it alone instead of silently overwriting it.
    """
    if AUTO_APPROVE:
        return True
    if NON_INTERACTIVE:
        return default if unattended is None else unattended
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        try:
            answer = input(f"{question} {suffix}: ").strip().lower()
        except EOFError:
            return default if unattended is None else unattended
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("Please answer 'y' or 'n'")


TOKEN_PATTERN = re.compile(r"^vm_[a-f0-9]{60}$")


def validate_token(token: str) -> None:
    """Accept only the server-generated API credential format."""
    if not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token):
        raise ValueError("Enter a generated write token from your Web Account page")


# MARK: VibeMon sign-in (OAuth device authorization, RFC 8628)
#
# The shell shows a code. The person opens /device on the Web origin, signs in
# with Google or a confirmed email account, and approves the code. The shell then
# receives a write token named after the client and this host.

DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
MAX_RESPONSE_BYTES = 64 * 1024


class SignInError(RuntimeError):
    """VibeMon sign-in did not finish; the message says why."""


def post_form(url: str, fields: dict) -> tuple[int, dict]:
    """POST a form and return the status and JSON object. Redirects are refused."""
    request = Request(
        url, data=urlencode(fields).encode(), headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        status, raw = error.code, error.read(MAX_RESPONSE_BYTES + 1)
    except (URLError, OSError) as error:
        raise SignInError(f"Cannot reach {urlsplit(url).netloc}: {error}") from error
    try:
        body = json.loads(raw[:MAX_RESPONSE_BYTES].decode("utf-8")) if raw else {}
    except ValueError:
        body = {}
    return status, body if isinstance(body, dict) else {}


def device_name() -> str:
    """This host's name for the token name on Web Account."""
    return (platform.node() or "this computer").split(".")[0][:40]


def sign_in_to_web(origin: str, client_id: str, name: str = None, sleep=time.sleep, now=time.monotonic) -> str:
    """Return a write token after the person approves this shell on VibeMon."""
    origin = checked_download_url(origin)
    status, start = post_form(f"{origin}/api/oauth/device", {"client_id": client_id, "device_name": name or device_name()})
    code, user_code, uri = start.get("device_code"), start.get("user_code"), start.get("verification_uri")
    if status != 200 or not all(isinstance(value, str) for value in (code, user_code, uri)):
        raise SignInError(start.get("error_description") or f"VibeMon sign-in is unavailable (HTTP {status})")
    interval = max(1, int(start.get("interval", 5)))
    deadline = now() + int(start.get("expires_in", 600))
    complete = start.get("verification_uri_complete") if isinstance(start.get("verification_uri_complete"), str) else uri
    print(f"\n  {colored('Sign in to VibeMon', 'cyan')}")
    print(f"  1. Open {colored(uri, 'cyan')}")
    print(f"  2. Enter the code {colored(user_code, 'yellow')} and select Allow.")
    print("  Waiting for approval… (Ctrl+C to cancel)")
    try:
        if sys.stdout.isatty():
            webbrowser.open(complete)
    except webbrowser.Error:
        pass
    try:
        while now() < deadline:
            sleep(interval)
            status, reply = post_form(f"{origin}/api/oauth/token", {"grant_type": DEVICE_GRANT, "client_id": client_id, "device_code": code})
            token = reply.get("access_token")
            if status == 200 and isinstance(token, str) and TOKEN_PATTERN.fullmatch(token):
                print(f"  {colored('✓', 'green')} Signed in. Web Account lists this host's token.")
                return token
            error = reply.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            if error == "access_denied":
                raise SignInError("The request was denied on VibeMon")
            if error == "expired_token":
                break
            raise SignInError(reply.get("error_description") or f"VibeMon sign-in failed (HTTP {status})")
    except KeyboardInterrupt:
        raise SignInError("Sign-in was canceled") from None
    raise SignInError("The code expired. Run the installer again to sign in.")


def configure_token(config: dict, cli_token: str = None) -> dict:
    """Configure the write token: supplied, saved, or from a VibeMon sign-in.

    A supplied token (--token, VIBEMON_WRITE_TOKEN) wins. A saved generated
    token is kept unless --login asks for a new sign-in. Without a token, a
    run in a terminal signs in to VibeMon; other runs, such as App updates,
    never wait for a person and keep local delivery only.
    """
    current_token = config.get("vibemon_token", "")
    print(f"\n{colored('VibeMon delivery:', 'cyan')}")

    supplied = cli_token or os.environ.get("VIBEMON_WRITE_TOKEN")
    if supplied:
        validate_token(supplied)
        config["vibemon_token"] = supplied
        print(f"  {colored('✓', 'green')} Write token configured")
        return config

    saved = isinstance(current_token, str) and bool(TOKEN_PATTERN.fullmatch(current_token))
    if saved and not SIGN_IN:
        print(f"  {colored('✓', 'green')} Token unchanged. Run with --login to sign in again.")
        return config

    if SIGN_IN or sys.stdout.isatty():
        try:
            config["vibemon_token"] = sign_in_to_web(config.get("vibemon_url") or "https://vibemon.io", "vibemon-hooks")
            return config
        except SignInError as error:
            # Without --login, local delivery still works; the person can sign in later.
            if SIGN_IN:
                raise ValueError(str(error)) from None
            print(f"  {colored('!', 'yellow')} {error}. Activity stays local. Run with --login to sign in.")
            return config

    # Upgrades must validate saved credentials too; legacy arbitrary tokens
    # cannot authenticate to VibeMon even when local delivery still works.
    if current_token:
        raise ValueError("Saved VibeMon token is not a generated write token. Run the installer with --login, or set VIBEMON_WRITE_TOKEN.")
    print(f"  {colored('!', 'yellow')} Not signed in. Activity stays local. Run with --login to send it to VibeMon.")
    return config


def read_json_object(path: Path) -> dict | None:
    """Return the JSON object stored at path, or None when it holds anything else.

    Every config the installer edits is a JSON object. Invalid JSON and a
    top-level value of another type are both reported and ignored.
    """
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        config = None
    if isinstance(config, dict):
        return config
    print(f"  {colored('!', 'yellow')} {path.name} is not a valid JSON object — ignoring its content")
    return None


def load_or_create_config(config_path: Path, example_content: str) -> dict:
    """Load the existing config object, or start from the packaged example.

    The example is integrity-checked before it gets here, so a parse failure
    is a packaging defect and raises.
    """
    if config_path.exists():
        # Copy it aside before the defaults below get saved over it — it may
        # hold a hand-edited vibemon_token.
        backup_file(config_path)
        config = read_json_object(config_path)
        if config is not None:
            return config
    return json.loads(example_content)


def write_text_atomic(path: Path, content: str, mode: int = None) -> None:
    """Write `content` to `path` atomically.

    A half-written settings.json costs the user their whole tool config, so the
    content lands in a temp file beside the target and is renamed over it with
    os.replace(). The target's existing mode is preserved unless `mode` is given
    (os.replace swaps inodes, so the mode has to be set on the temp file).

    `newline=""` keeps the bytes exactly as given on every platform. Without it
    Windows rewrites every \\n as \\r\\n, and the installed file's sha256 stops
    matching manifest.json forever — which pins the Desktop app's drift check
    to "update available" and makes it reinstall on every check.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if mode is None and path.exists():
        mode = path.stat().st_mode & 0o777
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        # Create the temp file with its final mode, so a secret is never readable by others.
        descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600 if mode is None else mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# Paths already copied to .bak this run, so re-entrant installers back a file
# up once — before the first modification — rather than after a later one.
BACKED_UP = set()


def backup_file(path: Path) -> None:
    """Copy `path` to `path`.bak once per run, before it is first modified."""
    if not path.exists() or str(path) in BACKED_UP:
        return
    backup_path = path.with_name(path.name + ".bak")
    try:
        shutil.copy2(path, backup_path)
        BACKED_UP.add(str(path))
        print(f"  {colored('✓', 'green')} backed up {path.name} -> {backup_path.name}")
    except OSError as e:
        message = f"Could not back up {path.name}: {e}"
        print(f"  {colored('✗', 'red')} {message}")
        raise RuntimeError(message) from e


def save_config(config_path: Path, config: dict, mode: int = None) -> bool:
    """Save config to file."""
    try:
        write_text_atomic(config_path, json.dumps(config, indent=2) + "\n", mode=mode)
        return True
    except Exception as e:
        print(f"  {colored('✗', 'red')} Failed to save config: {e}")
        return False


def load_json_or_backup(path: Path) -> dict:
    """Load a JSON object from path, copying it to .bak before it gets overwritten.

    Content that is not a JSON object gives an empty object, so callers can
    read keys without a shape check.
    """
    backup_file(path)
    return read_json_object(path) or {}


def download_file(url: str) -> str:
    """Download a file from URL and return its content."""
    try:
        with urlopen(checked_download_url(url), timeout=30) as response:
            raw = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(raw) > MAX_DOWNLOAD_BYTES:
                raise RuntimeError("Installer download exceeds the 1 MiB limit")
            return raw.decode("utf-8")
    except (URLError, OSError) as e:
        # URLError is an OSError subclass, but a stalled read raises the bare
        # OSError/TimeoutError. Both must reach the integrity failure path.
        raise RuntimeError(f"Failed to download {url}: {e}") from e


MANIFEST_PATH = "manifest.json"

# sha256 of every file the installer copies verbatim, keyed by source path.
# Local checkouts are read directly. Remote source requires a valid manifest.
REMOTE_MANIFEST = {}
_MANIFEST_LOADED = False
_MANIFEST_BASE = None


class IntegrityError(RuntimeError):
    """A downloaded file did not match its manifest.json sha256."""


def load_manifest(source) -> dict:
    """Require a complete integrity reference before downloading remote files."""
    global _MANIFEST_LOADED, _MANIFEST_BASE, REMOTE_MANIFEST
    if not source.is_online:
        return {}
    if _MANIFEST_LOADED and _MANIFEST_BASE == source.base_url:
        return REMOTE_MANIFEST
    pinned = os.environ.get("VIBEMON_MANIFEST_SHA256", "").strip()
    try:
        text = download_file(f"{source.base_url}/{MANIFEST_PATH}")
        files = json.loads(text)["files"]
        if not isinstance(files, dict) or not files or any(not isinstance(key, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) for key, digest in files.items()):
            raise ValueError("Invalid manifest")
    except (RuntimeError, ValueError, KeyError, TypeError) as error:
        raise IntegrityError("Cannot verify installation files. Publish the source and manifest together, then retry.") from error
    if pinned and hashlib.sha256(text.encode("utf-8")).hexdigest() != pinned:
        raise IntegrityError("manifest.json is not the version that VibeMon expects; nothing was written")
    REMOTE_MANIFEST = files
    _MANIFEST_LOADED = True
    _MANIFEST_BASE = source.base_url
    print(f"  {colored('✓', 'green')} manifest loaded ({len(files)} files)")
    return files


def verify_content(path: str, content: str) -> None:
    """Verify downloaded source bytes before copying or merging them."""
    expected = REMOTE_MANIFEST.get(path)
    if not expected:
        raise IntegrityError(f"{path} has no published integrity reference; nothing was written")
    actual = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if actual != expected:
        raise IntegrityError(f"{path} failed its integrity check; nothing was written. Publish matching source and manifest files, then retry.")


def show_diff(old_content: str, new_content: str, filename: str) -> bool:
    """Show unified diff between old and new content. Returns True if different."""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)

    diff = list(difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"existing {filename}",
        tofile=f"new {filename}",
        lineterm=""
    ))

    if not diff:
        return False

    print(f"\n  {colored('Diff:', 'yellow')}")
    for line in diff[:50]:
        line = line.rstrip("\n")
        if line.startswith("+") and not line.startswith("+++"):
            print(f"    {colored(line, 'green')}")
        elif line.startswith("-") and not line.startswith("---"):
            print(f"    {colored(line, 'red')}")
        elif line.startswith("@@"):
            print(f"    {colored(line, 'cyan')}")
        else:
            print(f"    {line}")

    if len(diff) > 50:
        print(f"    {colored(f'... ({len(diff) - 50} more lines)', 'yellow')}")

    return True


def write_file_with_diff(dst: Path, content: str, description: str, executable: bool = False) -> bool:
    """Write content to a file, showing diff if it already exists.

    Returns False only when the write fails; a user-declined overwrite and an
    effectively-unchanged file both count as success so installers can treat
    False as a real error.
    """
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)

        if dst.exists():
            # Compared as bytes, not text: a file an older Windows install
            # wrote with CRLF decodes to identical *text* while hashing
            # differently, so a text comparison would report "no changes" and
            # leave it permanently out of sync with manifest.json.
            new_bytes = content.encode("utf-8")
            old_bytes = dst.read_bytes()
            mode = (dst.stat().st_mode & 0o777) | 0o111 if executable else None

            if old_bytes == new_bytes:
                print(f"  {colored('✓', 'green')} {description} (no changes)")
                return True

            try:
                old_content = old_bytes.decode("utf-8")
            except UnicodeDecodeError:
                old_content = ""

            if old_content.replace("\r\n", "\n") == content:
                # Same text, different bytes — only the line endings differ.
                # Rewriting is not a user-visible change, so don't prompt.
                write_text_atomic(dst, content, mode=mode)
                print(f"  {colored('✓', 'green')} {description} (line endings normalized)")
                return True

            print(f"\n  {colored('!', 'yellow')} {description} already exists")
            has_diff = show_diff(old_content, content, dst.name)

            if has_diff:
                # unattended=True: these are VibeMon-owned scripts, so an
                # unattended run is an upgrade, not a config overwrite.
                if ask_yes_no(f"  Overwrite {description}?", unattended=True):
                    write_text_atomic(dst, content, mode=mode)
                    print(f"  {colored('✓', 'green')} {description} (updated)")
                    return True
                else:
                    print(f"  {colored('!', 'yellow')} {description} (skipped)")
                    return True
            return True
        else:
            write_text_atomic(dst, content, mode=0o755 if executable else None)
            print(f"  {colored('✓', 'green')} {description}")
            return True

    except Exception as e:
        print(f"  {colored('✗', 'red')} {description}: {e}")
        return False


def get_hook_identities(hook_entries: list) -> set:
    """Extract the identity of every hook in a list of entries.

    Identity, not the bare `command`: on Windows the hooks use exec form, where
    `command` is just the Python interpreter and the script lives in `args`.
    Deduping on `command` alone would mistake any other Python hook of the
    user's for this one and drop VibeMon's registration entirely.
    """
    identities = set()
    for entry in hook_entries:
        hooks = entry.get("hooks") if "hooks" in entry else [entry]
        for hook in hooks or []:
            identity = _hook_identity(hook)
            if identity:
                identities.add(identity)
    return identities


def filter_new_hooks(entry: dict, existing_ids: set) -> dict:
    """Return entry with already-registered hooks removed, or None if nothing new remains."""
    if "hooks" in entry:
        new_hook_list = [
            h for h in (entry.get("hooks") or []) if _hook_identity(h) not in existing_ids
        ]
        if not new_hook_list:
            return None
        return {**entry, "hooks": new_hook_list}
    elif "command" in entry:
        return None if _hook_identity(entry) in existing_ids else entry
    return entry


def merge_hooks(existing: dict, new_hooks: dict) -> dict:
    """Merge new hooks into existing hooks configuration (Claude format)."""
    result = {}

    for event, new_entries in new_hooks.items():
        if event not in existing:
            result[event] = new_entries
        else:
            existing_entries = existing[event]
            existing_ids = get_hook_identities(existing_entries)
            result[event] = existing_entries.copy()

            for new_entry in new_entries:
                filtered_entry = filter_new_hooks(new_entry, existing_ids)
                if filtered_entry is not None:
                    result[event].append(filtered_entry)

    for event in existing:
        if event not in result:
            result[event] = existing[event]

    return result


WINDOWS_ENCODED_PREFIX = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "
WINDOWS_LITERAL_PREFIX = "$ErrorActionPreference='Stop'; & "
WINDOWS_LITERAL_SUFFIX = "; exit $LASTEXITCODE"


def _command_tokens(command: str, windows: bool = None) -> list[str]:
    if not isinstance(command, str):
        return []
    if command.startswith(WINDOWS_ENCODED_PREFIX):
        try:
            script = base64.b64decode(command[len(WINDOWS_ENCODED_PREFIX):], validate=True).decode("utf-16le")
        except (ValueError, UnicodeError):
            return []
        if not script.startswith(WINDOWS_LITERAL_PREFIX) or not script.endswith(WINDOWS_LITERAL_SUFFIX):
            return []
        arguments = script[len(WINDOWS_LITERAL_PREFIX):-len(WINDOWS_LITERAL_SUFFIX)]
        literals = re.findall(r"'(?:''|[^'])*'", arguments)
        if len(literals) < 2 or arguments != " ".join(literals):
            return []
        return [literal[1:-1].replace("''", "'") for literal in literals]
    windows = IS_WINDOWS if windows is None else windows
    if windows and command.lstrip().startswith('& '):
        # Literal arguments emitted by windows_shell_command. PowerShell
        # escapes apostrophes by doubling them; POSIX shlex removes both.
        tokens = re.findall(r"'(?:(?:'')|[^'])*'|\"[^\"]*\"|[^\s]+", command)
        return [token[1:-1].replace("''", "'") if token.startswith("'") and token.endswith("'")
                else token[1:-1] if token.startswith('"') and token.endswith('"') else token for token in tokens]
    try:
        tokens = shlex.split(command, posix=not windows)
    except ValueError:
        return []
    return [token[1:-1] if windows and len(token) > 1 and token[0] in "\"'" and token[-1] == token[0] else token for token in tokens]


def _is_vibemon_hook(hook: dict) -> bool:
    """Match the script filename, never a similarly named user hook."""
    tokens = _command_tokens(hook.get("command", ""))
    tokens += _command_tokens(hook.get("commandWindows", ""), windows=True)
    tokens += hook.get("args", []) or []
    return any(isinstance(token, str) and re.split(r"[\\/]", token)[-1] == "vibemon.py" for token in tokens)


def _uses_installed_script(command: str, script: Path) -> bool:
    # A Windows status line can have been generated for Git Bash or PowerShell.
    # Recognize both literal forms even if Git Bash was added or removed later.
    tokens = _command_tokens(command)
    if IS_WINDOWS:
        tokens += _command_tokens(command, windows=False)
    for token in tokens:
        normalized = token.replace("\\", "/")
        if normalized.split("/")[-1] != script.name:
            continue
        candidate = Path.home() / normalized[2:] if normalized.startswith("~/") else Path(normalized)
        if candidate.resolve() == script.resolve():
            return True
    return False


def _hook_identity(hook: dict) -> str:
    """Stable identity for a hook across Claude/Codex (`command`, plus Codex's
    optional `commandWindows` override) and Kiro/exec-form (`command` + `args`)
    shapes."""
    parts = [hook.get("command", "")]
    parts.extend(hook.get("args", []))
    if hook.get("commandWindows"):
        parts.append(hook["commandWindows"])
    return " ".join(parts).strip()


def strip_all_vibemon_hooks(existing: dict) -> list:
    """Remove every VibeMon hook registration, preserving user hooks.

    Only VibeMon's own entries are touched — user hooks under the same events
    are kept. Mutates `existing` and returns the list of changed event names.
    """
    changed_events = []
    for event in list(existing.keys()):
        cleaned_entries = []
        changed = False
        for entry in existing[event]:
            if "hooks" in entry:
                entry_hooks = entry.get("hooks") or []
                kept = [h for h in entry_hooks if not _is_vibemon_hook(h)]
                if len(kept) != len(entry_hooks):
                    changed = True
                    if kept:
                        cleaned_entries.append({**entry, "hooks": kept})
                else:
                    cleaned_entries.append(entry)
            elif _is_vibemon_hook(entry):
                changed = True
            else:
                cleaned_entries.append(entry)
        if changed:
            changed_events.append(event)
            if cleaned_entries:
                existing[event] = cleaned_entries
            else:
                del existing[event]
    return changed_events


def replace_vibemon_hooks(existing: dict, new_hooks: dict) -> tuple[dict, list]:
    """Replace VibeMon-owned registrations while preserving every user hook.

    Command identity alone is insufficient for upgrades: fields such as
    `async`, `timeout`, and `statusMessage` can change while the command stays
    the same. Removing only VibeMon entries before merging ensures those
    fields are refreshed without touching neighboring user configuration.
    """
    if not isinstance(existing, dict):
        existing = {}
    replaced = strip_all_vibemon_hooks(existing)
    return merge_hooks(existing, new_hooks), replaced


# ============================================================================
# Platform adaptation
#
# The packaged configs are written for POSIX (`python3 ~/.claude/...`) so the
# docs can be copy-pasted as-is. Windows can't run them: there is no `python3`
# on PATH, and PowerShell — which Claude Code uses for shell-form commands when
# Git Bash isn't installed — does not expand `~` in argument position. So the
# commands are rewritten at install time, when the real paths are known.
# ============================================================================


def hook_python() -> str:
    """Interpreter to hard-code into generated hook commands.

    sys.executable is the interpreter running this installer, so it is known to
    exist and to be able to run the hooks. It also pins the hooks to a specific
    Python: after a Python upgrade moves the executable, the installer has to
    be re-run.

    Forward-slashed via hook_path(): a Windows path such as C:\\Python313\\
    python.exe reaches shell-form commands (Claude statusLine, Codex's
    commandWindows, Kiro's action.command) where Git Bash consumes unquoted
    backslashes as escapes.
    """
    return hook_path(Path(sys.executable or "python"))


def hook_path(path: Path) -> str:
    """Absolute path for use inside a hook command string.

    Forward slashes on Windows: Git Bash consumes unquoted backslashes as
    escapes (Claude Code's own docs require forward slashes here), and the
    Windows APIs accept them either way.
    """
    return str(path).replace("\\", "/")


def windows_hook_command(python: str, script: str, *args: str) -> str:
    """Run literal argv under any Windows provider shell, retaining stdin.

    Simple paths work directly in CMD, PowerShell and Git Bash. Other paths
    need an explicit shell: no quoted executable syntax works in all three.
    EncodedCommand keeps the outer shell from expanding or splitting literals.
    """
    values = (python, script, *args)
    if all(re.fullmatch(r"[A-Za-z0-9_./:-]+", value) for value in values):
        return " ".join(values)
    literals = ["'" + value.replace("'", "''") + "'" for value in values]
    invocation = WINDOWS_LITERAL_PREFIX + " ".join(literals) + WINDOWS_LITERAL_SUFFIX
    return WINDOWS_ENCODED_PREFIX + base64.b64encode(invocation.encode("utf-16le")).decode("ascii")


def has_git_bash() -> bool:
    """Whether Claude Code will route shell-form commands through Git Bash.

    Claude Code uses Git Bash when it is installed and PowerShell otherwise,
    and the two disagree about how to invoke a quoted command.

    A bare `bash` on PATH is not proof: Windows ships WSL's launcher as
    C:\\Windows\\System32\\bash.exe, which Claude Code does not use. Only a
    bash that lives inside a Git installation counts.
    """
    on_path = shutil.which("bash")
    if on_path and Path(on_path).parent.parent.name.lower() == "git":
        return True

    candidates = [
        Path(base, "Git", "bin", "bash.exe")
        for base in (
            os.environ.get("ProgramFiles"),
            os.environ.get("ProgramFiles(x86)"),
            os.environ.get("LOCALAPPDATA"),
        )
        if base
    ]
    git_exe = shutil.which("git")
    if git_exe:
        # <root>/cmd/git.exe or <root>/bin/git.exe -> <root>/bin/bash.exe
        candidates.append(Path(git_exe).parent.parent / "bin" / "bash.exe")
    return any(path.is_file() for path in candidates)


def windows_shell_command(python: str, script: str) -> str:
    """Quote literal paths for Claude's selected Windows status-line shell."""
    if has_git_bash():
        return f"{shlex.quote(python)} {shlex.quote(script)}"
    # The call operator invokes a quoted executable. Single quotes preserve
    # dollar signs/backticks; doubled apostrophes preserve the path itself.
    quote = lambda value: "'" + value.replace("'", "''") + "'"
    return f"& {quote(python)} {quote(script)}"


def tool_home(env_var: str, default_dir: str) -> Path:
    """Resolve a tool's user configuration root, honoring its official override."""
    configured = os.environ.get(env_var, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / default_dir


def opencode_config_home() -> Path:
    """Resolve opencode's config home.

    `OPENCODE_CONFIG_DIR` wins; otherwise opencode reads its global config from
    `$XDG_CONFIG_HOME/opencode` (falling back to `~/.config/opencode`), so the
    installer writes plugins where opencode will discover them.
    """
    configured = os.environ.get("OPENCODE_CONFIG_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return base / "opencode"


def display_path(path: Path) -> str:
    """Render paths under the user's home with a compact ~/ prefix."""
    try:
        return f"~/{path.relative_to(Path.home())}"
    except ValueError:
        return str(path)


def adapt_claude_settings(settings: dict, claude_home: Path = None) -> dict:
    """Rewrite the packaged Claude Code config for the running platform.

    Identity for the default POSIX home. A custom CLAUDE_CONFIG_DIR gets
    absolute shell commands. On Windows the hooks move to exec form (`command`
    plus `args`), which Claude Code spawns directly — no shell, so nothing to
    expand and nothing to quote. statusLine has no exec form, so it stays a
    shell string. Mutates and returns `settings`.
    """
    claude_home = claude_home or tool_home("CLAUDE_CONFIG_DIR", ".claude")
    if not IS_WINDOWS and claude_home == Path.home() / ".claude":
        return settings

    python = hook_python() if IS_WINDOWS else "python3"
    hook_script = hook_path(claude_home / "hooks" / "vibemon.py")
    statusline_script = hook_path(claude_home / "statusline.py")

    for entries in settings.get("hooks", {}).values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                if "vibemon.py" in hook.get("command", ""):
                    if IS_WINDOWS:
                        hook["command"] = python
                        hook["args"] = [hook_script]
                    else:
                        hook["command"] = f"{python} {shlex.quote(hook_script)}"

    status_line = settings.get("statusLine")
    if isinstance(status_line, dict) and "statusline.py" in status_line.get("command", ""):
        status_line["command"] = (
            windows_shell_command(python, statusline_script) if IS_WINDOWS
            else f"{python} {shlex.quote(statusline_script)}"
        )

    return settings


def adapt_codex_hooks(hooks_config: dict, codex_home: Path = None) -> dict:
    """Adapt packaged Codex hook commands for Windows or a custom CODEX_HOME.

    Windows receives a `commandWindows` override beside the packaged POSIX
    command. A custom POSIX home rewrites `command` to the absolute script
    path. Mutates and returns `hooks_config`.
    """
    codex_home = codex_home or tool_home("CODEX_HOME", ".codex")
    if not IS_WINDOWS and codex_home == Path.home() / ".codex":
        return hooks_config

    script = hook_path(codex_home / "hooks" / "vibemon.py")
    command = windows_hook_command(hook_python(), script) if IS_WINDOWS else f"python3 {shlex.quote(script)}"

    for entries in hooks_config.get("hooks", {}).values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                if "vibemon.py" in hook.get("command", ""):
                    if IS_WINDOWS:
                        hook["commandWindows"] = command
                    else:
                        hook["command"] = command

    return hooks_config


def adapt_kiro_hook_config(content: str, kiro_home: Path = None) -> str:
    """Rewrite Kiro's v1 global hook commands for Windows or a custom home.

    Returns `content` untouched for the default POSIX home so the file stays
    byte-identical to its manifest hash there. Kiro's `action.command` is a
    shell string, so Windows and KIRO_HOME installs need absolute paths.

    Windows commands preserve literal paths in CMD, Git Bash and PowerShell.
    """
    kiro_home = kiro_home or tool_home("KIRO_HOME", ".kiro")
    if not IS_WINDOWS and kiro_home == Path.home() / ".kiro":
        return content

    config = json.loads(content)
    changed = False
    for hook in config.get("hooks", []):
        action = hook.get("action", {})
        command = action.get("command", "")
        if "vibemon.py" not in command:
            continue
        # "python3 ~/.kiro/hooks/vibemon.py SessionStart" -> keep event args.
        event_args = command.split()[2:]
        script = hook_path(kiro_home / "hooks" / "vibemon.py")
        action["command"] = windows_hook_command(hook_python(), script, *event_args) if IS_WINDOWS else shlex.join(["python3", script, *event_args])
        changed = True
    return json.dumps(config, indent=2) + "\n" if changed else content


def _replace_opencode_line(content: str, prefix: str, replacement: str) -> str:
    """Replace the single `prefix`-prefixed line in the packaged opencode plugin.

    install.py ships the plugin for the default POSIX home and rewrites it on
    Windows or a custom OPENCODE_CONFIG_DIR, when absolute paths are required.
    """
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(prefix):
            lines[i] = replacement
            return "\n".join(lines) + "\n"
    raise RuntimeError(f"Could not find '{prefix}' in the opencode plugin source")


def adapt_opencode_plugin(content: str, opencode_home: Path = None) -> str:
    """Rewrite the packaged opencode plugin for Windows or a custom home.

    Returns `content` untouched for the default POSIX home so the file stays
    byte-identical to its manifest hash there. opencode spawns the adapter
    with the interpreter and hook-script paths baked into the plugin, so:
    * Windows pins the interpreter to the Python running this installer
      (`python3` is not on PATH there);
    * a custom OPENCODE_CONFIG_DIR (or Windows) inlines the absolute
      hook-script path instead of leaving os.homedir() resolution to the
      plugin.
    """
    opencode_home = opencode_home or opencode_config_home()
    default_home = Path.home() / ".config" / "opencode"
    if not IS_WINDOWS and opencode_home == default_home:
        return content

    # Paths go into JavaScript string literals: forward-slash them and
    # JSON-encode, so a Windows interpreter (`C:\Python...`) isn't read as
    # backslash escapes and a quote in a custom home can't break parsing.
    python = hook_path(Path(hook_python())) if IS_WINDOWS else "python3"
    result = content
    if IS_WINDOWS:
        result = _replace_opencode_line(
            result, "const PYTHON = ",
            f"const PYTHON = {json.dumps(python)};",
        )
    if opencode_home != default_home:
        script = hook_path(opencode_home / "hooks" / "vibemon.py")
        result = _replace_opencode_line(
            result, "const HOOK_SCRIPT = ",
            f"const HOOK_SCRIPT = path.join({json.dumps(script)});",
        )
    return result


class FileSource:
    """Abstract file source for local or remote files."""

    def __init__(self, local_dir: Path = None):
        self.local_dir = local_dir
        self.is_online = True
        self.base_url = checked_download_url(os.environ.get("VIBEMON_DOCS_URL") or DOCS_BASE_URL)

        if local_dir is not None:
            # Check if running from local directory with install files
            # Files may be in local_dir/claude/ or local_dir/install/claude/
            if (local_dir / "claude").exists():
                self.is_online = False
            elif (local_dir / "install" / "claude").exists():
                self.local_dir = local_dir / "install"
                self.is_online = False

    def get_file(self, path: str) -> str:
        """Get file content from local or remote source.

        Remote content is checked against manifest.json before any caller can
        write it to disk; a mismatch raises IntegrityError.
        """
        if self.is_online:
            load_manifest(self)
            url = f"{self.base_url}/{path}"
            content = download_file(url)
            verify_content(path, content)
            return content
        else:
            # Local checkouts keep the collector package at the repository root.
            local = self.local_dir / path
            if path == 'vibemon/http_deadline.py' and not local.exists():
                local = self.local_dir.parents[1] / 'collector/vibemon_collector/http_deadline.py'
            if not local.exists() and path.startswith("collector/"):
                local = self.local_dir.parents[1] / path
            return local.read_text(encoding="utf-8")


def is_tool_installed(commands: str | tuple[str, ...], home_dir: Path) -> bool:
    """Check for any supported CLI command or an existing config directory."""
    if isinstance(commands, str):
        commands = (commands,)
    return any(shutil.which(command) is not None for command in commands) or home_dir.exists()


# Shared ~/.vibemon scripts, installed for every platform and removed by
# --uninstall --vibemon. vibemon_core.py imports the others, so it comes last.
SHARED_SCRIPTS = (
    "http_deadline.py", "http_client.py", "cache_io.py", "account_identity.py", "account_parsers.py", "account_sources.py", "account_store.py", "account_service.py", "account_refresh.py", "account_context.py", "usage.py",
    "usage_cache.py", "project_context.py", "session_activity.py", "vibemon_core.py",
)

# Caches the resolved token so ~/.vibemon/config.json is only configured once per run.
VIBEMON_CONFIG_CACHE = {}


def configure_vibemon_config(source: FileSource, cli_token: str = None) -> str:
    """Configure ~/.vibemon/config.json once per run and return the resolved token."""
    if "token" in VIBEMON_CONFIG_CACHE:
        return VIBEMON_CONFIG_CACHE["token"]

    vibemon_home = Path.home() / ".vibemon"
    vibemon_home.mkdir(parents=True, exist_ok=True)
    config_path = vibemon_home / "config.json"
    config_content = source.get_file(CONFIG_EXAMPLE_FILE)

    print("\nConfiguring VibeMon:")
    config = load_or_create_config(config_path, config_content)

    origin = os.environ.get("VIBEMON_URL")
    if origin:
        origin = checked_download_url(origin)
        if urlsplit(origin).path not in ("", "/"):
            raise ValueError("VIBEMON_URL must be a VibeMon address without a path")
        previous = str(config.get("vibemon_url", "")).rstrip("/")
        if origin != previous and config.get("vibemon_token") and not (cli_token or os.environ.get("VIBEMON_WRITE_TOKEN") or SIGN_IN):
            raise ValueError("Changing VIBEMON_URL requires --login or a matching VIBEMON_WRITE_TOKEN")
        config["vibemon_url"] = origin

    if not config_path.exists():
        print("  Creating new config at ~/.vibemon/config.json")
    else:
        print(f"  {colored('✓', 'green')} ~/.vibemon/config.json exists")

    config = configure_token(config, cli_token)

    # 0600: this file holds the VibeMon API token. A failed write must fail the
    # platform (run_install reports it) instead of silently reporting success
    # with no token persisted.
    if not save_config(config_path, config, mode=0o600):
        raise RuntimeError("could not write ~/.vibemon/config.json")
    print(f"  {colored('✓', 'green')} ~/.vibemon/config.json saved")

    VIBEMON_CONFIG_CACHE["token"] = config.get("vibemon_token", "")
    return VIBEMON_CONFIG_CACHE["token"]


def install_vibemon_shared(source: FileSource) -> bool:
    """Install shared ~/.vibemon assets once per run, for every platform.

    usage.py is the standalone plan-usage cache refresher run by the Desktop
    app on startup or on a schedule; usage_cache.py owns the shared parsing
    and provider-freshness cache contract; session_activity.py keeps each
    session's turn and its heartbeat watcher; vibemon_core.py is the shared
    transport module imported by every per-tool hook. All belong to every
    installation, not just Claude Code's.
    """
    if "shared_installed" in VIBEMON_CONFIG_CACHE:
        return VIBEMON_CONFIG_CACHE["shared_installed"]

    ok = True
    for name in SHARED_SCRIPTS:
        content = source.get_file(f"vibemon/{name}")
        ok = write_file_with_diff(Path.home() / ".vibemon" / name, content, f"~/.vibemon/{name}", executable=name == "usage.py") and ok
    VIBEMON_CONFIG_CACHE["shared_installed"] = ok
    return ok


def configure_statusline_config(source: FileSource) -> bool:
    """Configure ~/.vibemon/statusline.json (Claude Code statusline display
    settings). On first creation, migrates any statusline-only keys found in
    a pre-split single config.json so existing customizations aren't reset.
    """
    vibemon_home = Path.home() / ".vibemon"
    vibemon_home.mkdir(parents=True, exist_ok=True)
    statusline_path = vibemon_home / "statusline.json"
    config_path = vibemon_home / "config.json"
    is_new = not statusline_path.exists()

    print("\nConfiguring statusline display settings:")
    statusline_content = source.get_file(STATUSLINE_EXAMPLE_FILE)
    statusline_config = load_or_create_config(statusline_path, statusline_content)

    if is_new:
        print("  Creating new config at ~/.vibemon/statusline.json")
        if config_path.exists():
            legacy = read_json_object(config_path) or {}
            migrated = {k: legacy[k] for k in STATUSLINE_KEYS if k in legacy}
            if migrated:
                statusline_config.update(migrated)
                print(f"  {colored('✓', 'green')} Migrated {len(migrated)} statusline setting(s) from config.json")
    else:
        print(f"  {colored('✓', 'green')} ~/.vibemon/statusline.json exists")

    if save_config(statusline_path, statusline_config):
        print(f"  {colored('✓', 'green')} ~/.vibemon/statusline.json saved")
        return True
    return False


def install_claude(source: FileSource, cli_token: str = None) -> bool:
    """Install VibeMon for Claude Code."""
    claude_home = tool_home("CLAUDE_CONFIG_DIR", ".claude")
    if not is_tool_installed("claude", claude_home):
        print(f"\n{colored('!', 'yellow')} Claude Code not detected. Skipping installation.")
        return SKIPPED

    print(f"\n{colored('Installing VibeMon for Claude Code...', 'cyan')}\n")

    claude_home.mkdir(parents=True, exist_ok=True)
    (claude_home / "hooks").mkdir(parents=True, exist_ok=True)

    print("Copying files:")
    ok = True

    # statusline.py -> ~/.claude/statusline.py
    content = source.get_file("claude/statusline.py")
    ok &= write_file_with_diff(
        claude_home / "statusline.py",
        content,
        display_path(claude_home / "statusline.py"),
        executable=True,
    )

    # hooks/vibemon.py -> ~/.claude/hooks/vibemon.py
    content = source.get_file("claude/hooks/vibemon.py")
    ok &= write_file_with_diff(
        claude_home / "hooks" / "vibemon.py",
        content,
        display_path(claude_home / "hooks" / "vibemon.py"),
        executable=True,
    )

    # Handle settings.json
    print("\nConfiguring settings.json:")
    settings_file = claude_home / "settings.json"
    new_settings = adapt_claude_settings(
        json.loads(source.get_file("claude/settings.json")), claude_home
    )
    if IS_WINDOWS:
        print(f"  {colored('✓', 'green')} hooks pinned to {hook_python()}")

    if settings_file.exists():
        existing_settings = load_json_or_backup(settings_file)

        if "hooks" in existing_settings:
            # Strip and re-merge VibeMon's own entries: command identity alone
            # is unchanged across upgrades, so fields like async/timeout/
            # statusMessage would otherwise keep their old values. User hooks
            # under the same events are preserved.
            existing_settings["hooks"], replaced = replace_vibemon_hooks(
                existing_settings["hooks"], new_settings["hooks"]
            )
            if replaced:
                print(f"  {colored('✓', 'green')} refreshed VibeMon hooks: {', '.join(replaced)}")
        else:
            existing_settings["hooks"] = new_settings["hooks"]

        status_line = existing_settings.get("statusLine")
        if isinstance(status_line, dict):
            existing_cmd = status_line.get("command", "")
            new_cmd = new_settings["statusLine"].get("command", "")
            if existing_cmd != new_cmd:
                # User commands may embed credentials; never copy them into
                # installer output or Desktop installation diagnostics.
                print("\n  An existing statusLine command differs from VibeMon's configuration.")
                print(f"  New statusLine:     {colored(new_cmd, 'cyan')}")
                # unattended=False: statusLine is the user's own setting, not a
                # VibeMon-owned file. An unattended run must not replace it.
                if ask_yes_no("Replace statusLine?", unattended=False):
                    existing_settings["statusLine"] = new_settings["statusLine"]
                    print(f"  {colored('✓', 'green')} statusLine updated")
                else:
                    hint = " (pass --yes to replace it)" if NON_INTERACTIVE and not AUTO_APPROVE else ""
                    print(f"  {colored('!', 'yellow')} statusLine unchanged{hint}")
            else:
                print(f"  {colored('✓', 'green')} statusLine already configured")
        elif status_line is None:
            existing_settings["statusLine"] = new_settings["statusLine"]
            print(f"  {colored('✓', 'green')} statusLine added")
        else:
            # A malformed (non-object) statusLine must not abort the install.
            # It is user-owned, so ask before replacing it, like the dict path.
            print("\n  The existing statusLine is not an object.")
            if ask_yes_no("Replace statusLine?", unattended=False):
                existing_settings["statusLine"] = new_settings["statusLine"]
                print(f"  {colored('✓', 'green')} statusLine updated")
            else:
                hint = " (pass --yes to replace it)" if NON_INTERACTIVE and not AUTO_APPROVE else ""
                print(f"  {colored('!', 'yellow')} statusLine unchanged{hint}")

        write_text_atomic(settings_file, json.dumps(existing_settings, indent=2) + "\n")
        print(f"  {colored('✓', 'green')} hooks merged into settings.json")
    else:
        # settings.json can hold API keys in its env block; Claude Code creates
        # it 0600 itself, so match that rather than inheriting the umask.
        write_text_atomic(settings_file, json.dumps(new_settings, indent=2) + "\n", mode=0o600)
        print(f"  {colored('✓', 'green')} settings.json created")

    configure_vibemon_config(source, cli_token)
    ok &= configure_statusline_config(source)
    ok &= install_vibemon_shared(source)

    if not ok:
        print(f"\n{colored('✗ Claude Code installation finished with errors — some files were not written.', 'red')}")
        return False

    print(f"\n{colored('Claude Code installation complete!', 'green')}")
    return True


def install_codex(source: FileSource, cli_token: str = None) -> bool:
    """Install VibeMon for Codex CLI."""
    codex_home = tool_home("CODEX_HOME", ".codex")
    if not is_tool_installed("codex", codex_home):
        print(f"\n{colored('!', 'yellow')} Codex CLI not detected. Skipping installation.")
        return SKIPPED

    print(f"\n{colored('Installing VibeMon for Codex CLI...', 'cyan')}\n")

    codex_home.mkdir(parents=True, exist_ok=True)
    (codex_home / "hooks").mkdir(parents=True, exist_ok=True)

    print("Copying files:")

    content = source.get_file("codex/hooks/vibemon.py")
    ok = write_file_with_diff(
        codex_home / "hooks" / "vibemon.py",
        content,
        display_path(codex_home / "hooks" / "vibemon.py"),
        executable=True,
    )

    print("\nConfiguring hooks.json:")
    hooks_file = codex_home / "hooks.json"
    new_hooks = adapt_codex_hooks(
        json.loads(source.get_file("codex/hooks.json")), codex_home
    )

    if hooks_file.exists():
        existing_hooks = load_json_or_backup(hooks_file)

        existing_map = existing_hooks.get("hooks", {})
        new_map = new_hooks.get("hooks", {})
        existing_hooks["hooks"], replaced = replace_vibemon_hooks(existing_map, new_map)
        if replaced:
            print(f"  {colored('✓', 'green')} refreshed VibeMon hooks: {', '.join(replaced)}")
        write_text_atomic(hooks_file, json.dumps(existing_hooks, indent=2) + "\n")
        print(f"  {colored('✓', 'green')} hooks merged into {display_path(hooks_file)}")
    else:
        write_text_atomic(hooks_file, json.dumps(new_hooks, indent=2) + "\n")
        print(f"  {colored('✓', 'green')} {display_path(hooks_file)} created")

    configure_vibemon_config(source, cli_token)
    ok &= install_vibemon_shared(source)

    if not ok:
        print(f"\n{colored('✗ Codex CLI installation finished with errors — some files were not written.', 'red')}")
        return False

    print(f"\n{colored('Codex CLI installation complete!', 'green')}")
    print(f"\n{colored('Notes:', 'yellow')}")
    print("  • Open /hooks and review/trust the new or changed VibeMon hooks")
    print("  • An explicit [features].hooks = false was left unchanged")
    print("  • Restart your Codex session after installation")
    return True


def remove_legacy_kiro_hooks(kiro_home: Path) -> None:
    """Remove only VibeMon's IDE 0.x / CLI 2.x hook registrations."""
    agent_file = kiro_home / "agents" / "default.json"
    _uninstall_hooks_from_json(agent_file, [], display_path(agent_file))
    # Old installers created this agent with hooks only. Kiro rejects an agent
    # without a name, so delete the file when no user content is left in it.
    if agent_file.is_file():
        try:
            agent = json.loads(agent_file.read_text(encoding="utf-8"))
        except ValueError:
            agent = None
        if agent in ({}, {"hooks": {}}):
            remove_path(agent_file, display_path(agent_file))
    for hook_file in LEGACY_KIRO_HOOK_FILES:
        remove_path(
            kiro_home / "hooks" / hook_file,
            display_path(kiro_home / "hooks" / hook_file),
        )


def install_kiro(source: FileSource, cli_token: str = None) -> bool:
    """Install VibeMon for Kiro IDE and Kiro CLI."""
    kiro_home = tool_home("KIRO_HOME", ".kiro")
    if not is_tool_installed(("kiro", "kiro-cli"), kiro_home):
        print(f"\n{colored('!', 'yellow')} Kiro not detected. Skipping installation.")
        return SKIPPED

    print(f"\n{colored('Installing VibeMon for Kiro...', 'cyan')}\n")

    kiro_home.mkdir(parents=True, exist_ok=True)
    (kiro_home / "hooks").mkdir(parents=True, exist_ok=True)

    print("Copying files:")

    # vibemon.py -> ~/.kiro/hooks/vibemon.py
    content = source.get_file("kiro/hooks/vibemon.py")
    ok = write_file_with_diff(
        kiro_home / "hooks" / "vibemon.py",
        content,
        display_path(kiro_home / "hooks" / "vibemon.py"),
        executable=True,
    )

    print("\nConfiguring global hooks:")
    if IS_WINDOWS:
        print(f"  {colored('✓', 'green')} hooks pinned to {hook_python()}")
    for remote in KIRO_HOOK_CONFIG_FILES:
        target = kiro_home / "hooks" / Path(remote).name
        ok &= write_file_with_diff(
            target,
            adapt_kiro_hook_config(source.get_file(remote), kiro_home),
            display_path(target),
        )

    # Only retire working legacy registrations after the current v1 config is
    # safely in place. User hooks in the old agent file are preserved.
    if ok:
        remove_legacy_kiro_hooks(kiro_home)

    configure_vibemon_config(source, cli_token)
    ok &= install_vibemon_shared(source)

    if not ok:
        print(f"\n{colored('✗ Kiro installation finished with errors — some files were not written.', 'red')}")
        return False

    print(f"\n{colored('Kiro installation complete!', 'green')}")
    print("  • Global hooks apply to every local Kiro IDE and CLI project")
    return True


def ensure_plugin_path_registered(config: dict, plugin_dir: str) -> bool:
    """Ensure plugin_dir is listed in config["plugins"]["load"]["paths"].

    OpenClaw doesn't auto-discover extension directories -- plugins must be
    explicitly registered here or the manifest/entries config alone won't
    load them. Returns True if the config was changed.
    """
    if "plugins" not in config or not isinstance(config["plugins"], dict):
        config["plugins"] = {}
    plugins = config["plugins"]

    if "load" not in plugins or not isinstance(plugins["load"], dict):
        plugins["load"] = {}
    load = plugins["load"]

    if "paths" not in load or not isinstance(load["paths"], list):
        load["paths"] = []
    paths = load["paths"]

    if plugin_dir in paths:
        return False
    paths.append(plugin_dir)
    return True


def refresh_openclaw_plugin_registry() -> bool:
    """Rebuild OpenClaw's persisted plugin registry.

    The OpenClaw gateway boots from a persisted registry snapshot; installing
    or updating a plugin does not refresh it, so without this step the gateway
    keeps running the stale snapshot and never registers the plugin's hooks —
    even though the plugin shows as "loaded".
    """
    manual_hint = "    Run manually: openclaw plugins registry --refresh"
    if shutil.which("openclaw") is None:
        print(f"  {colored('!', 'yellow')} openclaw CLI not found in PATH")
        print(manual_hint)
        return False
    try:
        result = subprocess.run(
            ["openclaw", "plugins", "registry", "--refresh"],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"  {colored('✗', 'red')} plugin registry refresh failed ({type(e).__name__})")
        print(manual_hint)
        return False
    if result.returncode == 0:
        print(f"  {colored('✓', 'green')} plugin registry refreshed")
        return True
    else:
        print(f"  {colored('✗', 'red')} plugin registry refresh failed (exit {result.returncode})")
        print(manual_hint)
        return False


def install_openclaw(source: FileSource, cli_token: str = None) -> bool:
    """Install VibeMon plugin for OpenClaw."""
    openclaw_home = Path.home() / ".openclaw"
    if IS_WINDOWS:
        print(f"\n{colored('!', 'yellow')} OpenClaw is not supported on Windows yet. Skipping.")
        return SKIPPED
    if not is_tool_installed("openclaw", openclaw_home):
        print(f"\n{colored('!', 'yellow')} OpenClaw not detected. Skipping installation.")
        return SKIPPED

    print(f"\n{colored('Installing VibeMon Plugin for OpenClaw...', 'cyan')}\n")

    # The plugin reads transmission settings (http_urls, serial_port,
    # vibemon_url, vibemon_token) from ~/.vibemon/config.json as fallback,
    # so make sure it exists and holds the token.
    token = configure_vibemon_config(source, cli_token)
    ok = install_vibemon_shared(source)

    plugin_dir = openclaw_home / "extensions" / "vibemon-bridge"
    plugin_dir.mkdir(parents=True, exist_ok=True)

    print("Copying plugin files:")

    # openclaw.plugin.json
    content = source.get_file("openclaw/extensions/openclaw.plugin.json")
    ok &= write_file_with_diff(plugin_dir / "openclaw.plugin.json", content, "openclaw.plugin.json")

    # index.mjs
    content = source.get_file("openclaw/extensions/index.mjs")
    ok &= write_file_with_diff(plugin_dir / "index.mjs", content, "index.mjs")

    # Handle openclaw.json (merge, don't overwrite)
    print("\nConfiguring openclaw.json:")
    config_file = openclaw_home / "openclaw.json"

    # Transmission settings live in ~/.vibemon/config.json (shared with the
    # other tools and auto-managed by the Desktop app); the plugin reads them
    # as fallback. Only registration + enablement is written here.
    # hooks.allowConversationAccess is required by OpenClaw for non-bundled
    # plugins to register conversation hooks (agent_end); without it OpenClaw
    # silently blocks them with only a warn-level diagnostic.
    vibemon_plugin_config = {
        "enabled": True,
        "hooks": {"allowConversationAccess": True},
    }

    # Values older installers wrote into the plugin entry. They shadow the
    # shared-config fallback, so remove them when still at those defaults
    # (a user-customized value never matches and is preserved).
    stale_transmission_defaults = {
        "serialEnabled": (False,),
        "httpEnabled": (False,),
        "httpUrls": (["http://127.0.0.1:19280"],),
        "vibemonUrl": ("https://vibemon.io", ""),
        "vibemonToken": ("", token),
    }

    if config_file.exists():
        existing_config = load_json_or_backup(config_file)

        # Also makes `plugins` an object, so `entries` can be read below.
        if ensure_plugin_path_registered(existing_config, str(plugin_dir)):
            print(f"  {colored('✓', 'green')} plugin path registered in plugins.load.paths")
        entries = existing_config["plugins"].get("entries")
        if not isinstance(entries, dict):
            entries = existing_config["plugins"]["entries"] = {}

        # Merge vibemon-bridge plugin (preserve existing config if present)
        existing_plugin = entries.get("vibemon-bridge")
        if isinstance(existing_plugin, dict):
            plugin_cfg = existing_plugin.get("config")
            if isinstance(plugin_cfg, dict):
                removed = [
                    key for key, defaults in stale_transmission_defaults.items()
                    if key in plugin_cfg and plugin_cfg[key] in defaults
                ]
                for key in removed:
                    del plugin_cfg[key]
                if removed:
                    print(f"  {colored('✓', 'green')} moved to ~/.vibemon/config.json: {', '.join(removed)}")
                if not plugin_cfg:
                    del existing_plugin["config"]
            hooks_cfg = existing_plugin.get("hooks")
            if not isinstance(hooks_cfg, dict):
                hooks_cfg = existing_plugin["hooks"] = {}
            if hooks_cfg.get("allowConversationAccess") is not True:
                hooks_cfg["allowConversationAccess"] = True
                print(f"  {colored('✓', 'green')} hooks.allowConversationAccess enabled")
            print(f"  {colored('✓', 'green')} vibemon-bridge plugin already configured")
        else:
            entries["vibemon-bridge"] = vibemon_plugin_config
            print(f"  {colored('✓', 'green')} vibemon-bridge plugin added")

        write_text_atomic(config_file, json.dumps(existing_config, indent=2) + "\n")
        print(f"  {colored('✓', 'green')} openclaw.json updated (existing settings preserved)")
    else:
        new_config = {
            "plugins": {
                "entries": {
                    "vibemon-bridge": vibemon_plugin_config
                }
            }
        }
        ensure_plugin_path_registered(new_config, str(plugin_dir))
        write_text_atomic(config_file, json.dumps(new_config, indent=2) + "\n")
        print(f"  {colored('✓', 'green')} openclaw.json created")

    # Without a registry refresh the gateway keeps booting from a stale
    # plugin-registry snapshot and the plugin's hooks never run.
    print("\nRefreshing OpenClaw plugin registry:")
    ok = refresh_openclaw_plugin_registry() and ok

    if not ok:
        print(f"\n{colored('✗ OpenClaw installation is incomplete. Resolve the errors above and retry.', 'red')}")
        return False

    print(f"\n{colored('OpenClaw installation complete!', 'green')}")
    print(f"\n{colored('Next steps:', 'yellow')}")
    print("  1. Restart OpenClaw Gateway: openclaw gateway restart")
    print("  2. Check logs for: [vibemon] Plugin loaded")
    print(f"\n{colored('Config (shared, in ~/.vibemon/config.json):', 'yellow')}")
    print("  • http_urls:     Desktop App URLs (auto-managed by the Desktop app)")
    print("  • serial_port:   set to send status to ESP32 via USB")
    print("  • vibemon_url:   VibeMon cloud service URL (https://vibemon.io)")
    print("  • vibemon_token: Generated write token from https://vibemon.io/account")
    print(f"\n{colored('Overrides (optional, in ~/.openclaw/openclaw.json plugin config):', 'yellow')}")
    print("  • projectName, character, httpEnabled, httpUrls, serialEnabled,")
    print("    vibemonUrl, vibemonToken, autoLaunch, debug")

    return True


def install_opencode(source: FileSource, cli_token: str = None) -> bool:
    """Install VibeMon's plugin and hook adapter for opencode."""
    opencode_home = opencode_config_home()
    if not is_tool_installed("opencode", opencode_home):
        print(f"\n{colored('!', 'yellow')} opencode not detected. Skipping installation.")
        return SKIPPED

    print(f"\n{colored('Installing VibeMon for opencode...', 'cyan')}\n")

    # Shared assets: the adapter reads transmission settings from
    # ~/.vibemon/config.json through vibemon_core.py, like every other tool.
    configure_vibemon_config(source, cli_token)
    ok = install_vibemon_shared(source)

    # opencode auto-discovers plugins in its plugins dir at startup, so no
    # config registration is needed -- installing the plugin file is enough.
    (opencode_home / "hooks").mkdir(parents=True, exist_ok=True)
    (opencode_home / "plugins").mkdir(parents=True, exist_ok=True)

    print("Copying plugin files:")

    content = source.get_file("opencode/hooks/vibemon.py")
    ok &= write_file_with_diff(
        opencode_home / "hooks" / "vibemon.py", content,
        display_path(opencode_home / "hooks" / "vibemon.py"), executable=True,
    )

    # The plugin spawns the adapter with the interpreter/script baked in; on
    # Windows (no python3 on PATH) and custom homes the paths are inlined.
    plugin = adapt_opencode_plugin(source.get_file("opencode/plugin/vibemon.js"), opencode_home)
    ok &= write_file_with_diff(
        opencode_home / "plugins" / "vibemon.js", plugin,
        display_path(opencode_home / "plugins" / "vibemon.js"),
    )
    if IS_WINDOWS:
        print(f"  {colored('✓', 'green')} hook interpreter pinned to {hook_python()}")

    if not ok:
        print(f"\n{colored('✗ opencode installation finished with errors — some files were not written.', 'red')}")
        return False

    print(f"\n{colored('opencode installation complete!', 'green')}")
    print(f"\n{colored('Next steps:', 'yellow')}")
    print("  1. Restart opencode — the plugin is auto-discovered at startup")
    hook_path_display = display_path(opencode_home / "hooks" / "vibemon.py")
    print(f"  2. The plugin bridges events to {hook_path_display}")
    return True


def install_vibemon(source: FileSource, cli_token: str = None) -> bool:
    """Install/repair only the shared ~/.vibemon assets (scripts + config).

    Used by the Desktop app's "VibeMon Scripts" reinstall action; every
    platform installer already runs the same steps as part of its install.
    """
    print(f"\n{colored('Installing VibeMon shared scripts...', 'cyan')}\n")

    configure_vibemon_config(source, cli_token)
    ok = install_vibemon_shared(source)

    if not ok:
        print(f"\n{colored('✗ VibeMon shared scripts installation finished with errors — some files were not written.', 'red')}")
        return False

    print(f"\n{colored('VibeMon shared scripts installation complete!', 'green')}")
    return True


# MARK: Resource collector
#
# --collector installs the summary collector as a systemd service on a Linux
# host. DGX Spark is a Linux host: the collector detects its unified memory.
# --kubernetes runs the published collector image in the current kubectl
# context and reads the Kubernetes Metrics API. Both sign in to VibeMon
# (client "vibemon-collector") unless a write token is supplied.

COLLECTOR_MODULES = (
    "__init__.py", "__main__.py", "application.py", "disk.py", "domain.py", "health.py",
    "host.py", "http_deadline.py", "kubelet.py", "kubernetes.py", "prometheus.py", "transport.py",
)
COLLECTOR_FILES = tuple(f"collector/vibemon_collector/{name}" for name in COLLECTOR_MODULES)
PSUTIL_REQUIREMENT = "psutil>=5.9,<8"
# The multi-arch image (amd64, arm64) built by collector-image.yml.
COLLECTOR_IMAGE = "public.ecr.aws/z5d8x0d6/vibemon-collector@sha256:ac200839a44bd62c41ce2c1feb3a919b8308f6c029c0cac55b9a084382f9e93a"
KUBERNETES_NAMESPACE = "vibemon"
SOURCE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")

# Display name for the collector (--name); defaults to the host or context name.
SOURCE_NAME = None


def web_origin() -> str:
    """The Web origin that receives collector summaries: VIBEMON_URL or vibemon.io."""
    origin = checked_download_url(os.environ.get("VIBEMON_URL") or "https://vibemon.io")
    if urlsplit(origin).path not in ("", "/"):
        raise ValueError("VIBEMON_URL must be a VibeMon address without a path")
    return origin


def source_id(prefix: str, name: str) -> str:
    """A stable source ID such as host-dgx-spark, from a display name."""
    slug = re.sub(r"[^a-z0-9_.-]+", "-", name.lower()).strip("-.") or "default"
    value = f"{prefix}-{slug}"[:128]
    if not SOURCE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"Cannot derive a source ID from {name!r}; pass --name with letters and digits")
    return value


def collector_token(cli_token: str, saved: str, saved_origin: str, origin: str, name: str) -> str:
    """The write token: supplied, saved for the same origin (unless --login), or from a VibeMon sign-in.

    A saved token never moves to another Web origin: a new origin signs in again.
    """
    supplied = cli_token or os.environ.get("VIBEMON_WRITE_TOKEN")
    if supplied:
        validate_token(supplied)
        return supplied
    if saved and TOKEN_PATTERN.fullmatch(saved) and saved_origin == origin and not SIGN_IN:
        print(f"  {colored('✓', 'green')} Saved write token kept. Run with --login to sign in again.")
        return saved
    try:
        return sign_in_to_web(origin, "vibemon-collector", name)
    except SignInError as error:
        raise ValueError(str(error)) from None


def run_checked(command: list[str], description: str, input_text: str = None, env: dict = None, timeout: float = None) -> str:
    """Run a command; raise with its error output when it fails."""
    result = subprocess.run(command, input=input_text, capture_output=True, text=True, env=env, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()[-1:] or ["no output"]
        raise RuntimeError(f"{description} failed: {detail[0]}")
    return result.stdout


class CollectorPaths:
    """Where the host collector lives: system-wide for root, else per user."""

    def __init__(self, system: bool):
        self.system = system
        if system:
            self.base = Path("/opt/vibemon-collector")
            self.env_file = Path("/etc/vibemon/collector.env")
            self.unit = Path("/etc/systemd/system/vibemon-collector.service")
            self.state = Path("/var/lib/vibemon-collector")
            self.systemctl = ["systemctl"]
        else:
            data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
            config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
            state = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
            self.base = data / "vibemon-collector"
            self.env_file = config / "vibemon" / "collector.env"
            self.unit = config / "systemd" / "user" / "vibemon-collector.service"
            self.state = state / "vibemon-collector"
            self.systemctl = ["systemctl", "--user"]


def saved_collector_token(env_file: Path) -> tuple[str, str]:
    """The saved token and the Web origin that it belongs to, or empty strings."""
    try:
        match = re.fullmatch(r"VIBEMON_WRITE_TOKEN=(vm_[a-f0-9]{60})\nVIBEMON_URL=(\S+)\n?", env_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        # A file that another tool wrote in another encoding is not this installer's.
        return "", ""
    return (match.group(1), match.group(2)) if match else ("", "")


def collector_health(paths: CollectorPaths, runtime: Path = None) -> Path:
    """The readiness file. A release keeps its own, so another collector that
    shares the legacy state path cannot satisfy this installer's readiness check."""
    return runtime / "health" if runtime else paths.state / "health"


def collector_arguments(paths: CollectorPaths, origin: str, name: str, ident: str, runtime: Path = None) -> list[str]:
    directory = runtime or paths.base
    python = directory / "venv" / "bin" / "python"
    return [
        str(python), "-m", "vibemon_collector", "--source-id", ident, "--name", name, "--url", origin,
        "--kind", "host", "--memory-type", "auto", "--disk", "--health-file", str(collector_health(paths, runtime)),
    ]


def collector_unit(paths: CollectorPaths, origin: str, name: str, ident: str, runtime: Path = None) -> str:
    directory = runtime or paths.base
    env_file = runtime / "collector.env" if runtime else paths.env_file
    arguments = collector_arguments(paths, origin, name, ident, runtime)
    for value in arguments + [str(env_file), str(directory)]:
        if any(character in value for character in '\n\r"%\\'):
            raise ValueError("A collector path or name contains a character that systemd cannot use")
    # systemd: double quotes keep each argument whole; $$ is a literal dollar sign.
    command = " ".join('"' + value.replace("$", "$$") + '"' for value in arguments)
    return "\n".join([
        "# Managed by the VibeMon installer",
        *([f"# VibeMon runtime: {runtime}"] if runtime else []),
        "[Unit]",
        "Description=VibeMon resource collector",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        f"WorkingDirectory={directory}",
        f"ExecStart={command}",
        f'Environment="PYTHONPATH={directory / "app"}"',
        f"EnvironmentFile={env_file}",
        "Restart=on-failure",
        "RestartSec=10",
        # Exit code 2 means a permanent rejection (token, origin, clock): restarting cannot fix it.
        "RestartPreventExitStatus=2",
        "",
        "[Install]",
        f"WantedBy={'multi-user.target' if paths.system else 'default.target'}",
        "",
    ])


@contextmanager
def collector_lock(paths: CollectorPaths):
    """Keep the lock inode outside the removable runtime directory."""
    import fcntl

    paths.env_file.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(paths.env_file.parent / ".collector.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another collector installation or removal is running") from None
        yield
    finally:
        os.close(descriptor)


COLLECTOR_RELEASE_MARKER = "VibeMon collector runtime v1\n"
COLLECTOR_START_TIMEOUT_SECONDS = 180


def collector_unit_bytes(path: Path) -> bytes | None:
    if path.is_symlink() and not path.exists():
        raise RuntimeError("The collector unit link is broken; its ownership cannot be verified")
    return path.read_bytes() if path.exists() else None


def is_collector_runtime(paths: CollectorPaths, runtime: Path) -> bool:
    marker = runtime / ".vibemon-release"
    return runtime.parent.resolve() == (paths.base / "releases").resolve() and runtime.name.startswith("release-") \
        and not runtime.is_symlink() and marker.is_file() and marker.read_text() == COLLECTOR_RELEASE_MARKER


def owned_collector_runtime(paths: CollectorPaths, unit: str) -> Path | None:
    """Recognize only a release this installer created under its runtime root."""
    for line in unit.splitlines():
        if not line.startswith("# VibeMon runtime: "):
            continue
        runtime = Path(line.removeprefix("# VibeMon runtime: "))
        if is_collector_runtime(paths, runtime):
            return runtime
        raise RuntimeError("The collector unit names an unrecognized runtime; nothing was changed")
    return None


def collector_service_state(paths: CollectorPaths, timeout: float = 15) -> dict:
    output = run_checked(paths.systemctl + ["show", "vibemon-collector.service", "--property=FragmentPath,ActiveState,UnitFileState,MainPID"],
                         "Reading the collector service", timeout=timeout)
    state = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if not state.get("ActiveState") or "FragmentPath" not in state or "UnitFileState" not in state:
        raise RuntimeError("Cannot determine the collector service state")
    fragment = state["FragmentPath"]
    if fragment and Path(fragment).resolve() != paths.unit.resolve():
        raise RuntimeError("The collector service belongs to another unit; nothing was changed")
    return state


def wait_for_collector(paths: CollectorPaths, runtime: Path = None, clock=time.monotonic, sleep=time.sleep) -> None:
    """Require a newly accepted observation after the previous service stopped."""
    health = collector_health(paths, runtime)
    deadline = clock() + COLLECTOR_START_TIMEOUT_SECONDS
    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            break
        state = collector_service_state(paths, timeout=min(15, remaining))
        if state["ActiveState"] not in {"active", "activating", "reloading"}:
            raise RuntimeError("The collector stopped before VibeMon accepted an observation")
        try:
            acknowledged = float(health.read_text())
        except FileNotFoundError:
            pass
        except ValueError:
            raise RuntimeError("The collector readiness file is invalid") from None
        else:
            if not 0 <= time.time() - acknowledged < 120:
                raise RuntimeError("The collector readiness timestamp is invalid")
            return
        sleep(min(1, max(0, deadline - clock())))
    raise RuntimeError(f"VibeMon did not accept a collector observation within {COLLECTOR_START_TIMEOUT_SECONDS} seconds")


def verify_collector_runtime(paths: CollectorPaths, runtime: Path, arguments: list[str], token: str, process_root=Path("/proc")) -> None:
    """An accepted observation alone could come from an overridden older runtime."""
    state = collector_service_state(paths)
    if state["ActiveState"] != "active" or not state.get("MainPID", "").isdigit() or int(state["MainPID"]) <= 0:
        raise RuntimeError("The collector has no active process to verify")
    process = process_root / state["MainPID"]
    actual = (process / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
    environment = dict(entry.split(b"=", 1) for entry in (process / "environ").read_bytes().split(b"\0") if b"=" in entry)
    if actual != [os.fsencode(argument) for argument in arguments] or (process / "cwd").resolve() != runtime \
            or environment.get(b"PYTHONPATH") != os.fsencode(runtime / "app") \
            or environment.get(b"VIBEMON_WRITE_TOKEN") != token.encode("ascii") or environment.get(b"PYTHONHOME"):
        raise RuntimeError("The collector process does not use the prepared runtime; check systemd overrides")


def activate_collector(paths: CollectorPaths, runtime: Path, unit: str, previous: bytes | None, arguments: list[str], token: str) -> None:
    """Switch one unit to a complete runtime; restore the old unit on failure."""
    backup_dir = None
    try:
        state = collector_service_state(paths)
        if collector_unit_bytes(paths.unit) != previous:
            raise RuntimeError("The collector unit changed during preparation; nothing was replaced")
        was_active = state["ActiveState"] in {"active", "activating", "reloading"}
        was_enabled = state["UnitFileState"] in {"enabled", "enabled-runtime"}
        if was_active and previous is None:
            raise RuntimeError("A collector is running without this installer's unit")
        paths.unit.parent.mkdir(parents=True, exist_ok=True)
        backup_dir = Path(tempfile.mkdtemp(prefix=".vibemon-rollback-", dir=paths.unit.parent))
        backup = backup_dir / "unit"
        if previous is not None:
            shutil.copy2(paths.unit, backup, follow_symlinks=False)
    except BaseException:
        if backup_dir is not None:
            shutil.rmtree(backup_dir)
        shutil.rmtree(runtime)
        raise
    stopped = written = enabled = started = False
    try:
        if previous is not None:
            stopped = True
            run_checked(paths.systemctl + ["stop", "vibemon-collector.service"], "Stopping the previous collector", timeout=120)
        if collector_unit_bytes(paths.unit) != previous:
            raise RuntimeError("The collector unit changed while stopping; nothing was replaced")
        write_text_atomic(paths.unit, unit)
        written = True
        run_checked(paths.systemctl + ["daemon-reload"], "Reloading systemd", timeout=120)
        if not was_enabled:
            enabled = True
            run_checked(paths.systemctl + ["enable", "vibemon-collector.service"], "Enabling the collector", timeout=120)
        collector_health(paths, runtime).unlink(missing_ok=True)
        started = True
        run_checked(paths.systemctl + ["start", "vibemon-collector.service"], "Starting the collector", timeout=120)
        print("  Waiting for VibeMon to accept the first observation…")
        wait_for_collector(paths, runtime)
        verify_collector_runtime(paths, runtime, arguments, token)
        if collector_unit_bytes(paths.unit) != unit.encode("utf-8"):
            raise RuntimeError("The collector unit changed during activation")
    except BaseException as error:
        failures = []

        def restore(action):
            try:
                action()
            except Exception as failure:
                failures.append(str(failure))

        if started:
            restore(lambda: run_checked(paths.systemctl + ["stop", "vibemon-collector.service"], "Stopping the failed collector", timeout=120))
            restore(lambda: collector_health(paths, runtime).unlink(missing_ok=True))
        if enabled:
            restore(lambda: run_checked(paths.systemctl + ["disable", "vibemon-collector.service"], "Restoring collector enablement", timeout=120))
        if written:
            def restore_unit():
                if paths.unit.is_symlink() or paths.unit.read_bytes() != unit.encode("utf-8"):
                    raise RuntimeError("The unit was edited during installation; its backup was retained")
                if previous is None:
                    paths.unit.unlink()
                else:
                    os.replace(backup, paths.unit)
            restore(restore_unit)
            restore(lambda: run_checked(paths.systemctl + ["daemon-reload"], "Reloading the previous unit", timeout=120))
        if stopped and was_active and not failures:
            restore(lambda: run_checked(paths.systemctl + ["start", "vibemon-collector.service"], "Restoring the previous collector", timeout=120))
        if failures:
            raise RuntimeError(f"Collector upgrade failed and restoration is incomplete. Keep {runtime} and {backup_dir} for recovery. "
                               + "; ".join(failures)) from error
        shutil.rmtree(backup_dir)
        shutil.rmtree(runtime)
        raise
    shutil.rmtree(backup_dir)


def install_collector(source: FileSource, cli_token: str = None) -> bool:
    """Install the host collector as a systemd service (Linux, DGX Spark)."""
    print(f"\n{colored('Installing the resource collector for this host...', 'cyan')}")
    if platform.system() != "Linux" or not shutil.which("systemctl"):
        print(f"  {colored('!', 'yellow')} The host collector needs Linux with systemd. Use --kubernetes for a cluster.")
        return False
    if sys.version_info < (3, 10):
        print(f"  {colored('!', 'yellow')} The collector needs Python 3.10 or later.")
        return False
    paths = CollectorPaths(system=os.geteuid() == 0)
    with collector_lock(paths):
        return install_collector_locked(paths, source, cli_token)


def install_collector_locked(paths: CollectorPaths, source: FileSource, cli_token: str = None) -> bool:
    origin = web_origin()
    name = SOURCE_NAME or device_name()
    ident = source_id("host", name)
    previous = collector_unit_bytes(paths.unit)
    if previous is not None and b"# Managed by the VibeMon installer" not in previous:
        raise RuntimeError(f"{display_path(paths.unit)} exists and was not created by this installer")

    # Validate service arguments and ownership before requesting a new credential.
    collector_unit(paths, origin, name, ident)
    current = owned_collector_runtime(paths, previous.decode("utf-8")) if previous is not None else None
    service = collector_service_state(paths)
    if previous is None and service["ActiveState"] not in {"inactive", "failed"}:
        raise RuntimeError("A collector is running without this installer's unit")
    supplied = cli_token or os.environ.get("VIBEMON_WRITE_TOKEN")
    if supplied:
        validate_token(supplied)
    token_file = current / "collector.env" if current else paths.env_file

    releases = paths.base / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    # A venv embeds its absolute path: build at its final location, never rename it.
    runtime = Path(tempfile.mkdtemp(prefix="release-", dir=releases)).resolve()
    try:
        app_dir = runtime / "app" / "vibemon_collector"
        app_dir.mkdir(parents=True)
        for path in COLLECTOR_FILES:
            (app_dir / Path(path).name).write_text(source.get_file(path), encoding="utf-8")
        venv = runtime / "venv"
        run_checked([sys.executable, "-I", "-m", "venv", str(venv)], "Creating the Python environment", timeout=120)
        run_checked([str(venv / "bin" / "python"), "-I", "-m", "pip", "install", "--quiet", "--disable-pip-version-check", PSUTIL_REQUIREMENT], "Installing psutil", timeout=300)
        modules = tuple(f"vibemon_collector.{Path(filename).stem}" for filename in COLLECTOR_MODULES if filename != "__init__.py")
        verification = (
            f"import importlib,sys; sys.path.insert(0, {str(runtime / 'app')!r}); "
            f"[importlib.import_module(name) for name in {modules!r}]; "
            "sys.argv=['vibemon-collector','--help']; importlib.import_module('vibemon_collector.__main__').main()"
        )
        run_checked([str(venv / "bin" / "python"), "-I", "-c", verification], "Checking the collector", timeout=30)
        if collector_unit_bytes(paths.unit) != previous:
            raise RuntimeError("The collector unit changed during preparation; nothing was replaced")
        # A failed download or build must not create an unused sign-in credential.
        token = collector_token(cli_token, *saved_collector_token(token_file), origin, name)
        write_text_atomic(runtime / "collector.env", f"VIBEMON_WRITE_TOKEN={token}\nVIBEMON_URL={origin}\n", mode=0o600)
        (runtime / ".vibemon-release").write_text(COLLECTOR_RELEASE_MARKER)
        unit = collector_unit(paths, origin, name, ident, runtime)
    except BaseException:
        shutil.rmtree(runtime)
        raise
    activate_collector(paths, runtime, unit, previous, collector_arguments(paths, origin, name, ident, runtime), token)
    # The previous unit's legacy readiness file is no longer written by this installation.
    if previous is not None and os.fsencode(collector_health(paths)) in previous:
        collector_health(paths).unlink(missing_ok=True)
    # Only marked release directories belong to this layout. Keep legacy files.
    for previous_runtime in releases.iterdir():
        if previous_runtime.resolve() != runtime and is_collector_runtime(paths, previous_runtime):
            shutil.rmtree(previous_runtime)
    print(f"  {colored('✓', 'green')} Collector running as {ident} ({name}); VibeMon accepted its first observation.")
    if not paths.system:
        linger = subprocess.run(["loginctl", "show-user", getpass_user(), "-p", "Linger", "--value"], capture_output=True, text=True)
        if linger.stdout.strip() != "yes":
            print(f"  {colored('!', 'yellow')} To keep it running after you log out, run: sudo loginctl enable-linger {getpass_user()}")
    print(f"  Status: {' '.join(paths.systemctl)} status vibemon-collector")
    return True


def getpass_user() -> str:
    return os.environ.get("USER") or os.environ.get("LOGNAME") or "root"


def kubernetes_manifest(name: str, ident: str, origin: str, token: str) -> str:
    """Namespace, read-only RBAC, the token Secret, and the collector Deployment."""
    labels = {"app.kubernetes.io/name": "vibemon-collector", "app.kubernetes.io/managed-by": "vibemon-installer"}
    namespace = KUBERNETES_NAMESPACE
    documents = [
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace, "labels": labels}},
        {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": "vibemon-collector", "namespace": namespace, "labels": labels}},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": "vibemon-collector", "labels": labels},
         "rules": [{"apiGroups": [""], "resources": ["nodes", "pods"], "verbs": ["list"]},
                   {"apiGroups": ["metrics.k8s.io"], "resources": ["nodes"], "verbs": ["get", "list"]}]},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding", "metadata": {"name": "vibemon-collector", "labels": labels},
         "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "vibemon-collector"},
         "subjects": [{"kind": "ServiceAccount", "name": "vibemon-collector", "namespace": namespace}]},
        {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "vibemon-collector", "namespace": namespace, "labels": labels},
         "type": "Opaque", "stringData": {"VIBEMON_WRITE_TOKEN": token, "VIBEMON_URL": origin}},
        {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "vibemon-collector", "namespace": namespace, "labels": labels},
         "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": {"app.kubernetes.io/name": "vibemon-collector"}},
                  "template": {"metadata": {"labels": labels}, "spec": {
                      "serviceAccountName": "vibemon-collector", "nodeSelector": {"kubernetes.io/os": "linux"},
                      "securityContext": {"runAsNonRoot": True, "runAsUser": 65532, "runAsGroup": 65532, "seccompProfile": {"type": "RuntimeDefault"}},
                      "containers": [{
                          "name": "collector", "image": COLLECTOR_IMAGE,
                          "args": ["--source-id", ident, "--name", name, "--kind", "cluster", "--cluster-backend", "metrics-api",
                                   "--kubectl-command", "kubectl --cache-dir=/tmp/kubectl", "--url", origin, "--health-file", "/tmp/vibemon-health"],
                          "env": [{"name": "VIBEMON_WRITE_TOKEN", "valueFrom": {"secretKeyRef": {"name": "vibemon-collector", "key": "VIBEMON_WRITE_TOKEN"}}}],
                          "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                          "resources": {"requests": {"cpu": "25m", "memory": "64Mi"}, "limits": {"memory": "192Mi"}},
                          "readinessProbe": {"exec": {"command": ["python", "-m", "vibemon_collector.health", "/tmp/vibemon-health"]},
                                             "initialDelaySeconds": 30, "periodSeconds": 10, "timeoutSeconds": 2, "failureThreshold": 1},
                          "volumeMounts": [{"name": "temporary", "mountPath": "/tmp"}]}],
                      "volumes": [{"name": "temporary", "emptyDir": {"sizeLimit": "32Mi"}}]}}}},
    ]
    # kubectl reads a JSON List; the token stays out of process arguments.
    return json.dumps({"apiVersion": "v1", "kind": "List", "items": documents})


def install_kubernetes(source: FileSource, cli_token: str = None) -> bool:
    """Run the collector in the current kubectl context (Kubernetes Metrics API)."""
    print(f"\n{colored('Installing the resource collector for Kubernetes...', 'cyan')}")
    if not shutil.which("kubectl"):
        print(f"  {colored('!', 'yellow')} kubectl is required. Select the cluster with kubectl first.")
        return False
    context = run_checked(["kubectl", "config", "current-context"], "Reading the kubectl context").strip()
    print(f"  kubectl context: {colored(context, 'yellow')}")
    if not ask_yes_no(f"  Install into {context}?", default=True, unattended=True):
        print("  Skipped.")
        return SKIPPED
    if namespace_owner() == "other":
        raise RuntimeError(f"The namespace {KUBERNETES_NAMESPACE!r} exists and was not created by this installer")
    if subprocess.run(["kubectl", "get", "apiservice", "v1beta1.metrics.k8s.io"], capture_output=True).returncode != 0:
        print(f"  {colored('!', 'yellow')} metrics-server is not installed. Node and pod counts work; CPU and memory stay unavailable until it is installed.")
    origin = web_origin()
    name = SOURCE_NAME or context
    ident = source_id("k8s", name)
    token = collector_token(cli_token, *saved_secret(), origin, name)
    run_checked(["kubectl", "apply", "-f", "-"], "Applying the collector", kubernetes_manifest(name, ident, origin, token))
    # A new token or image needs a new pod.
    run_checked(["kubectl", "-n", KUBERNETES_NAMESPACE, "rollout", "restart", "deployment/vibemon-collector"], "Restarting the collector")
    # Ready means VibeMon accepted the first summary, so a rejected token never becomes ready.
    if subprocess.run(["kubectl", "-n", KUBERNETES_NAMESPACE, "rollout", "status", "deployment/vibemon-collector", "--timeout=180s"],
                      capture_output=True).returncode != 0:
        logs = subprocess.run(["kubectl", "-n", KUBERNETES_NAMESPACE, "logs", "deployment/vibemon-collector", "--tail=1"], capture_output=True, text=True)
        reason = logs.stdout.strip() or "no collector output"
        raise RuntimeError(f"The collector did not become ready: {reason}. Check with: kubectl -n {KUBERNETES_NAMESPACE} logs deployment/vibemon-collector")
    print(f"  {colored('✓', 'green')} Collector running in {context} as {ident} ({name}). It appears under Resources on VibeMon within a minute.")
    return True


def namespace_owner() -> str:
    """'none' when the namespace is absent, 'installer' when this installer created it, else 'other'."""
    result = subprocess.run(["kubectl", "get", "namespace", KUBERNETES_NAMESPACE, "-o", "jsonpath={.metadata.labels.app\\.kubernetes\\.io/managed-by}"],
                            capture_output=True, text=True)
    if result.returncode != 0:
        if "NotFound" in result.stderr:
            return "none"
        raise RuntimeError(f"Reading the namespace failed: {result.stderr.strip() or 'no output'}")
    return "installer" if result.stdout.strip() == "vibemon-installer" else "other"


def saved_secret() -> tuple[str, str]:
    """The token and Web origin in the collector Secret, or empty strings."""
    values = []
    for key in ("VIBEMON_WRITE_TOKEN", "VIBEMON_URL"):
        result = subprocess.run(["kubectl", "-n", KUBERNETES_NAMESPACE, "get", "secret", "vibemon-collector", "-o", f"jsonpath={{.data.{key}}}"],
                                capture_output=True, text=True)
        try:
            values.append(base64.b64decode(result.stdout).decode() if result.returncode == 0 and result.stdout else "")
        except ValueError:
            values.append("")
    return values[0], values[1]


def uninstall_collector(source: FileSource = None, cli_token: str = None) -> bool:
    paths = CollectorPaths(system=os.geteuid() == 0) if hasattr(os, "geteuid") else None
    if paths is None or not shutil.which("systemctl"):
        return SKIPPED
    with collector_lock(paths):
        unit = collector_unit_bytes(paths.unit)
        if unit is not None and b"# Managed by the VibeMon installer" not in unit:
            raise RuntimeError("The collector unit was not created by this installer; nothing was removed")
        service = collector_service_state(paths)
        if unit is None and service["ActiveState"] not in {"inactive", "failed"}:
            raise RuntimeError("A collector is running without this installer's unit; nothing was removed")
        if unit is not None:
            run_checked(paths.systemctl + ["disable", "--now", "vibemon-collector.service"], "Stopping and disabling the collector", timeout=120)
            remove_path(paths.unit, "collector service")
            run_checked(paths.systemctl + ["daemon-reload"], "Reloading systemd", timeout=120)
        releases = paths.base / "releases"
        if releases.exists():
            for runtime in releases.iterdir():
                if is_collector_runtime(paths, runtime):
                    remove_path(runtime, "collector runtime")
        # These are the package and venv of installations before versioned runtimes.
        remove_path(paths.base / "app" / "vibemon_collector", "legacy collector package")
        remove_path(paths.base / "venv", "legacy collector environment")
        # Another tool may share the legacy paths: remove only files in this installer's format or named by its unit.
        if unit is not None and os.fsencode(collector_health(paths)) in unit:
            remove_path(collector_health(paths), "collector readiness")
        if saved_collector_token(paths.env_file)[0]:
            remove_path(paths.env_file, "legacy collector token file")
        for directory in (paths.base / "app", releases, paths.base, paths.state):
            if directory.is_dir() and not directory.is_symlink() and not any(directory.iterdir()):
                directory.rmdir()
    print("  The token stays valid until you delete it on Web Account.")
    return True


def uninstall_kubernetes(source: FileSource = None, cli_token: str = None) -> bool:
    if not shutil.which("kubectl"):
        return SKIPPED
    context = run_checked(["kubectl", "config", "current-context"], "Reading the kubectl context").strip()
    print(f"  kubectl context: {colored(context, 'yellow')}")
    if not ask_yes_no(f"  Remove the collector from {context}?", default=True, unattended=True):
        return SKIPPED
    owner = namespace_owner()
    if owner == "other":
        raise RuntimeError(f"The namespace {KUBERNETES_NAMESPACE!r} was not created by this installer; nothing was removed")
    # A namespace label does not establish ownership of later user resources.
    # Keep the namespace and remove only the labeled objects we install.
    selector = "app.kubernetes.io/managed-by=vibemon-installer"
    run_checked(["kubectl", "delete", "clusterrolebinding,clusterrole", "-l", selector, "--ignore-not-found"], "Removing the collector RBAC")
    if owner == "installer":
        run_checked(["kubectl", "-n", KUBERNETES_NAMESPACE, "delete", "deployment,serviceaccount,secret", "-l", selector, "--ignore-not-found"], "Removing the collector workloads and credentials")
        print(f"  Kept namespace {KUBERNETES_NAMESPACE!r} and other resources.")
    print(f"  {colored('✓', 'green')} Removed the collector from {context}")
    print("  The token stays valid until you delete it on Web Account.")
    return True


def remove_path(path: Path, description: str) -> None:
    """Delete a file installed by VibeMon, reporting what happened."""
    if not path.exists():
        return
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
        print(f"  {colored('✓', 'green')} removed {description}")
    except OSError as e:
        raise RuntimeError(f"Could not remove {description}") from e


def _uninstall_hooks_from_json(config_file: Path, hooks_key_path: list, label: str) -> None:
    """Strip VibeMon hooks out of a JSON config, leaving user hooks in place.

    `hooks_key_path` walks to the object that *contains* the "hooks" map; the
    map itself is read from there. Both Codex's hooks.json and Kiro's
    agents/default.json keep it at the top level, so both pass [].
    """
    if not config_file.exists():
        return
    config = load_json_or_backup(config_file)
    container = config
    for key in hooks_key_path:
        container = container.get(key)
        if not isinstance(container, dict):
            return
    hook_map = container.get("hooks")
    if not isinstance(hook_map, dict):
        return

    cleaned = strip_all_vibemon_hooks(hook_map)
    if not cleaned:
        print(f"  {colored('✓', 'green')} no VibeMon hooks in {label}")
        return
    if not hook_map:
        container.pop("hooks", None)
    write_text_atomic(config_file, json.dumps(config, indent=2) + "\n")
    print(f"  {colored('✓', 'green')} removed VibeMon hooks from {label}: {', '.join(cleaned)}")


def uninstall_claude(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove VibeMon's hooks, statusLine and scripts from Claude Code."""
    claude_home = tool_home("CLAUDE_CONFIG_DIR", ".claude")
    if not claude_home.exists():
        print(f"\n{colored('!', 'yellow')} Claude Code not detected. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon from Claude Code...', 'cyan')}\n")
    settings_file = claude_home / "settings.json"

    if settings_file.exists():
        settings = load_json_or_backup(settings_file)
        changed = []

        hook_map = settings.get("hooks")
        if isinstance(hook_map, dict):
            cleaned = strip_all_vibemon_hooks(hook_map)
            if cleaned:
                changed.append(f"hooks ({', '.join(cleaned)})")
            if not hook_map:
                settings.pop("hooks", None)

        # Only drop statusLine when it is still pointing at VibeMon's script —
        # a user who switched to their own statusline keeps it.
        status_line = settings.get("statusLine")
        if isinstance(status_line, dict) and _uses_installed_script(status_line.get("command", ""), claude_home / "statusline.py"):
            del settings["statusLine"]
            changed.append("statusLine")

        if changed:
            write_text_atomic(settings_file, json.dumps(settings, indent=2) + "\n")
            print(f"  {colored('✓', 'green')} settings.json cleaned: {', '.join(changed)}")
        else:
            print(f"  {colored('✓', 'green')} settings.json had nothing to remove")

    remove_path(
        claude_home / "statusline.py", display_path(claude_home / "statusline.py")
    )
    remove_path(
        claude_home / "hooks" / "vibemon.py",
        display_path(claude_home / "hooks" / "vibemon.py"),
    )
    print(f"\n{colored('Claude Code cleanup complete!', 'green')}")
    return True


def uninstall_codex(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove VibeMon's hooks and script from Codex CLI."""
    codex_home = tool_home("CODEX_HOME", ".codex")
    if not codex_home.exists():
        print(f"\n{colored('!', 'yellow')} Codex CLI not detected. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon from Codex CLI...', 'cyan')}\n")
    # [], not ["hooks"]: hooks.json *is* {"hooks": {...events...}}, so the
    # event map sits at the top level.
    _uninstall_hooks_from_json(
        codex_home / "hooks.json", [], display_path(codex_home / "hooks.json")
    )
    remove_path(
        codex_home / "hooks" / "vibemon.py",
        display_path(codex_home / "hooks" / "vibemon.py"),
    )
    # Machine preferences are outside the VibeMon installer ownership.
    print(
        f"  {colored('!', 'yellow')} left "
        f"{display_path(codex_home / 'config.toml')} alone "
        "(generic hooks/status_line settings)"
    )
    print(f"\n{colored('Codex CLI cleanup complete!', 'green')}")
    return True


def uninstall_kiro(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove VibeMon's hooks and scripts from Kiro IDE and Kiro CLI."""
    kiro_home = tool_home("KIRO_HOME", ".kiro")
    if not kiro_home.exists():
        print(f"\n{colored('!', 'yellow')} Kiro not detected. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon from Kiro...', 'cyan')}\n")
    remove_legacy_kiro_hooks(kiro_home)
    for remote in KIRO_HOOK_CONFIG_FILES:
        target = kiro_home / "hooks" / Path(remote).name
        remove_path(target, display_path(target))
    remove_path(
        kiro_home / "hooks" / "vibemon.py",
        display_path(kiro_home / "hooks" / "vibemon.py"),
    )
    print(f"\n{colored('Kiro cleanup complete!', 'green')}")
    return True


def uninstall_openclaw(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove the VibeMon bridge plugin from OpenClaw."""
    openclaw_home = Path.home() / ".openclaw"
    if not openclaw_home.exists():
        print(f"\n{colored('!', 'yellow')} OpenClaw not detected. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon plugin from OpenClaw...', 'cyan')}\n")
    plugin_dir = openclaw_home / "extensions" / "vibemon-bridge"
    config_file = openclaw_home / "openclaw.json"

    if config_file.exists():
        config = load_json_or_backup(config_file)
        changed = []
        plugins = config.get("plugins")
        if isinstance(plugins, dict):
            entries = plugins.get("entries")
            if isinstance(entries, dict) and entries.pop("vibemon-bridge", None) is not None:
                changed.append("plugins.entries.vibemon-bridge")
            load = plugins.get("load")
            if isinstance(load, dict) and isinstance(load.get("paths"), list):
                kept = [p for p in load["paths"] if p != str(plugin_dir)]
                if len(kept) != len(load["paths"]):
                    load["paths"] = kept
                    changed.append("plugins.load.paths")
        if changed:
            write_text_atomic(config_file, json.dumps(config, indent=2) + "\n")
            print(f"  {colored('✓', 'green')} openclaw.json cleaned: {', '.join(changed)}")
        else:
            print(f"  {colored('✓', 'green')} openclaw.json had nothing to remove")

    if plugin_dir.exists():
        try:
            shutil.rmtree(plugin_dir)
            print(f"  {colored('✓', 'green')} removed {plugin_dir}")
        except OSError as e:
            raise RuntimeError("Could not remove the VibeMon OpenClaw plugin") from e

    print("\nRefreshing OpenClaw plugin registry:")
    if not refresh_openclaw_plugin_registry():
        print(f"\n{colored('✗ OpenClaw cleanup is incomplete. Refresh the plugin registry and retry.', 'red')}")
        return False
    print(f"\n{colored('OpenClaw cleanup complete!', 'green')}")
    return True


def uninstall_opencode(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove VibeMon's plugin and hook adapter from opencode."""
    opencode_home = opencode_config_home()
    if not opencode_home.exists():
        print(f"\n{colored('!', 'yellow')} opencode not detected. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon plugin from opencode...', 'cyan')}\n")

    # opencode registers nothing in its config: plugins in the plugins dir are
    # auto-discovered, so only VibeMon's own files need to be removed.
    remove_path(opencode_home / "plugins" / "vibemon.js",
                display_path(opencode_home / "plugins" / "vibemon.js"))
    remove_path(opencode_home / "hooks" / "vibemon.py",
                display_path(opencode_home / "hooks" / "vibemon.py"))

    print(f"\n{colored('opencode cleanup complete!', 'green')}")
    return True


def uninstall_vibemon(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove the shared ~/.vibemon scripts, keeping user config."""
    vibemon_home = Path.home() / ".vibemon"
    if not vibemon_home.exists():
        print(f"\n{colored('!', 'yellow')} ~/.vibemon not found. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon shared scripts...', 'cyan')}\n")
    for name in SHARED_SCRIPTS:
        remove_path(vibemon_home / name, f"~/.vibemon/{name}")
    # config.json holds the user's token and statusline.json their display
    # preferences; deleting either would make a reinstall lose real settings.
    print(f"  {colored('!', 'yellow')} kept ~/.vibemon/config.json and statusline.json "
          "(your token and display settings)")
    print("    Remove them yourself with: rm -rf ~/.vibemon")
    print(f"\n{colored('Shared scripts cleanup complete!', 'green')}")
    return True


UNINSTALLERS = {
    "claude": ("Claude Code", uninstall_claude),
    "codex": ("Codex CLI", uninstall_codex),
    "kiro": ("Kiro", uninstall_kiro),
    "openclaw": ("OpenClaw", uninstall_openclaw),
    "opencode": ("opencode", uninstall_opencode),
    "vibemon": ("VibeMon Scripts", uninstall_vibemon),
    "collector": ("Resource collector", uninstall_collector),
    "kubernetes": ("Kubernetes collector", uninstall_kubernetes),
}


def valid_token_arg(value: str) -> str:
    """Validate an explicitly supplied server-generated token."""
    if not TOKEN_PATTERN.match(value):
        raise argparse.ArgumentTypeError("invalid token format (use a generated write token)")
    return value


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="VibeMon Installation Script",
        epilog="""
Examples:
  Interactive mode:
    curl -fsSL https://vibemon.io/install/install.py | python3

  Sign in to VibeMon (shows a code to approve at vibemon.io/device):
    curl -fsSL https://vibemon.io/install/install.py | python3 - --claude --login

  Non-interactive (for AI agents):
    curl -fsSL https://vibemon.io/install/install.py | python3 - --claude
    curl -fsSL https://vibemon.io/install/install.py | python3 - --codex
    curl -fsSL https://vibemon.io/install/install.py | python3 - --opencode
    # Supply VIBEMON_WRITE_TOKEN through the environment.
    curl -fsSL https://vibemon.io/install/install.py | python3 - --all --yes

  Windows PowerShell:
    irm https://vibemon.io/install/install.ps1 | iex
    & ([scriptblock]::Create((irm https://vibemon.io/install/install.ps1))) --claude

  Resource collector (signs in to VibeMon):
    curl -fsSL https://vibemon.io/install/install.py | python3 - --collector
    curl -fsSL https://vibemon.io/install/install.py | python3 - --kubernetes --name "Production"

  Uninstall:
    curl -fsSL https://vibemon.io/install/install.py | python3 - --uninstall --claude
    curl -fsSL https://vibemon.io/install/install.py | python3 - --uninstall --all

Exit status is 0 only when every selected platform succeeded. A platform whose
tool isn't installed is reported as skipped and does not fail a run where
another selected platform succeeded; a run in which nothing succeeded exits 1.
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    # Platform selection (mutually exclusive for single, but --all overrides)
    parser.add_argument("--claude", action="store_true",
                        help="Install for Claude Code")
    parser.add_argument("--codex", action="store_true",
                        help="Install for Codex CLI")
    parser.add_argument("--kiro", action="store_true",
                        help="Install for Kiro IDE and Kiro CLI")
    parser.add_argument("--openclaw", action="store_true",
                        help="Install for OpenClaw")
    parser.add_argument("--opencode", action="store_true",
                        help="Install for opencode")
    parser.add_argument("--all", action="store_true",
                        help="Install for all platforms")
    parser.add_argument("--vibemon", action="store_true",
                        help="Install only the shared ~/.vibemon scripts and config")
    parser.add_argument("--collector", action="store_true",
                        help="Install the resource collector for this Linux host or DGX Spark (systemd)")
    parser.add_argument("--kubernetes", action="store_true",
                        help="Install the resource collector in the current kubectl context")
    parser.add_argument("--name", metavar="NAME",
                        help="Display name of the collected resource; defaults to the host or context name")

    # Configuration options
    parser.add_argument("--login", action="store_true",
                        help="Sign in to VibeMon and save a new write token, even when one is saved")
    parser.add_argument("--token", type=valid_token_arg, metavar="TOKEN",
                        help="Generated write token; prefer VIBEMON_WRITE_TOKEN to keep it out of process arguments")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="Auto-approve all prompts, including replacing an existing "
                             "statusLine. Does not select a platform by itself; combine with "
                             "--claude/--codex/--kiro/--openclaw/--opencode/--all, otherwise the "
                             "interactive menu still appears. Without it, an unattended run "
                             "leaves user-owned settings untouched")
    parser.add_argument("--uninstall", action="store_true",
                        help="Remove VibeMon's hooks, statusLine and scripts for the selected "
                             "platforms instead of installing. User config in ~/.vibemon is kept")

    return parser.parse_args()


def run_install(platform_name: str, install_fn, source: FileSource, cli_token: str = None):
    """Run one platform's installer/uninstaller, isolating exceptions so one
    platform's failure doesn't abort the rest.

    Returns True (done), False (failed) or SKIPPED (tool not present).
    """
    try:
        return install_fn(source, cli_token)
    except IntegrityError as e:
        print(f"\n{colored('✗', 'red')} {platform_name} aborted: {e}")
        return False
    except Exception as e:
        print(f"\n{colored('✗', 'red')} {platform_name} failed: {e}")
        return False


INSTALLERS = {
    "claude": ("Claude Code", install_claude),
    "codex": ("Codex CLI", install_codex),
    "kiro": ("Kiro", install_kiro),
    "openclaw": ("OpenClaw", install_openclaw),
    "opencode": ("opencode", install_opencode),
    "vibemon": ("VibeMon Scripts", install_vibemon),
    "collector": ("Resource collector", install_collector),
    "kubernetes": ("Kubernetes collector", install_kubernetes),
}

# --all covers the five tools; the shared ~/.vibemon scripts ride along with
# each of them, so "vibemon" is only selected explicitly.
ALL_PLATFORMS = ("claude", "codex", "kiro", "openclaw", "opencode")

MENU_CHOICES = [
    ("1", "claude", "Claude Code"),
    ("2", "codex", "Codex CLI"),
    ("3", "kiro", "Kiro"),
    ("4", "openclaw", "OpenClaw"),
    ("5", "opencode", "opencode"),
    ("6", "all", "All"),
    ("7", "vibemon", "VibeMon scripts only"),
    ("8", "collector", "Resource collector for this Linux host or DGX Spark"),
    ("9", "kubernetes", "Resource collector for the current Kubernetes context"),
]


def selected_platforms(args) -> list:
    """Platform keys chosen on the command line, in a stable order."""
    if args.all:
        return list(ALL_PLATFORMS)
    return [key for key in INSTALLERS if getattr(args, key)]


def report_and_exit(results: list, action: str) -> None:
    """Summarize per-platform outcomes and exit with a status that reflects them.

    Exit 0 requires every selected platform to have succeeded, so CI and the
    Desktop app can see a partial failure.
    """
    done = [name for name, result in results if result is True]
    failed = [name for name, result in results if result is False]
    skipped = [name for name, result in results if result is SKIPPED]

    if skipped:
        print(f"\n{colored('!', 'yellow')} Skipped (tool not installed): {', '.join(skipped)}")
    if failed:
        if done:
            print(f"{colored('✓', 'green')} {action} succeeded: {', '.join(done)}")
        print(f"\n{colored('✗', 'red')} {action} failed: {', '.join(failed)}\n")
        sys.exit(1)
    if not done:
        verb = "uninstalled" if action == "Uninstall" else "installed"
        print(f"\n{colored('!', 'yellow')} Nothing was {verb}.\n")
        sys.exit(1)

    # Hooks load when the coding tool starts; collectors are already running.
    collectors = {INSTALLERS["collector"][0], INSTALLERS["kubernetes"][0]}
    suffix = " Restart your IDE to apply changes." if action == "Install" and set(done) - collectors else ""
    print(f"\n{colored('Done!', 'green')}{suffix}\n")


def main():
    """Main entry point."""
    global AUTO_APPROVE, NON_INTERACTIVE, SIGN_IN, SOURCE_NAME

    args = parse_args()
    SIGN_IN = args.login
    SOURCE_NAME = args.name
    platforms = selected_platforms(args)

    # A platform flag means "skip the menu", not "approve overwriting my
    # config" — only --yes grants that.
    AUTO_APPROVE = args.yes

    # Enable interactive input when running via curl pipe (only if a menu is
    # actually going to be shown), then decide whether prompts are usable.
    if not platforms:
        setup_tty_input()
    NON_INTERACTIVE = bool(platforms) or not sys.stdin.isatty()

    # Determine if running locally or online
    # Note: __file__ is in globals(), not dir() (which returns local vars inside a function)
    script_path = Path(__file__).parent.resolve() if "__file__" in globals() else None
    source = FileSource(script_path)

    mode = "online" if source.is_online else "local"
    action = "Uninstall" if args.uninstall else "Install"
    registry = UNINSTALLERS if args.uninstall else INSTALLERS

    print(f"\n{colored('╔════════════════════════════════════════╗', 'cyan')}")
    print(f"{colored('║', 'cyan')}     VibeMon Installation Script        {colored('║', 'cyan')}")
    print(f"{colored('╚════════════════════════════════════════╝', 'cyan')}")
    print(f"  Mode: {colored(mode, 'yellow')}  Action: {colored(action.lower(), 'yellow')}")

    if not args.uninstall:
        load_manifest(source)

    if not platforms:
        print(f"\nSelect platform to {action.lower()}:")
        for key, _, label in MENU_CHOICES:
            print(f"  {colored(key + ')', 'cyan')} {label}")
        print(f"  {colored('q)', 'cyan')} Quit")

        valid = {key: name for key, name, _ in MENU_CHOICES}
        valid.update({name: name for _, name, _ in MENU_CHOICES})
        keys = [key for key, _, _ in MENU_CHOICES]
        while True:
            try:
                choice = input(f"\nYour choice [{'/'.join(keys)}/q]: ").strip().lower()
            except EOFError:
                print("\nCancelled.")
                sys.exit(0)
            if choice in ("q", "quit", "exit"):
                print("\nCancelled.")
                sys.exit(0)
            if choice in valid:
                picked = valid[choice]
                platforms = list(ALL_PLATFORMS) if picked == "all" else [picked]
                break
            print(f"Please enter {', '.join(keys)}, or q")

    # args.token applies to menu and flag selections alike.
    results = [
        (registry[key][0], run_install(registry[key][0], registry[key][1], source, args.token))
        for key in platforms
    ]
    report_and_exit(results, action)


if __name__ == "__main__":
    try:
        main()
    except IntegrityError as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        sys.exit(1)
