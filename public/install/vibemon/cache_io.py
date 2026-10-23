"""Cross-process locks and atomic JSON updates for local display caches."""
from __future__ import annotations

import errno
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Mapping

if os.name == 'nt':
    import msvcrt
else:
    import fcntl


def _home(environment: Mapping[str, str]) -> str:
    return environment.get("HOME") or environment.get("USERPROFILE") or str(Path.home())


def projects_cache_path(environment: Mapping[str, str] | None = None) -> str:
    """The shared projects cache path for every hook, statusline, and usage helper.

    VIBEMON_CACHE_PATH wins, then `cache_path` in ~/.vibemon/config.json, then
    ~/.vibemon/cache/projects.json. A leading `~` expands to the home directory
    of `environment`. The home directory is read only when one of those needs
    it; other paths are returned as given.
    """
    environment = os.environ if environment is None else environment
    configured = str(environment.get("VIBEMON_CACHE_PATH") or "").strip()
    if not configured:
        try:
            config = json.loads(Path(_home(environment), ".vibemon", "config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            config = None
        value = config.get("cache_path") if isinstance(config, dict) else None
        configured = value.strip() if isinstance(value, str) else ""
    if not configured or len(configured) > 32768 or any(ord(c) < 32 or ord(c) == 127 for c in configured):
        return os.path.join(_home(environment), ".vibemon", "cache", "projects.json")
    if configured == "~" or configured.startswith(("~/", "~\\")):
        return os.path.join(_home(environment), configured[2:])
    return configured


def usage_cache_path(environment: Mapping[str, str] | None = None) -> str:
    """usage.json, next to the projects cache."""
    return os.path.join(os.path.dirname(projects_cache_path(environment)), "usage.json")


@contextmanager
def cache_lock(path: str, timeout: float = 0.5):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    acquired = False
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                if os.name == 'nt':
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError as error:
                if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                if time.monotonic() >= deadline:
                    raise BlockingIOError('Cache writer is busy') from error
                time.sleep(min(0.01, max(0, deadline - time.monotonic())))
        yield
    finally:
        try:
            if acquired:
                if os.name == 'nt':
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def update_json_cache(path: str, update, timeout: float = 0.5) -> bool:
    temporary = None
    try:
        with cache_lock(f'{path}.lock', timeout):
            try:
                with open(path, encoding='utf-8') as source:
                    current = json.load(source)
            except (FileNotFoundError, ValueError):
                # Invalid JSON or UTF-8 is replaced, so one damaged file cannot stop every later hook.
                current = {}
            result = update(current if isinstance(current, dict) else {})
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=Path(path).parent, prefix='.vibemon-cache-', delete=False) as output:
                temporary = output.name
                json.dump(result, output, allow_nan=False)
            os.replace(temporary, path)
            temporary = None
        return True
    except OSError:
        return False
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
