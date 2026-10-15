import io
import json
import os
import runpy
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import session_activity as activity
import vibemon_core as core
from session_activity import Beat, Transition

DOCS = Path(__file__).parents[2] / "public" / "install"
START_MS = 1_760_000_000_000
AGENT = {"pid": 4242, "name": "claude"}
ME = {"pid": 5151, "name": "python3"}


class Clock:
    def __init__(self, ms=START_MS):
        self.ms = ms

    def __call__(self):
        return self.ms / 1000


@pytest.fixture
def clock(monkeypatch):
    value = Clock()
    monkeypatch.setattr(activity.time, "time", value)
    return value


@pytest.fixture
def alive(monkeypatch):
    """Processes reported alive; tests remove one to end it."""
    running = {AGENT["pid"]: AGENT["name"], ME["pid"]: ME["name"]}
    monkeypatch.setattr(activity, "process_alive", lambda pid, name: running.get(pid) == name)
    return running


@pytest.fixture
def path(tmp_path):
    return str(tmp_path / "activity.json")


def event(name, **fields):
    return {"session_id": "s1", "hook_event_name": name, **fields}


def cache(path):
    return json.loads(Path(path).read_text())


def open_turn(path, payload=None, **fields):
    report = activity.record(path, event("UserPromptSubmit", **fields), Transition("thinking"))
    activity.remember_payload(path, "s1", payload or {"state": "thinking", "project": "p", "character": "clawd"}, "/work", AGENT)
    return report


def test_an_active_event_opens_the_turn_and_requests_one_watcher(path, clock, alive):
    assert open_turn(path).watch is True
    clock.ms += 100
    assert activity.record(path, event("PreToolUse", tool_use_id="t1"), Transition("working")).watch is False
    entry = cache(path)["sessions"]["s1"]
    assert entry["open"] is True and entry["state"] == "working" and entry["agent"] == AGENT


def test_a_closed_turn_ignores_settling_events(path, clock):
    activity.record(path, event("Stop"), Transition("done"))
    assert activity.record(path, event("Notification"), Transition("done", settles=True)) is None
    open_turn(path)
    assert activity.record(path, event("Notification"), Transition("done", settles=True)).state == "done"
    assert cache(path)["sessions"]["s1"]["open"] is False


def test_an_unanswered_question_outranks_a_finished_parallel_tool(path, clock):
    open_turn(path)
    activity.record(path, event("PreToolUse", tool_use_id="ask"), Transition("notification"))
    activity.record(path, event("PreToolUse", tool_use_id="bash"), Transition("working"))
    assert activity.record(path, event("PostToolUse", tool_use_id="bash"), Transition("thinking")).state == "notification"
    assert activity.record(path, event("PostToolUse", tool_use_id="ask"), Transition("thinking")).state == "thinking"


def test_a_permission_request_marks_its_running_tool_as_waiting(path, clock):
    open_turn(path)
    activity.record(path, event("PreToolUse", tool_use_id="a"), Transition("working"))
    activity.record(path, event("PreToolUse", tool_use_id="b"), Transition("working"))
    activity.record(path, event("PermissionRequest", tool_use_id="a"), Transition("notification"))
    assert activity.record(path, event("PostToolUse", tool_use_id="b"), Transition("thinking")).state == "notification"


def test_a_stop_that_waits_for_background_work_keeps_the_turn_open(path, clock):
    open_turn(path)
    activity.record(path, event("PreToolUse", tool_use_id="a"), Transition("working"))
    assert activity.record(path, event("Stop"), Transition("working")).state == "working"
    entry = cache(path)["sessions"]["s1"]
    assert entry["open"] is True and entry["tools"] == {}


def test_a_session_without_an_id_reports_as_mapped(path):
    assert activity.record(path, {"hook_event_name": "PreToolUse"}, Transition("working")).watch is False
    assert activity.record(path, {"hook_event_name": "Notification"}, Transition("done", settles=True)) is None
    assert not Path(path).exists()


