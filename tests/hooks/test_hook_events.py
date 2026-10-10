import io
import json
import os
import runpy
import shlex
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import pytest

DOCS = Path(__file__).parents[2] / "public" / "install"
sys.path.insert(0, str(DOCS / "vibemon"))
sys.path.insert(0, str(DOCS))

import install
import vibemon_core as core


def invoke(tool, payload, argv=()):
    sent = []
    with (
        patch.dict(os.environ, {"VIBEMON_SUPPRESS_HOOKS": "0"}),
        patch.object(sys, "argv", ["vibemon.py", *argv]),
        patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
        patch.object(core, "get_project_name", return_value="project"),
        patch.object(core, "get_project_metadata", return_value={"model": "claude-model", "memory": 42}),
        patch.object(core, "get_usage_metadata", return_value={}),
        patch.object(core, "get_codex_usage_metadata", return_value={}),
        patch.object(core, "get_codex_context_usage", return_value=0),
        patch.object(core, "send_to_all", side_effect=lambda p, start, context=None: sent.append((p, start))),
        pytest.raises(SystemExit) as result,
    ):
        runpy.run_path(str(DOCS / tool / "hooks" / "vibemon.py"), run_name="__main__")
    assert result.value.code == 0
    return sent


@pytest.mark.parametrize("event,state", [
    ("PostToolUseFailure", "thinking"), ("PermissionDenied", "thinking"),
    ("StopFailure", "done"),
])
def test_claude_failure_paths(event, state):
    assert invoke("claude", {"hook_event_name": event})[0][0]["state"] == state


def test_codex_interrupt_and_plan_mode():
    assert invoke("codex", {"hook_event_name": "Interrupt"})[0][0]["state"] == "done"
    assert invoke("codex", {
        "hook_event_name": "PreToolUse", "permission_mode": "plan",
    })[0][0]["state"] == "planning"


@pytest.mark.parametrize("tool", ["codex", "opencode"])
def test_other_agents_never_inherit_claude_model_cache(tool):
    assert invoke(tool, {"hook_event_name": "Stop"})[0][0]["model"] == ""
    assert invoke(tool, {"hook_event_name": "Stop", "model": "actual"})[0][0]["model"] == "actual"


@pytest.mark.parametrize("event,state", [
    ("SessionStart", "start"), ("sessionStart", "start"), ("agentSpawn", "start"),
    ("UserPromptSubmit", "thinking"), ("userPromptSubmit", "thinking"),
    ("promptSubmit", "thinking"), ("preToolUse", "working"),
    ("postToolUse", "thinking"), ("stop", "done"), ("agentStop", "done"),
])
def test_kiro_current_and_legacy_payloads(event, state):
    payload, start = invoke("kiro", {"hook_event_name": event})[0]
    assert payload["state"] == state
    assert start == (state == "start")


def test_kiro_argument_fallback_and_planning():
    assert invoke("kiro", {}, ["PreToolUse"])[0][0]["state"] == "working"
    assert invoke("kiro", {"permission_mode": "plan"}, ["PostToolUse"])[0][0]["state"] == "planning"


@pytest.mark.parametrize("config", [None, 123, True, ["http_urls"], "http_urls"])
def test_bad_shared_config_does_not_crash_all_hooks(tmp_path, config):
    home = tmp_path / ".vibemon"
    home.mkdir()
    (home / "config.json").write_text(json.dumps(config))
    with patch.object(core.Path, "home", return_value=tmp_path):
        core.load_config()


def test_mixed_url_list_keeps_valid_targets_and_env_override(tmp_path):
    home = tmp_path / ".vibemon"
    home.mkdir()
    (home / "config.json").write_text(json.dumps({"http_urls": [None, "http://valid", 4]}))
    with patch.object(core.Path, "home", return_value=tmp_path), patch.dict(os.environ, {}, clear=True):
        core.load_config()
        assert os.environ["VIBEMON_HTTP_URLS"] == "http://valid"
        os.environ["VIBEMON_HTTP_URLS"] = "http://override"
        core.load_config()
        assert os.environ["VIBEMON_HTTP_URLS"] == "http://override"


