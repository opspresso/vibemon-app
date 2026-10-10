#!/usr/bin/env python3
"""
VibeMon Installation Script
Installs hooks and configuration for Claude Code, Codex, Kiro IDE, OpenClaw, or
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
against the manifest's "installer" hash before running it.
"""

import argparse
import difflib
import hashlib
import getpass
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError


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

# Shared configuration example file
CONFIG_EXAMPLE_FILE = "vibemon/config.example.json"

# Claude Code statusline display configuration example file
STATUSLINE_EXAMPLE_FILE = "vibemon/statusline.example.json"

# Kiro IDE 0.x / CLI 2.x hook definitions removed during migration. Current
# Kiro uses a single v1 config at ~/.kiro/hooks/vibemon.json.
KIRO_HOOK_CONFIG_FILE = "kiro/hooks/vibemon.json"
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
    global AUTO_APPROVE, NON_INTERACTIVE
    if AUTO_APPROVE:
        return True
    if NON_INTERACTIVE:
        return default if unattended is None else unattended
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        try:
            answer = input(f"{question} {suffix}: ").strip().lower()
        except EOFError:
            return default
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("Please answer 'y' or 'n'")


def mask_token(token: str) -> str:
    """Mask a token, showing only first 4 and last 4 characters."""
    if not token or len(token) <= 8:
        return "****"
    return f"{token[:4]}{'*' * (len(token) - 8)}{token[-4:]}"


TOKEN_PATTERN = re.compile(r"^vm_[a-f0-9]{60}$")


def validate_token(token: str) -> None:
    """Accept only the server-generated API credential format."""
    if not TOKEN_PATTERN.fullmatch(token):
        raise ValueError("Enter a generated write token from https://vibemon.io/account")


def configure_token(config: dict, cli_token: str = None) -> dict:
    """Configure a write credential from CLI, environment, or hidden input."""
    global AUTO_APPROVE, NON_INTERACTIVE
    current_token = config.get("vibemon_token", "")

    print(f"\n{colored('VibeMon API Token Configuration:', 'cyan')}")
    print("  Create a write token at https://vibemon.io/account")

    supplied = cli_token or os.environ.get("VIBEMON_WRITE_TOKEN")
    if supplied:
        validate_token(supplied)
        config["vibemon_token"] = supplied
        print(f"  {colored('✓', 'green')} Write token configured")
        return config

    # No prompt available and no --token: keep whatever is already configured.
    if AUTO_APPROVE or NON_INTERACTIVE:
        if current_token:
            print(f"  {colored('✓', 'green')} Token unchanged: {mask_token(current_token)}")
        else:
            print(f"  {colored('!', 'yellow')} No token configured (set VIBEMON_WRITE_TOKEN)")
        return config

    # Interactive mode
    if current_token:
        print(f"  Current token: {colored(mask_token(current_token), 'yellow')}")
        if ask_yes_no("  Change token?", default=False):
            try:
                new_token = getpass.getpass("  Enter new token: ").strip()
                if new_token:
                    validate_token(new_token)
                    config["vibemon_token"] = new_token
                    print(f"  {colored('✓', 'green')} Token updated")
                else:
                    print(f"  {colored('!', 'yellow')} Token unchanged (empty input)")
            except EOFError:
                print(f"  {colored('!', 'yellow')} Token unchanged")
        else:
            print(f"  {colored('✓', 'green')} Token unchanged")
    else:
        print(f"  No token configured.")
        try:
            token = getpass.getpass("  Enter token (or press Enter to skip): ").strip()
            if token:
                validate_token(token)
                config["vibemon_token"] = token
                print(f"  {colored('✓', 'green')} Token saved")
            else:
                print(f"  {colored('!', 'yellow')} Token skipped")
        except EOFError:
            print(f"  {colored('!', 'yellow')} Token skipped")

    return config