def test_silence_is_filled_with_heartbeats_of_the_current_state(path, clock, alive):
    open_turn(path)
    activity.record(path, event("PreToolUse", tool_use_id="build"), Transition("working"))
    assert activity.claim(path, "s1", ME)
    clock.ms += activity.HEARTBEAT_MS - 1
    assert activity.tick(path, "s1", ME) is None
    clock.ms += 1
    beat = activity.tick(path, "s1", ME)
    assert isinstance(beat, Beat) and beat.heartbeat and beat.payload["state"] == "working" and beat.cwd == "/work"
    assert activity.tick(path, "s1", ME) is None
    assert beat.observed_at > activity.observation_time(clock.ms - activity.HEARTBEAT_MS)


def test_heartbeats_count_reset_countdowns_down(path, clock, alive):
    open_turn(path, payload={"state": "thinking", "project": "p", "character": "clawd", "usage5hResetsIn": 100, "usageWeekResetsIn": 2, "usage5h": 40})
    assert activity.claim(path, "s1", ME)
    clock.ms += 3 * activity.HEARTBEAT_MS + 30_000
    beat = activity.tick(path, "s1", ME)
    assert beat.payload["usage5hResetsIn"] == 97 and beat.payload["usageWeekResetsIn"] == 0 and beat.payload["usage5h"] == 40


def test_an_exited_agent_ends_the_turn(path, clock, alive):
    open_turn(path)
    assert activity.claim(path, "s1", ME)
    del alive[AGENT["pid"]]
    beat = activity.tick(path, "s1", ME)
    assert beat.payload["state"] == "done" and beat.payload["tool"] == "" and not beat.heartbeat
    entry = cache(path)["sessions"]["s1"]
    assert entry["open"] is False and "watcher" not in entry
    assert activity.tick(path, "s1", ME) is False