def test_malformed_event_fields_do_not_crash_adapters():
    assert invoke("kiro", {"hook_event_name": ["Stop"]}) == []
    assert invoke("claude", {"hook_event_name": "Stop", "cwd": [], "tool_name": {}})[0][0]["tool"] == ""


def test_codex_context_fallback_honors_custom_home(tmp_path):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "rollout-thread-123.jsonl").write_text(json.dumps({
        "type": "event_msg", "payload": {"type": "token_count", "info": {
            "last_token_usage": {"total_tokens": 42}, "model_context_window": 100,
        }},
    }) + "\n")
    with patch.dict(os.environ, {"CODEX_HOME": str(tmp_path)}):
        module = runpy.run_path(str(DOCS / "vibemon" / "vibemon_core.py"))
        assert module["get_codex_context_usage"]({"session_id": "thread-123"}) == 42


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_non_finite_codex_usage_is_ignored(tmp_path, value):
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({"type": "event_msg", "payload": {
        "type": "token_count", "info": {
            "last_token_usage": {"total_tokens": value}, "model_context_window": 100,
        },
    }}) + "\n")
    assert core.get_codex_context_usage({"transcript_path": str(transcript)}) is None


def test_shared_serial_command_uses_locked_transport():
    with patch.object(sys, "stdin", io.StringIO('{"state":"done"}')), patch.object(core, "send_serial", return_value=True) as send:
        assert core.handle_command("--send-serial", ["/dev/test"])
        assert send.call_args.args[0] == "/dev/test"
        assert json.loads(send.call_args.args[1]) == {"state": "done"}


def test_cloud_bridge_process_preserves_accounts_and_machine_identity(tmp_path):
    received = []

    class Cloud(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, self.headers.get('Authorization'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Cloud)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    payload = {'state': 'working', 'character': 'codex', 'project': 'Same gateway', 'memory': 0}
    env = {
        **os.environ, 'HOME': str(tmp_path), 'USERPROFILE': str(tmp_path),
        'VIBEMON_URL': f'http://127.0.0.1:{server.server_port}', 'VIBEMON_TOKEN': 'fixture-write',
        'VIBEMON_ALLOW_HTTP_LOCAL': '1', 'VIBEMON_HTTP_URLS': '', 'VIBEMON_SERIAL_PORT': '', 'DEBUG': '0',
    }
    try:
        for identity in ['work', 'personal']:
            for instance in ['one', 'two']:
                for state in ['working', 'done']:
                    result = subprocess.run(
                        [sys.executable, str(DOCS / 'vibemon/vibemon_core.py'), '--send-cloud', 'openclaw'],
                        input=json.dumps({**payload, 'state': state}), capture_output=True, text=True, timeout=10, cwd=tmp_path,
                        env={**env, 'VIBEMON_OPENCLAW_ACCOUNT_ID': identity, 'VIBEMON_OPENCLAW_ACCOUNT_NAME': identity.title(), 'VIBEMON_INSTANCE_ID': instance},
                    )
                    assert result.returncode == 0, result.stderr
                    assert 'fixture-write' not in result.stdout + result.stderr
                assert received[-1][2]['sourceId'] == received[-2][2]['sourceId']
        assert len(received) == 8
        assert len({body['sourceId'] for _, _, body in received}) == 4
        assert {body['account']['id'] for _, _, body in received} == {'work', 'personal'}
        for endpoint, auth, body in received:
            assert endpoint == '/api/status'
            assert auth == 'Bearer fixture-write'
            assert body['account']['provider'] == 'openclaw', 'character appearance does not select the provider'
            assert body['account']['displayName'] == body['account']['id'].title()
            assert body['observedAt'].endswith('Z')
            assert body['character'] == 'codex'
            assert body['memory'] == 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_invalid_cloud_account_never_sends_credentials():
    config = core.Config((), None, '', False, 'https://cloud.example', 'fixture-write')
    with (
        patch.dict(os.environ, {'VIBEMON_OPENCLAW_ACCOUNT_ID': 'invalid account'}),
        patch.object(sys, 'stdin', io.StringIO('{"state":"working","project":"gateway"}')),
        patch.object(core, 'get_config', return_value=config),
        patch.object(core, 'open_credential_request') as network,
    ):
        assert core.handle_command('--send-cloud', ['openclaw']) is False
        network.assert_not_called()


@pytest.mark.skipif(os.name == "nt", reason="POSIX serial transport")
def test_stalled_stty_is_bounded(tmp_path):
    port = tmp_path / "device"
    port.touch()
    with (
        patch.object(core.subprocess, "run", side_effect=subprocess.TimeoutExpired("stty", 2)) as stty,
        patch.object(core, "_get_serial_lock_path", return_value=str(tmp_path / "lock")),
    ):
        assert core.send_serial_raw(str(port), "{}") is False
        assert stty.call_args.kwargs["timeout"] == 2


@pytest.mark.skipif(os.name == "nt", reason="POSIX shell quoting")
def test_custom_hook_paths_survive_real_shell_expansion(tmp_path):
    # These are literal path characters, not shell syntax to execute.
    special = tmp_path / "agent $NOT_A_VAR; 'quoted' & space"
    special.mkdir()
    script = special / "vibemon.py"
    script.write_text("print('hook-ran')\n")
    with patch.object(install, "IS_WINDOWS", False):
        command = f"{shlex.quote(sys.executable)} {install._shell_quote(str(script))}"
    result = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True, timeout=5)
    assert result.returncode == 0
    assert result.stdout.strip() == "hook-ran"