def load_or_create_config(config_path: Path, example_content: str, fallback: dict = None) -> dict:
    """Load existing config or create from example.

    `fallback` is used if `example_content` itself fails to parse (e.g. a
    corrupted download); defaults to the vibemon config.json shape for
    backward compatibility with existing callers.
    """
    if config_path.exists():
        # Copy it aside before the defaults below get saved over it — it may
        # hold a hand-edited vibemon_token.
        backup_file(config_path)
        try:
            with open(config_path, encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError:
            print(f"  {colored('!', 'yellow')} {config_path.name} had invalid JSON — falling back to defaults")

    # Parse example content
    try:
        return json.loads(example_content)
    except json.JSONDecodeError:
        if fallback is not None:
            return fallback
        return {
            "debug": False,
            "cache_path": "~/.vibemon/cache/projects.json",
            "auto_launch": True,
            "http_urls": [],
            "serial_port": None,
            "vibemon_url": "https://vibemon.io",
            "vibemon_token": ""
        }


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
        with open(tmp, "w", encoding="utf-8", newline="") as f:
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
    """Load JSON from path, copying it to .bak before it gets overwritten."""
    backup_file(path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"  {colored('!', 'yellow')} {path.name} had invalid JSON — starting from an empty config")
        return {}


def download_file(url: str) -> str:
    """Download a file from URL and return its content."""
    try:
        with urlopen(url, timeout=30) as response:
            return response.read().decode("utf-8")
    except (URLError, OSError) as e:
        # URLError is an OSError subclass, but a stalled read raises the bare
        # OSError/TimeoutError. Both must reach the integrity failure path.
        raise RuntimeError(f"Failed to download {url}: {e}")


MANIFEST_PATH = "manifest.json"

# sha256 of every file the installer copies verbatim, keyed by source path.
# Local checkouts are read directly. Remote source requires a valid manifest.
REMOTE_MANIFEST = {}
_MANIFEST_LOADED = False


class IntegrityError(RuntimeError):
    """A downloaded file did not match its manifest.json sha256."""


def load_manifest(source) -> dict:
    """Require a complete integrity reference before downloading remote files."""
    global _MANIFEST_LOADED, REMOTE_MANIFEST
    if not source.is_online:
        return {}
    if _MANIFEST_LOADED:
        return REMOTE_MANIFEST
    try:
        files = json.loads(download_file(f"{DOCS_BASE_URL}/{MANIFEST_PATH}"))["files"]
        if not isinstance(files, dict) or not files or any(not isinstance(key, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) for key, digest in files.items()):
            raise ValueError("Invalid manifest")
    except (RuntimeError, ValueError, KeyError, TypeError) as error:
        raise IntegrityError("Cannot verify installation files. Publish the source and manifest together, then retry.") from error
    REMOTE_MANIFEST = files
    _MANIFEST_LOADED = True
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


def _is_vibemon_hook(hook: dict) -> bool:
    """True when a hook entry runs a VibeMon script (Claude/Codex or Kiro format)."""
    if "vibemon.py" in hook.get("command", ""):
        return True
    if "vibemon.py" in hook.get("commandWindows", ""):
        return True
    return any("vibemon.py" in arg for arg in hook.get("args", []))


def _hook_identity(hook: dict) -> str:
    """Stable identity for a hook across Claude/Codex (`command`, plus Codex's
    optional `commandWindows` override) and Kiro/exec-form (`command` + `args`)
    shapes."""
    parts = [hook.get("command", "")]
    parts.extend(hook.get("args", []))
    if hook.get("commandWindows"):
        parts.append(hook["commandWindows"])
    return " ".join(parts).strip()


def _packaged_identities(entries: list) -> set:
    """Every hook identity the packaged config registers under one event."""
    identities = set()
    for entry in entries or []:
        if "hooks" in entry:
            identities.update(_hook_identity(h) for h in entry.get("hooks", []))
        else:
            identities.add(_hook_identity(entry))
    return identities


def _prune_vibemon_hooks(existing: dict, keep_for_event) -> list:
    """Drop VibeMon hook entries that `keep_for_event(event)` doesn't list.

    `keep_for_event` returns the set of hook identities to preserve under an
    event; everything else belonging to VibeMon is removed. Only VibeMon's own
    entries are touched — user hooks under the same events are preserved.
    Mutates `existing` and returns the list of changed event names.
    """
    changed_events = []
    for event in list(existing.keys()):
        keep = keep_for_event(event)
        cleaned_entries = []
        changed = False
        for entry in existing[event]:
            if "hooks" in entry:
                entry_hooks = entry.get("hooks") or []
                kept = [
                    h for h in entry_hooks
                    if not _is_vibemon_hook(h) or _hook_identity(h) in keep
                ]
                if len(kept) != len(entry_hooks):
                    changed = True
                    if kept:
                        cleaned_entries.append({**entry, "hooks": kept})
                else:
                    cleaned_entries.append(entry)
            elif _is_vibemon_hook(entry) and _hook_identity(entry) not in keep:
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


def remove_stale_vibemon_hooks(existing: dict, new_hooks: dict) -> list:
    """Drop VibeMon hook registrations the packaged config no longer uses.

    Two kinds of staleness are cleaned:
      * events the packaged config dropped entirely after a lifecycle change —
        leaving them would keep invoking vibemon.py with events the script no
        longer maps;
      * VibeMon entries under a still-used event whose command no longer
        matches the packaged one. merge_hooks() dedupes by command, so moving
        the hook to a new path would otherwise *add* the new entry and leave
        the old one pointing at a script the installer just removed.

    Mutates `existing` and returns the list of cleaned event names.
    """
    return _prune_vibemon_hooks(
        existing, lambda event: _packaged_identities(new_hooks.get(event))
    )


def strip_all_vibemon_hooks(existing: dict) -> list:
    """Remove every VibeMon hook registration, preserving user hooks. Used by --uninstall."""
    return _prune_vibemon_hooks(existing, lambda event: set())


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


def _shell_quote(value: str, windows: bool = None) -> str:
    """Quote a path for a shell-form command, only when it actually needs it."""
    if not (IS_WINDOWS if windows is None else windows):
        return shlex.quote(value)
    return f'"{value}"' if " " in value else value


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
    """Build a shell-form command the shell Claude Code picks can actually run.

    Unquoted forward-slash paths run in both Git Bash and PowerShell, and so
    does a quoted *argument*, so most commands stay shell-agnostic. Only a
    quoted first token forces a choice: PowerShell needs the call operator `&`
    in front of it, which Git Bash would read as backgrounding the command.
    """
    command = f"{_shell_quote(python, windows=True)} {_shell_quote(script, windows=True)}"
    if " " in python and not has_git_bash():
        return f"& {command}"
    return command


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
                        hook["command"] = f"{python} {_shell_quote(hook_script)}"

    status_line = settings.get("statusLine")
    if isinstance(status_line, dict) and "statusline.py" in status_line.get("command", ""):
        status_line["command"] = (
            windows_shell_command(python, statusline_script) if IS_WINDOWS
            else f"{python} {_shell_quote(statusline_script)}"
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

    command = "{} {}".format(
        _shell_quote(hook_python() if IS_WINDOWS else "python3"),
        _shell_quote(hook_path(codex_home / "hooks" / "vibemon.py")),
    )

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

    The quoting is deliberately conservative: unquoted forward-slash paths run
    under cmd.exe, Git Bash and PowerShell alike, and quotes are added only
    where a space forces them.
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
        action["command"] = " ".join([
            _shell_quote(hook_python() if IS_WINDOWS else "python3"),
            _shell_quote(hook_path(kiro_home / "hooks" / "vibemon.py")),
            *event_args,
        ])
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
            url = f"{DOCS_BASE_URL}/{path}"
            content = download_file(url)
            verify_content(path, content)
            return content
        else:
            return (self.local_dir / path).read_text(encoding="utf-8")


def is_tool_installed(commands: str | tuple[str, ...], home_dir: Path) -> bool:
    """Check for any supported CLI command or an existing config directory."""
    if isinstance(commands, str):
        commands = (commands,)
    return any(shutil.which(command) is not None for command in commands) or home_dir.exists()


# Caches the resolved token so ~/.vibemon/config.json is only configured once per run
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
    and provider-freshness cache contract; vibemon_core.py is the shared
    transport module imported by every per-tool hook. All belong to every
    installation, not just Claude Code's.
    """
    if "shared_installed" in VIBEMON_CONFIG_CACHE:
        return VIBEMON_CONFIG_CACHE["shared_installed"]

    content = source.get_file("vibemon/http_client.py")
    ok = write_file_with_diff(Path.home() / ".vibemon" / "http_client.py", content, "~/.vibemon/http_client.py")

    content = source.get_file("vibemon/cache_io.py")
    ok = write_file_with_diff(Path.home() / ".vibemon" / "cache_io.py", content, "~/.vibemon/cache_io.py") and ok

    content = source.get_file("vibemon/account_context.py")
    ok = write_file_with_diff(Path.home() / ".vibemon" / "account_context.py", content, "~/.vibemon/account_context.py") and ok

    # Install the refresher only after its account-identity dependency.
    content = source.get_file("vibemon/usage.py")
    ok = write_file_with_diff(Path.home() / ".vibemon" / "usage.py", content, "~/.vibemon/usage.py", executable=True) and ok

    # usage_cache.py -> ~/.vibemon/usage_cache.py
    content = source.get_file("vibemon/usage_cache.py")
    ok = write_file_with_diff(Path.home() / ".vibemon" / "usage_cache.py", content, "~/.vibemon/usage_cache.py") and ok

    # vibemon_core.py -> ~/.vibemon/vibemon_core.py
    content = source.get_file("vibemon/vibemon_core.py")
    ok = write_file_with_diff(Path.home() / ".vibemon" / "vibemon_core.py", content, "~/.vibemon/vibemon_core.py") and ok

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
    # fallback={}: statusline.json has no config.json-shaped default worth
    # falling back to; an empty dict just leaves every show_*/usage_* toggle
    # at statusline.py's own coded-in defaults, which is the safest state.
    statusline_config = load_or_create_config(statusline_path, statusline_content, fallback={})

    if is_new:
        print("  Creating new config at ~/.vibemon/statusline.json")
        if config_path.exists():
            try:
                legacy = json.loads(config_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                legacy = {}
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
        if not isinstance(existing_settings, dict):
            existing_settings = {}

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
                print(f"\n  Current statusLine: {colored(existing_cmd, 'yellow')}")
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
            print(f"\n  Current statusLine is not an object: {colored(str(status_line), 'yellow')}")
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


CODEX_STATUS_LINE_ITEMS = [
    "model-with-reasoning",
    "current-dir",
    "git-branch",
    "context-used",
    "context-window-size",
]


def ensure_codex_status_line(config_text: str) -> str:
    """Ensure Codex's status line includes context-window usage."""
    tui_match = re.search(r"(?ms)^\[tui\]\n(.*?)(?=^\[|\Z)", config_text)
    if tui_match:
        section = tui_match.group(0)
        # Match an array value whether it is inline (`status_line = ["a"]`) or
        # multi-line. Anchoring the close on a column-zero `]` (the old regex)
        # missed inline arrays and spliced items in without a separating comma
        # when the multi-line list lacked a trailing comma, producing invalid
        # TOML — a duplicate key or an unterminated element.
        status_line_match = re.search(r"(?ms)^status_line\s*=\s*\[(.*?)\]", section)
        if status_line_match:
            # Only rebuild plain basic-string arrays. Literal strings, escapes,
            # comments and brackets inside strings require a TOML parser; keep
            # that user configuration intact instead of extracting partial values.
            if not re.fullmatch(
                r'\s*(?:"[^"\\\n]*"\s*(?:,\s*"[^"\\\n]*"\s*)*,?\s*)?',
                status_line_match.group(1),
            ):
                print("  Warning: preserving unsupported Codex status_line syntax")
                return config_text
            existing_items = re.findall(r'"([^"]+)"', status_line_match.group(1))
            missing_items = [
                item for item in CODEX_STATUS_LINE_ITEMS if item not in existing_items
            ]
            if not missing_items:
                return config_text
            rebuilt = "status_line = [\n"
            for item in (*existing_items, *missing_items):
                rebuilt += f'  "{item}",\n'
            rebuilt += "]"
            updated_section = (
                section[:status_line_match.start()]
                + rebuilt
                + section[status_line_match.end():]
            )
        elif re.search(r"(?m)^status_line\s*=", section):
            # A non-array value (e.g. a bare string) can't be merged; replace it
            # wholesale rather than appending a second, duplicate `status_line`.
            status_line = "status_line = [\n"
            status_line += "".join(f'  "{item}",\n' for item in CODEX_STATUS_LINE_ITEMS)
            status_line += "]"
            updated_section = re.sub(
                r"(?m)^status_line[^\n]*", status_line, section, count=1
            )
        else:
            status_line = "status_line = [\n"
            status_line += "".join(f'  "{item}",\n' for item in CODEX_STATUS_LINE_ITEMS)
            status_line += "]\n"
            updated_section = section.rstrip() + "\n" + status_line
        return config_text[:tui_match.start()] + updated_section + config_text[tui_match.end():]

    status_line = "[tui]\nstatus_line = [\n"
    status_line += "".join(f'  "{item}",\n' for item in CODEX_STATUS_LINE_ITEMS)
    status_line += "]\n\n"
    nested_tui_match = re.search(r"(?m)^\[tui\.", config_text)
    if nested_tui_match:
        return (
            config_text[:nested_tui_match.start()]
            + status_line
            + config_text[nested_tui_match.start():]
        )

    suffix = "" if config_text.endswith("\n") else "\n"
    return config_text + suffix + "\n" + status_line.rstrip() + "\n"


def prepare_codex_config(config_text: str) -> str:
    """Add VibeMon's status items without overriding the hook preference.

    Codex hooks are enabled by default. An explicit `[features].hooks = false`
    is therefore a user choice and must survive installation unchanged.
    """
    return ensure_codex_status_line(config_text)


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
        if not isinstance(existing_hooks, dict):
            existing_hooks = {}

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

    print("\nConfiguring config.toml:")
    config_toml_file = codex_home / "config.toml"
    if config_toml_file.exists():
        backup_file(config_toml_file)
        existing_toml = config_toml_file.read_text(encoding="utf-8")
        updated_toml = prepare_codex_config(existing_toml)
        write_text_atomic(config_toml_file, updated_toml)
        print(
            f"  {colored('✓', 'green')} status line configured in "
            f"{display_path(config_toml_file)}"
        )
    else:
        write_text_atomic(config_toml_file, source.get_file("codex/config.toml"))
        print(f"  {colored('✓', 'green')} {display_path(config_toml_file)} created")

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
    _uninstall_hooks_from_json(
        kiro_home / "agents" / "default.json", [],
        display_path(kiro_home / "agents" / "default.json"),
    )
    for hook_file in LEGACY_KIRO_HOOK_FILES:
        remove_path(
            kiro_home / "hooks" / hook_file,
            display_path(kiro_home / "hooks" / hook_file),
        )


def install_kiro(source: FileSource, cli_token: str = None) -> bool:
    """Install VibeMon for Kiro IDE."""
    kiro_home = tool_home("KIRO_HOME", ".kiro")
    if not is_tool_installed(("kiro", "kiro-cli"), kiro_home):
        print(f"\n{colored('!', 'yellow')} Kiro IDE not detected. Skipping installation.")
        return SKIPPED

    print(f"\n{colored('Installing VibeMon for Kiro IDE...', 'cyan')}\n")

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
    hook_config = adapt_kiro_hook_config(
        source.get_file(KIRO_HOOK_CONFIG_FILE), kiro_home
    )
    if IS_WINDOWS:
        print(f"  {colored('✓', 'green')} hooks pinned to {hook_python()}")
    ok &= write_file_with_diff(
        kiro_home / "hooks" / "vibemon.json",
        hook_config,
        display_path(kiro_home / "hooks" / "vibemon.json"),
    )

    # Only retire working legacy registrations after the current v1 config is
    # safely in place. User hooks in the old agent file are preserved.
    if ok:
        remove_legacy_kiro_hooks(kiro_home)

    configure_vibemon_config(source, cli_token)
    ok &= install_vibemon_shared(source)

    if not ok:
        print(f"\n{colored('✗ Kiro IDE installation finished with errors — some files were not written.', 'red')}")
        return False

    print(f"\n{colored('Kiro IDE installation complete!', 'green')}")
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


def refresh_openclaw_plugin_registry() -> None:
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
        return
    try:
        result = subprocess.run(
            ["openclaw", "plugins", "registry", "--refresh"],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"  {colored('✗', 'red')} plugin registry refresh failed: {e}")
        print(manual_hint)
        return
    if result.returncode == 0:
        print(f"  {colored('✓', 'green')} plugin registry refreshed")
    else:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        print(f"  {colored('✗', 'red')} plugin registry refresh failed (exit {result.returncode})"
              + (f": {detail[-1]}" if detail else ""))
        print(manual_hint)


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

        # Ensure plugins.entries structure exists
        if "plugins" not in existing_config:
            existing_config["plugins"] = {}
        if "entries" not in existing_config["plugins"]:
            existing_config["plugins"]["entries"] = {}

        if ensure_plugin_path_registered(existing_config, str(plugin_dir)):
            print(f"  {colored('✓', 'green')} plugin path registered in plugins.load.paths")

        # Merge vibemon-bridge plugin (preserve existing config if present)
        if "vibemon-bridge" in existing_config["plugins"]["entries"]:
            existing_plugin = existing_config["plugins"]["entries"]["vibemon-bridge"]
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
            hooks_cfg = existing_plugin.setdefault("hooks", {})
            if isinstance(hooks_cfg, dict) and hooks_cfg.get("allowConversationAccess") is not True:
                hooks_cfg["allowConversationAccess"] = True
                print(f"  {colored('✓', 'green')} hooks.allowConversationAccess enabled")
            print(f"  {colored('✓', 'green')} vibemon-bridge plugin already configured")
        else:
            existing_config["plugins"]["entries"]["vibemon-bridge"] = vibemon_plugin_config
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
    refresh_openclaw_plugin_registry()

    if not ok:
        print(f"\n{colored('✗ OpenClaw installation finished with errors — some files were not written.', 'red')}")
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


def remove_path(path: Path, description: str) -> None:
    """Delete a file installed by VibeMon, reporting what happened."""
    if not path.exists():
        return
    try:
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
    if not isinstance(config, dict):
        return
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
        if isinstance(status_line, dict) and "statusline.py" in status_line.get("command", ""):
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
    # [] , not ["hooks"]: hooks.json *is* {"hooks": {...events...}}, so descending
    # into "hooks" first and then looking for "hooks" again found nothing and
    # left every VibeMon registration behind.
    _uninstall_hooks_from_json(
        codex_home / "hooks.json", [], display_path(codex_home / "hooks.json")
    )
    remove_path(
        codex_home / "hooks" / "vibemon.py",
        display_path(codex_home / "hooks" / "vibemon.py"),
    )
    # config.toml keeps [features] hooks and [tui] status_line: both are
    # generic Codex settings that predate and outlive VibeMon.
    print(
        f"  {colored('!', 'yellow')} left "
        f"{display_path(codex_home / 'config.toml')} alone "
        "(generic hooks/status_line settings)"
    )
    print(f"\n{colored('Codex CLI cleanup complete!', 'green')}")
    return True


def uninstall_kiro(source: FileSource = None, cli_token: str = None) -> bool:
    """Remove VibeMon's hooks and scripts from Kiro IDE."""
    kiro_home = tool_home("KIRO_HOME", ".kiro")
    if not kiro_home.exists():
        print(f"\n{colored('!', 'yellow')} Kiro IDE not detected. Nothing to remove.")
        return SKIPPED

    print(f"\n{colored('Removing VibeMon from Kiro IDE...', 'cyan')}\n")
    remove_legacy_kiro_hooks(kiro_home)
    remove_path(
        kiro_home / "hooks" / "vibemon.json",
        display_path(kiro_home / "hooks" / "vibemon.json"),
    )
    remove_path(
        kiro_home / "hooks" / "vibemon.py",
        display_path(kiro_home / "hooks" / "vibemon.py"),
    )
    print(f"\n{colored('Kiro IDE cleanup complete!', 'green')}")
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
    refresh_openclaw_plugin_registry()
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
    for name in ("usage.py", "usage_cache.py", "http_client.py", "cache_io.py", "account_context.py", "vibemon_core.py"):
        remove_path(vibemon_home / name, f"~/.vibemon/{name}")
    # config.json holds the user's token and statusline.json their display
    # preferences; deleting either would make a reinstall lose real settings.
    print(f"  {colored('!', 'yellow')} kept ~/.vibemon/config.json and statusline.json "
          "(your token and display settings)")
    print(f"    Remove them yourself with: rm -rf ~/.vibemon")
    print(f"\n{colored('Shared scripts cleanup complete!', 'green')}")
    return True


UNINSTALLERS = {
    "claude": ("Claude Code", uninstall_claude),
    "codex": ("Codex CLI", uninstall_codex),
    "kiro": ("Kiro IDE", uninstall_kiro),
    "openclaw": ("OpenClaw", uninstall_openclaw),
    "opencode": ("opencode", uninstall_opencode),
    "vibemon": ("VibeMon Scripts", uninstall_vibemon),
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

  Non-interactive (for AI agents):
    curl -fsSL https://vibemon.io/install/install.py | python3 - --claude
    curl -fsSL https://vibemon.io/install/install.py | python3 - --codex
    curl -fsSL https://vibemon.io/install/install.py | python3 - --opencode
    # Supply VIBEMON_WRITE_TOKEN through the environment.
    curl -fsSL https://vibemon.io/install/install.py | python3 - --all --yes

  Windows PowerShell:
    irm https://vibemon.io/install/install.ps1 | iex
    & ([scriptblock]::Create((irm https://vibemon.io/install/install.ps1))) --claude

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
                        help="Install for Kiro IDE")
    parser.add_argument("--openclaw", action="store_true",
                        help="Install for OpenClaw")
    parser.add_argument("--opencode", action="store_true",
                        help="Install for opencode")
    parser.add_argument("--all", action="store_true",
                        help="Install for all platforms")
    parser.add_argument("--vibemon", action="store_true",
                        help="Install only the shared ~/.vibemon scripts and config")

    # Configuration options
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
    "kiro": ("Kiro IDE", install_kiro),
    "openclaw": ("OpenClaw", install_openclaw),
    "opencode": ("opencode", install_opencode),
    "vibemon": ("VibeMon Scripts", install_vibemon),
}

# --all covers the five tools; the shared ~/.vibemon scripts ride along with
# each of them, so "vibemon" is only selected explicitly.
ALL_PLATFORMS = ("claude", "codex", "kiro", "openclaw", "opencode")

MENU_CHOICES = [
    ("1", "claude", "Claude Code"),
    ("2", "codex", "Codex CLI"),
    ("3", "kiro", "Kiro IDE"),
    ("4", "openclaw", "OpenClaw"),
    ("5", "opencode", "opencode"),
    ("6", "all", "All"),
    ("7", "vibemon", "VibeMon scripts only"),
]


def selected_platforms(args) -> list:
    """Platform keys chosen on the command line, in a stable order."""
    if args.all:
        return list(ALL_PLATFORMS)
    return [key for key in ("claude", "codex", "kiro", "openclaw", "opencode", "vibemon")
            if getattr(args, key)]


def report_and_exit(results: list, action: str) -> None:
    """Summarize per-platform outcomes and exit with a status that reflects them.

    Exit 0 requires every selected platform to have succeeded. A partial
    failure used to exit 0 because any() ignored the failures, which hid broken
    installs from CI and from the Desktop app.
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

    suffix = " Restart your IDE to apply changes." if action == "Install" else ""
    print(f"\n{colored('Done!', 'green')}{suffix}\n")


def main():
    """Main entry point."""
    global AUTO_APPROVE, NON_INTERACTIVE

    args = parse_args()
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
        while True:
            try:
                choice = input("\nYour choice [1/2/3/4/5/6/7/q]: ").strip().lower()
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
            print("Please enter 1, 2, 3, 4, 5, 6, 7, or q")

    # args.token is honored in both modes; it used to be dropped whenever the
    # menu was shown, which then reported "No token configured (use --token)".
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
