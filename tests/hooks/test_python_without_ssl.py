"""A Python whose ssl module fails to load keeps local delivery and names the failure."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WRAPPERS = ["claude", "codex", "kiro", "opencode"]
WITHOUT_SSL = "import sys; sys.modules['ssl'] = None\n"


def run_python(code, **kwargs):
    return subprocess.run([sys.executable, "-I", "-c", WITHOUT_SSL + code], capture_output=True, text=True, timeout=30, **kwargs)


def test_deadline_opener_keeps_plain_http_without_ssl():
    result = run_python(
        f"sys.path.insert(0, {str(ROOT / 'collector')!r})\n"
        "from urllib.error import URLError\n"
        "from urllib.request import Request\n"
        "from vibemon_collector.http_deadline import DeadlineOpener\n"
        "opener = DeadlineOpener()\n"
        "try:\n    opener.open(Request('https://vibemon.invalid/'), timeout=2)\nexcept URLError as error:\n    print('https', error.reason)\n"
        "try:\n    opener.open(Request('http://127.0.0.1:9/'), timeout=2)\nexcept URLError as error:\n    print('http', type(error.reason).__name__)\n")
    assert result.returncode == 0, result.stderr
    assert "https unknown url type: https" in result.stdout
    assert "http ConnectionRefusedError" in result.stdout


@pytest.mark.parametrize("tool", WRAPPERS)
def test_hook_names_a_core_that_fails_to_load(tool, tmp_path):
    hook = tmp_path / "hooks" / "vibemon.py"
    hook.parent.mkdir()
    shutil.copy(ROOT / "public" / "install" / tool / "hooks" / "vibemon.py", hook)
    core = tmp_path / ".vibemon" / "vibemon_core.py"
    core.parent.mkdir()
    core.write_text("raise ImportError(\"cannot import name 'HTTPSConnection' from 'http.client'\")\n")
    result = subprocess.run([sys.executable, str(hook)], input="{}", capture_output=True, text=True, timeout=30,
                            env={"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), "PATH": ""})
    assert result.returncode == 0
    assert f"Cannot load {core} with {sys.executable}" in result.stderr
    assert "HTTPSConnection" in result.stderr
    assert "not found" not in result.stderr


@pytest.mark.parametrize("tool", WRAPPERS)
def test_hook_still_reports_a_missing_core(tool, tmp_path):
    hook = tmp_path / "hooks" / "vibemon.py"
    hook.parent.mkdir()
    shutil.copy(ROOT / "public" / "install" / tool / "hooks" / "vibemon.py", hook)
    result = subprocess.run([sys.executable, str(hook)], input="{}", capture_output=True, text=True, timeout=30,
                            env={"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), "PATH": ""})
    assert result.returncode == 0
    assert "vibemon_core.py not found" in result.stderr
