"""Real process coordination: no lost account updates or partial JSON writes."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from cache_io import cache_lock, update_json_cache

HELPERS = Path(__file__).parents[2] / 'public' / 'install' / 'vibemon'


def test_parallel_account_writers_preserve_every_update(tmp_path):
    path = tmp_path / 'usage.json'
    worker = '''
import sys
from cache_io import update_json_cache
for index in range(25):
    def increment(data):
        key = sys.argv[2]
        data[key] = data.get(key, 0) + 1
        return data
    if not update_json_cache(sys.argv[1], increment, timeout=5):
        raise SystemExit(1)
'''
    processes = [subprocess.Popen([sys.executable, '-B', '-c', worker, str(path), account], env={**os.environ, 'PYTHONPATH': str(HELPERS)}) for account in ['claude:work', 'claude:personal', 'codex:work', 'codex:personal']]
    try:
        assert [process.wait(timeout=15) for process in processes] == [0, 0, 0, 0]
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    assert json.loads(path.read_text()) == {account: 25 for account in ['claude:work', 'claude:personal', 'codex:work', 'codex:personal']}
    assert not list(tmp_path.glob('.vibemon-cache-*'))


def test_busy_lock_does_not_overwrite_cache(tmp_path):
    path = str(tmp_path / 'usage.json')
    assert update_json_cache(path, lambda _: {'original': 1})
    with cache_lock(f'{path}.lock'):
        assert not update_json_cache(path, lambda _: {'lost': 2}, timeout=0)
    assert json.loads(Path(path).read_text()) == {'original': 1}
    assert update_json_cache(path, lambda data: {**data, 'next': 2})


def test_failed_update_releases_lock_and_preserves_original(tmp_path):
    path = str(tmp_path / 'usage.json')
    assert update_json_cache(path, lambda _: {'original': 1})
    with pytest.raises(ValueError):
        update_json_cache(path, lambda _: {'invalid': float('nan')})
    assert json.loads(Path(path).read_text()) == {'original': 1}
    assert update_json_cache(path, lambda _: {'recovered': 2})
    assert not list(tmp_path.glob('.vibemon-cache-*'))