@pytest.mark.parametrize("tool,character", [
    ("claude", "clawd"), ("codex", "codex"), ("kiro", "kiro"), ("opencode", "opencode"),
])
def test_real_hook_process_posts_to_local_monitor(tmp_path, tool, character):
    received = []

    class Monitor(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Monitor)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {
        **os.environ, "HOME": str(tmp_path), "USERPROFILE": str(tmp_path),
        "CODEX_HOME": str(tmp_path / ".codex"),
        "VIBEMON_HTTP_URLS": f"http://127.0.0.1:{server.server_port}",
        "VIBEMON_AUTO_LAUNCH": "0", "VIBEMON_SUPPRESS_HOOKS": "0",
        "VIBEMON_URL": "", "VIBEMON_TOKEN": "", "VIBEMON_SERIAL_PORT": "",
        "VIBEMON_CACHE_PATH": str(tmp_path / "cache" / "projects.json"), "DEBUG": "0",
    }
    try:
        for event in ["PreToolUse", "PostToolUse", "Stop"]:
            result = subprocess.run(
                [sys.executable, str(DOCS / tool / "hooks" / "vibemon.py")],
                input=json.dumps({"hook_event_name": event, "cwd": str(tmp_path), "tool_name": "read"}),
                capture_output=True, text=True, timeout=10, env=env, cwd=tmp_path,
            )
            assert result.returncode == 0, result.stderr
            assert result.stdout == ""
        assert [p[1]["state"] for p in received] == ["working", "thinking", "done"]
        assert all(endpoint == "/status" and p["character"] == character for endpoint, p in received)
        assert all(p["project"] == tmp_path.name for _, p in received)
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


@pytest.mark.parametrize("url,expected", [
    ("http://localhost:19280", True), ("http://127.0.0.1:19280", True),
    ("http://[::1]:19280", True), ("http://monitor/localhost", False),
    ("http://localhost.example.com", False), ("http://[invalid", False),
])
def test_desktop_detection_uses_the_hostname(url, expected):
    assert core.is_localhost_url(url) is expected


@pytest.mark.parametrize("existing", [None, [], "invalid", 42])
def test_replacing_non_object_hooks_installs_current_definitions(existing):
    packaged = {"Stop": [{"hooks": [{"type": "command", "command": "python3 vibemon.py"}]}]}
    result, removed = install.replace_vibemon_hooks(existing, packaged)
    assert result == packaged
    assert removed == []


@pytest.mark.parametrize("array", [
    "['model', 'git-branch']",
    r'["model", "custom\"quoted"]',
    '["model", "custom]item"]',
    '["model", # keep this item\n "git-branch"]',
])
def test_status_line_preserves_toml_values_it_cannot_safely_rebuild(array):
    config = f'[tui]\nstatus_line = {array}\n[features]\nhooks = true\n'
    assert install.ensure_codex_status_line(config) == config
