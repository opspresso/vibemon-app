"""Hooks stay bounded and keep reporting when agents, files, or paths misbehave."""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import cache_io
import vibemon_core as core
from test_hook_events import DOCS, run_hook_script

ROOT = Path(__file__).parents[2]


def codex_deadlines(*events, cwd="/tmp/project"):
    """The deadline that each delivered Codex report carries."""
    sent = []
    with (
        patch.object(core, "get_codex_usage_metadata", return_value={}),
        patch.object(core, "get_codex_context_usage", return_value=0),
        patch.object(core, "send_to_all", side_effect=lambda p, start, context=None, deadline=None: sent.append((p["state"], deadline))),
    ):
        for event in events:
            assert run_hook_script("codex", {"session_id": "s1", "hook_event_name": event, "cwd": cwd}) == 0
    return sent


def test_codex_synchronous_end_events_fit_the_three_second_timeout():
    reports = codex_deadlines("UserPromptSubmit", "Interrupt", "UserPromptSubmit", "SessionEnd")
    assert [state for state, _ in reports] == ["thinking", "done", "thinking", "done"]
    assert reports[0][1] is None and reports[2][1] is None
    for _, deadline in (reports[1], reports[3]):
        assert deadline == core.HOOK_STARTED + core.SYNC_EVENT_BUDGET_SECONDS
        assert core.SYNC_EVENT_BUDGET_SECONDS < 3


def test_codex_memory_generation_is_not_a_user_project():
    assert codex_deadlines("UserPromptSubmit", cwd=str(DOCS / "codex" / "memories" / "2026")) == []
    assert codex_deadlines("UserPromptSubmit", cwd=str(DOCS / "codex" / "memories-notes")) == [("thinking", None)]


def test_a_deadline_bounds_a_target_that_does_not_answer():
    release = threading.Event()

    class Slow(BaseHTTPRequestHandler):
        def do_POST(self):
            release.wait(5)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = core.Config((f"http://127.0.0.1:{server.server_port}",), None, "", False, None, None)
    try:
        with patch.object(core, "get_config", return_value=config):
            started = time.monotonic()
            core.send_to_all({"project": "fixture", "state": "done"}, False, False, deadline=time.monotonic() + 0.5)
            assert time.monotonic() - started < 2
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def test_a_cache_with_invalid_utf8_is_replaced(tmp_path):
    path = tmp_path / "activity.json"
    path.write_bytes(b'{"a":"\xff"}')
    assert cache_io.update_json_cache(str(path), lambda cache: {**cache, "ok": 1})
    assert json.loads(path.read_text()) == {"ok": 1}


def test_config_with_a_byte_order_mark_or_invalid_utf8(tmp_path, capsys):
    (tmp_path / ".vibemon").mkdir()
    config = tmp_path / ".vibemon" / "config.json"
    with patch.object(Path, "home", return_value=tmp_path), patch.dict(os.environ, {}, clear=False):
        os.environ.pop("VIBEMON_AUTO_LAUNCH", None)
        config.write_bytes(b"\xef\xbb\xbf" + json.dumps({"auto_launch": True}).encode())
        core.load_config()
        assert os.environ["VIBEMON_AUTO_LAUNCH"] == "1"
        config.write_bytes(b'{"auto_launch":"\xff"}')
        core.load_config()
    assert "config.json is not valid UTF-8 JSON" in capsys.readouterr().err


def test_an_installed_hook_ignores_an_unrelated_core_near_its_profile(tmp_path):
    home = tmp_path / "home"
    hooks = home / ".codex" / "hooks"
    hooks.mkdir(parents=True)
    shutil.copy(DOCS / "codex" / "hooks" / "vibemon.py", hooks / "vibemon.py")
    shared = home / ".vibemon"
    shutil.copytree(DOCS / "vibemon", shared, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(ROOT / "collector" / "vibemon_collector" / "http_deadline.py", shared / "http_deadline.py")
    decoy = home / "vibemon"
    decoy.mkdir()
    (decoy / "vibemon_core.py").write_text(f"open({str(tmp_path / 'decoy-loaded')!r}, 'w').close()\n")
    environment = {**os.environ, "HOME": str(home), "VIBEMON_SUPPRESS_HOOKS": "1"}
    result = subprocess.run([sys.executable, "-I", str(hooks / "vibemon.py")], input="{}", capture_output=True, text=True, env=environment, timeout=30)
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "decoy-loaded").exists()


def test_the_installed_http_client_imports_from_a_shallow_home(tmp_path):
    # /root/.vibemon/http_client.py has only three parent directories.
    source = (DOCS / "vibemon" / "http_client.py").read_text()
    sys.path.insert(0, str(ROOT / "collector" / "vibemon_collector"))
    try:
        namespace = {"__file__": "/root/.vibemon/http_client.py", "__name__": "installed_http_client"}
        exec(compile(source, "/root/.vibemon/http_client.py", "exec"), namespace)
    finally:
        sys.path.remove(str(ROOT / "collector" / "vibemon_collector"))
    assert callable(namespace["open_request"])