def test_a_recorded_interrupt_ends_the_turn(tmp_path, path, clock, alive):
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("")
    open_turn(path, transcript_path=str(transcript))
    assert activity.claim(path, "s1", ME)
    stamp = activity.observation_time(clock.ms + 500)
    transcript.write_text(json.dumps({"type": "user", "timestamp": stamp, "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}}) + "\n")
    os.utime(transcript, (clock() + 1, clock() + 1))
    assert activity.tick(path, "s1", ME).payload["state"] == "done"


def test_a_hook_during_the_check_outranks_an_older_interrupt(path, clock, alive, monkeypatch):
    open_turn(path)
    assert activity.claim(path, "s1", ME)

    def interrupted_then_resumed(_transcript, _since):
        # A new prompt arrives while the watcher reads the transcript.
        clock.ms += 1
        activity.record(path, event("UserPromptSubmit"), Transition("thinking"))
        return True

    monkeypatch.setattr(activity, "transcript_interrupted", interrupted_then_resumed)
    assert activity.tick(path, "s1", ME) is None
    assert cache(path)["sessions"]["s1"]["open"] is True


def test_a_second_watcher_cannot_claim_a_watched_session(path, clock, alive):
    open_turn(path)
    assert activity.claim(path, "s1", ME)
    other = {"pid": 6262, "name": "python3"}
    alive[other["pid"]] = other["name"]
    assert not activity.claim(path, "s1", other)
    assert activity.tick(path, "s1", other) is False
    del alive[ME["pid"]]
    assert activity.claim(path, "s1", other)


def test_a_closed_turn_stops_the_watcher(path, clock, alive):
    open_turn(path)
    assert activity.claim(path, "s1", ME)
    activity.record(path, event("Stop"), Transition("done"))
    assert activity.tick(path, "s1", ME) is False


def test_watch_delivers_heartbeats_until_the_agent_exits(path, clock, alive, monkeypatch):
    open_turn(path)
    monkeypatch.setattr(activity.os, "getpid", lambda: ME["pid"])
    monkeypatch.setattr(activity, "process_name", lambda pid: ME["name"])
    delivered = []

    def sleep(seconds):
        clock.ms += int(seconds * 1000)
        if clock.ms >= START_MS + 3 * activity.HEARTBEAT_MS:
            alive.pop(AGENT["pid"], None)

    activity.watch(path, "s1", delivered.append, sleep=sleep)
    assert [beat.payload["state"] for beat in delivered] == ["thinking", "thinking", "done"]
    assert [beat.heartbeat for beat in delivered] == [True, True, False]


@pytest.mark.parametrize("records,expected", [
    ([("user", "[Request interrupted by user for tool use]", 2_000)], True),
    ([("user", "[Request interrupted by user]", 500)], False),
    ([("user", "[Request interrupted by user]", 2_000), ("assistant", "resumed", 3_000)], False),
    ([("user", "[Request interrupted by user]", 2_000), ("system", "note", 3_000)], True),
    ([("user", "ordinary prompt", 2_000)], False),
])
def test_transcript_interrupts_count_only_as_the_newest_conversation_record(tmp_path, records, expected):
    since = START_MS + 1_000
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("".join(
        json.dumps({"type": kind, "timestamp": activity.observation_time(START_MS + offset), "message": {"content": text if kind == "assistant" else [{"type": "text", "text": text}]}}) + "\n"
        for kind, text, offset in records
    ))
    os.utime(transcript, (since / 1000 + 10, since / 1000 + 10))
    assert activity.transcript_interrupted(str(transcript), since) is expected


@pytest.mark.process_tree
def test_the_agent_is_the_nearest_ancestor_outside_wrappers(monkeypatch):
    tree = {100: (90, "/bin/sh"), 90: (80, "/usr/local/bin/python3.12"), 80: (70, "/opt/homebrew/bin/claude"), 70: (1, "zsh")}
    monkeypatch.setattr(activity.os, "getppid", lambda: 100)
    monkeypatch.setattr(activity, "_process_info", tree.get)
    assert activity.agent_process() == {"pid": 80, "name": "/opt/homebrew/bin/claude"}
    monkeypatch.setattr(activity, "_process_info", {100: (1, "bash")}.get)
    assert activity.agent_process() is None


def test_a_reused_process_id_is_not_the_agent(monkeypatch):
    monkeypatch.setattr(activity, "pid_exists", lambda pid: pid == 4242)
    monkeypatch.setattr(activity, "_process_info", {4242: (1, "vim")}.get)
    assert activity.process_alive(4242, "vim")
    assert not activity.process_alive(4242, "claude")
    assert not activity.process_alive(None, "claude")


def test_this_process_ancestry_resolves_on_this_platform():
    info = activity._process_info(os.getpid())
    assert info is not None and info[0] == os.getppid() and activity._base_name(info[1]) == "python"


# ============================================================================
# Hook driver
# ============================================================================


def run_hook(tmp_path, payload, agent):
    config = SimpleNamespace(cache_path=str(tmp_path / "projects.json"), debug=False, http_urls=(), serial_port=None,
                             vibemon_url=None, vibemon_token=None, auto_launch=False)
    sent, started = [], []
    with (
        patch.dict(os.environ, {"VIBEMON_SUPPRESS_HOOKS": "0"}),
        patch.object(sys, "argv", ["vibemon.py"]),
        patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "s1", "cwd": str(tmp_path), **payload}))),
        patch.object(core, "get_config", return_value=config),
        patch.object(core, "get_project_name", return_value="project"),
        patch.object(core, "get_project_metadata", return_value={}),
        patch.object(core, "get_usage_metadata", return_value={}),
        patch.object(core, "send_to_all", side_effect=lambda p, start, context=None: sent.append((p, context))),
        patch.object(activity, "agent_process", return_value=agent),
        patch.object(activity, "start_watcher", side_effect=lambda *args: started.append(args)),
        pytest.raises(SystemExit),
    ):
        runpy.run_path(str(DOCS / "claude" / "hooks" / "vibemon.py"), run_name="__main__")
    return sent, started


def test_the_opening_hook_starts_the_watcher_with_the_agent(tmp_path):
    sent, started = run_hook(tmp_path, {"hook_event_name": "UserPromptSubmit"}, AGENT)
    assert started == [(str(DOCS / "vibemon" / "vibemon_core.py"), "s1")]
    entry = cache(tmp_path / "activity.json")["sessions"]["s1"]
    assert entry["agent"] == AGENT and entry["payload"]["state"] == "thinking" and entry["cwd"] == str(tmp_path)
    assert "heartbeat" not in sent[0][1]


