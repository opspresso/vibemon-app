"""A Python whose ssl module fails to load keeps local delivery and names the failure."""
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WRAPPERS = ["claude", "codex", "kiro", "opencode"]
WITHOUT_SSL = "import sys; sys.modules['ssl'] = None\n"


def run_python(code, **kwargs):
    return subprocess.run([sys.executable, "-I", "-c", WITHOUT_SSL + code], capture_output=True, text=True, timeout=30, **kwargs)


class _Ok(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


def test_deadline_opener_keeps_plain_http_without_ssl():
    # The server runs in this process; only the client lacks ssl.
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Ok)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        result = run_python(
            f"sys.path.insert(0, {str(ROOT / 'collector')!r})\n"
            "from urllib.error import URLError\n"
            "from urllib.request import ProxyHandler, Request\n"
            "from vibemon_collector.http_deadline import DeadlineOpener\n"
            "opener = DeadlineOpener(ProxyHandler({}))\n"
            "try:\n    opener.open(Request('https://vibemon.invalid/'), timeout=2)\nexcept URLError as error:\n    print('https', error.reason)\n"
            f"print('http', opener.open(Request('http://127.0.0.1:{server.server_port}/'), timeout=5).read().decode())\n")
    finally:
        server.shutdown()
        server.server_close()
    assert result.returncode == 0, result.stderr
    assert "https unknown url type: https" in result.stdout
    assert "http ok" in result.stdout


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