def test_no_watcher_starts_without_an_identified_agent(tmp_path):
    _, started = run_hook(tmp_path, {"hook_event_name": "UserPromptSubmit"}, None)
    assert started == []
    assert "agent" not in cache(tmp_path / "activity.json")["sessions"]["s1"]


@pytest.mark.parametrize("payload,state", [
    ({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "q"}, "notification"),
    ({"hook_event_name": "Stop", "background_tasks": [{"id": "b", "type": "subagent", "status": "running"}]}, "working"),
    ({"hook_event_name": "Stop", "background_tasks": [{"id": "b", "type": "shell", "status": "completed"}]}, "done"),
    ({"hook_event_name": "Elicitation"}, "notification"),
])
def test_claude_events_that_keep_or_end_the_turn(tmp_path, payload, state):
    sent, _ = run_hook(tmp_path, payload, None)
    assert sent[0][0]["state"] == state


def test_idle_notification_ends_only_an_open_turn(tmp_path):
    idle = {"hook_event_name": "Notification", "notification_type": "idle_prompt"}
    assert run_hook(tmp_path, idle, None)[0] == []
    run_hook(tmp_path, {"hook_event_name": "PreToolUse", "tool_use_id": "t"}, None)
    assert run_hook(tmp_path, idle, None)[0][0][0]["state"] == "done"


def test_heartbeats_are_marked_for_every_display():
    with patch.object(core, "send_to_all") as send:
        core.deliver_report({"state": "working", "project": "p", "character": "clawd"}, "/work", "2026-10-15T00:00:00.000Z", heartbeat=True)
    context = send.call_args.args[2]
    assert context["heartbeat"] is True and context["observedAt"] == "2026-10-15T00:00:00.000Z"


# ============================================================================
# Real processes
# ============================================================================


def test_a_real_watcher_reports_done_when_its_agent_exits(tmp_path, serve):
    """Spawn the installed-layout watcher against a real agent process and a local display."""
    received = []

    class Display(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

    server = serve(Display)
    home = tmp_path / "home"
    (home / ".vibemon" / "cache").mkdir(parents=True)
    (home / ".vibemon" / "config.json").write_text(json.dumps({
        "http_urls": [f"http://127.0.0.1:{server.server_address[1]}"], "auto_launch": False,
        "cache_path": str(home / ".vibemon" / "cache" / "projects.json"), "vibemon_token": "",
    }))
    agent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    path = str(home / ".vibemon" / "cache" / "activity.json")
    try:
        activity.record(path, event("UserPromptSubmit"), Transition("thinking"))
        activity.remember_payload(path, "s1", {"state": "thinking", "project": "real", "character": "clawd"}, str(tmp_path),
                                  {"pid": agent.pid, "name": activity.process_name(agent.pid)})
        # Only the test config may choose targets: no inherited token or URL.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("VIBEMON_")}
        environment.update(HOME=str(home), USERPROFILE=str(home))
        watcher = subprocess.Popen([sys.executable, str(DOCS / "vibemon" / "vibemon_core.py"), "--watch-session", "s1"], env=environment)
        deadline = time.monotonic() + 5
        while "watcher" not in cache(path)["sessions"]["s1"] and time.monotonic() < deadline:
            time.sleep(0.05)
        agent.kill()
        agent.wait()
        assert watcher.wait(timeout=activity.WATCH_TICK_SECONDS + 10) == 0
    finally:
        agent.kill()
    assert [report["state"] for report in received] == ["done"]
    assert received[0]["project"] == "real" and "heartbeat" not in received[0]
    assert cache(path)["sessions"]["s1"]["open"] is False


def test_plugin_heartbeats_reach_the_cloud_marked():
    config = SimpleNamespace(vibemon_url="https://cloud.example", vibemon_token="fixture-write")
    payload = {"state": "working", "project": "p", "observedAt": "2026-10-15T00:00:00.000Z", "heartbeat": True}
    with (
        patch.object(core, "get_config", return_value=config),
        patch.object(core, "read_input", return_value=json.dumps(payload)),
        patch.object(core, "send_vibemon_api", return_value=True) as send,
    ):
        assert core.send_cloud_status("openclaw")
    assert send.call_args.args[3]["heartbeat"] is True
