"""Session activity: one coding-agent turn, from its first event to its end.

Hooks are short-lived processes that report edges: a prompt was submitted, a
tool started, a turn stopped. Work between two edges is silent. A long tool
call, a long model response, or a background subagent sends no event, and every
display ages a silent active state to idle (see monitoring.json). Silence alone
therefore cannot keep a working agent visible.

This module keeps the turn visible until it really ends:

- ``record`` derives each event's state under one cross-process lock. It tracks
  the session's running tools, issues strictly increasing observation times,
  and marks the turn open or closed.
- While a turn is open, one detached watcher process per session (``watch``)
  repeats the turn's last state every ``HEARTBEAT_MS`` as a heartbeat. It ends
  the turn when the agent process exits, or when the transcript records a turn
  that ended without a hook: a Claude Code user interrupt or a Kiro ``turn_end``
  (a cancelled Kiro turn runs no Stop hook). A heartbeat asserts that the turn
  still runs, so the watcher sends none while the session's transcript does not
  exist: it could not see an interrupt, and the state then ages as displays do.

The cache is ``activity.json`` beside the project cache. It holds no prompts,
tool inputs, or responses: only identifiers, states, and the last display
payload, which is the same payload the hooks already send.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from account_context import observation_time
from cache_io import update_json_cache

# States that mean a turn is running. ``start`` and ``done`` close it.
ACTIVE_STATES = frozenset({"thinking", "planning", "working", "packing", "notification"})

# Tools that stop the turn for a user answer rather than run work.
INPUT_TOOLS = frozenset({"askuserquestion", "requestuserinput"})

# Events that report a finished tool call. Hooks can run asynchronously, so one
# can arrive after the turn ended; it then must not reopen the turn.
TOOL_FINISHED_EVENTS = frozenset({"PostToolUse", "PostToolUseFailure", "PermissionDenied"})

# A heartbeat repeats the turn's state after this much silence. Displays age an
# active state to idle after SLEEP_TIMEOUT_MS (5 minutes), so four heartbeats
# can be lost before a running turn looks idle.
HEARTBEAT_MS = 60_000

# The watcher checks agent liveness and the transcript this often, so an exited
# agent or a user interrupt reaches the display within a few seconds.
WATCH_TICK_SECONDS = 5

# A hook that asked for a watcher does not ask again for this long, so a burst
# of parallel tool hooks starts one watcher process, not one per hook.
WATCH_REQUEST_MS = 10_000

# Payload countdowns in minutes, measured when the payload was built.
# Displays count them down from the report's observation time, so a repeated
# payload must age them by the time since it was built.
RESET_FIELDS = ("usage5hResetsIn", "usageWeekResetsIn", "usageWeekModelResetsIn")

# Sessions without an event for a day are abandoned; their entries are dropped.
SESSION_MAX_AGE_MS = 86_400_000

# Claude Code writes this user record when the user interrupts a turn or
# rejects a tool. The Stop hook does not run for an interrupt.
INTERRUPT_MARKER = "[Request interrupted by user"
# Kiro CLI V2 records these texts when the user cancels a response or a tool.
KIRO_V2_CANCEL_MARKERS = ("Response was interrupted by the user", "Tool use was cancelled by the user")

# The transcript tail read for the newest conversation record.
TRANSCRIPT_TAIL_BYTES = 65_536

# Processes between an agent and its hook: shells, launchers, and the hook's
# own interpreter. The nearest ancestor outside this set is the agent.
WRAPPER_PROCESSES = frozenset({
    "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "nohup", "timeout",
    "cmd", "powershell", "pwsh", "py", "python", "python3", "pythonw",
})
MAX_ANCESTRY_DEPTH = 8


@dataclass(frozen=True)
class Transition:
    """The state one hook event reports.

    ``settles`` marks an event that only ends a turn whose end event never ran,
    for example Claude Code's idle notification after a user interrupt. It is
    ignored when no turn is open.
    """

    state: str
    settles: bool = False


@dataclass(frozen=True)
class Report:
    state: str
    observed_at: str
    # True when the hook must start this session's watcher.
    watch: bool = False


def is_input_tool(name: Any) -> bool:
    return isinstance(name, str) and name.lower().replace("_", "").replace("-", "") in INPUT_TOOLS


def _now_ms() -> int:
    return int(time.time() * 1000)


def _stamp(cache: dict[str, Any], now: int) -> int:
    last = cache.get("lastMs")
    return max(now, last + 1) if isinstance(last, int) else now


def _live_sessions(cache: dict[str, Any], now: int) -> dict[str, Any]:
    return {
        key: value for key, value in (cache.get("sessions") or {}).items()
        if isinstance(value, dict) and isinstance(value.get("updatedMs"), int)
        and now - value["updatedMs"] < SESSION_MAX_AGE_MS
    }


def _tools(entry: dict[str, Any]) -> dict[str, str]:
    tools = entry.get("tools")
    return {key: value for key, value in tools.items() if isinstance(key, str) and value in ("working", "notification")} if isinstance(tools, dict) else {}


def _resolve(state: str, tools: dict[str, str], elicitations: int, event: str) -> str:
    """Let still-running tools and open requests outrank the state of an event that finished one.

    A fast tool's PostToolUse cannot see that a sibling tool still runs, or
    that a question or an MCP elicitation is still unanswered. A new prompt
    starts a new turn, so its own state stands.
    """
    if event == "UserPromptSubmit" or state not in ACTIVE_STATES:
        return state
    if "notification" in tools.values() or elicitations > 0:
        return "notification"
    if tools and state in ("thinking", "planning"):
        return "planning" if state == "planning" else "working"
    return state


def record(path: str, data: dict[str, Any], transition: Transition) -> Report | None:
    """Record one hook event and return the state and time to report.

    Returns None for a settling or tool-finished event when the turn is already
    closed. Without a session ID there is nothing to track, and the event
    reports as mapped.
    """
    session = data.get("session_id")
    if not isinstance(session, str) or not session:
        return None if transition.settles else Report(transition.state, observation_time())
    event = data.get("hook_event_name")
    tool = data.get("tool_use_id")
    result: dict[str, Any] = {}

    def update(cache: dict[str, Any]) -> dict[str, Any]:
        now = _now_ms()
        sessions = _live_sessions(cache, now)
        entry = dict(sessions.get(session) or {})
        if (transition.settles or event in TOOL_FINISHED_EVENTS) and not entry.get("open"):
            result["skip"] = True
            return cache
        stamp = _stamp(cache, now)
        tools = _tools(entry)
        elicitations = entry.get("elicitations") if isinstance(entry.get("elicitations"), int) else 0
        if isinstance(tool, str) and tool and event in ("PreToolUse", "PermissionRequest"):
            # A permission prompt or question waits on the user until the tool resolves.
            tools[tool] = "notification" if transition.state == "notification" else tools.get(tool, "working")
        elif isinstance(tool, str) and tool:
            tools.pop(tool, None)
        if transition.state not in ACTIVE_STATES or event == "UserPromptSubmit" or event == "Stop":
            # A new or ended turn has no running tools or open elicitations.
            # A Stop that keeps the turn open waits for background work, not
            # for a tool call.
            tools.clear()
            elicitations = 0
        if event == "Elicitation":
            elicitations += 1
        elif event == "ElicitationResult":
            elicitations = max(0, elicitations - 1)
        state = _resolve(transition.state, tools, elicitations, event if isinstance(event, str) else "")
        entry.update(tools=tools, elicitations=elicitations, updatedMs=now, reportedMs=now, state=state, open=state in ACTIVE_STATES)
        transcript = data.get("transcript_path")
        if isinstance(transcript, str) and transcript:
            entry["transcript"] = transcript
        watcher = entry.get("watcher")
        requested = entry.get("watchRequestedMs")
        watch = (
            entry["open"]
            # A process-ID check only: it runs inside the lock on every hook.
            and not (isinstance(watcher, dict) and pid_exists(watcher.get("pid")))
            and not (isinstance(requested, int) and now - requested < WATCH_REQUEST_MS)
        )
        if watch:
            entry["watchRequestedMs"] = now
        sessions[session] = entry
        result.update(state=state, observedAt=observation_time(stamp), watch=watch)
        return {**cache, "lastMs": stamp, "sessions": sessions}

    if not update_json_cache(path, update):
        # Display delivery must not wait on a busy or unwritable cache.
        return None if transition.settles else Report(transition.state, observation_time())
    if result.get("skip"):
        return None
    return Report(result["state"], result["observedAt"], result["watch"])


def remember_payload(path: str, session: str, payload: dict[str, Any], cwd: str, agent: dict[str, Any] | None) -> None:
    """Store what a heartbeat repeats: the display payload and the agent process."""
    def update(cache: dict[str, Any]) -> dict[str, Any]:
        sessions = dict(cache.get("sessions") or {})
        entry = sessions.get(session)
        if not isinstance(entry, dict):
            return cache
        entry = {**entry, "payload": payload, "payloadMs": _now_ms(), "cwd": cwd}
        if agent is not None:
            entry["agent"] = agent
        sessions[session] = entry
        return {**cache, "sessions": sessions}

    update_json_cache(path, update)


# ============================================================================
# Watcher
# ============================================================================


@dataclass(frozen=True)
class Beat:
    """One watcher delivery: a heartbeat of an open turn, or its end."""

    payload: dict[str, Any]
    cwd: str
    observed_at: str
    heartbeat: bool


def start_watcher(core_path: str, session: str) -> bool:
    """Start the detached watcher for a session. The hook does not wait for it."""
    options: dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        # A new session survives the agent killing the hook's process group.
        options["start_new_session"] = True
    try:
        subprocess.Popen([sys.executable or "python3", core_path, "--watch-session", session], **options)
        return True
    except OSError:
        return False


def claim(path: str, session: str, me: dict[str, Any]) -> bool:
    """Register this process as the session's only watcher."""
    claimed = {"value": False}

    def update(cache: dict[str, Any]) -> dict[str, Any]:
        sessions = dict(cache.get("sessions") or {})
        entry = sessions.get(session)
        if not isinstance(entry, dict) or not entry.get("open") or not isinstance(entry.get("agent"), dict):
            return cache
        watcher = entry.get("watcher")
        if isinstance(watcher, dict) and watcher.get("pid") != me["pid"] and process_alive(watcher.get("pid"), watcher.get("name")):
            return cache
        sessions[session] = {**entry, "watcher": me}
        claimed["value"] = True
        return {**cache, "sessions": sessions}

    return update_json_cache(path, update, timeout=2.0) and claimed["value"]


def tick(path: str, session: str, me: dict[str, Any]) -> Beat | None | bool:
    """Run one watcher check.

    Returns a Beat to deliver, None when nothing is due, or False when the
    watcher must exit: the turn closed, the session is gone, or another
    watcher owns it. Process and transcript checks run outside the cache
    lock, so hooks never wait for them.
    """
    entry = _owned_entry(_read_cache(path), session, me)
    if entry is None:
        return False
    agent = entry.get("agent") or {}
    exited = not process_alive(agent.get("pid"), agent.get("name"))
    interrupted = not exited and transcript_ended(entry.get("transcript"), entry.get("updatedMs", 0))
    observable = exited or interrupted or interrupt_observable(entry.get("transcript"))
    outcome: dict[str, Any] = {"result": None}

    def update(cache: dict[str, Any]) -> dict[str, Any]:
        sessions = dict(cache.get("sessions") or {})
        current = _owned_entry(cache, session, me)
        if current is None:
            outcome["result"] = False
            return cache
        now = _now_ms()
        # A hook may have reported since the check; its event outranks an
        # interrupt the transcript recorded before it.
        closing = exited or interrupted and current.get("updatedMs") == entry.get("updatedMs")
        if not closing and (not observable or now - current.get("reportedMs", 0) < HEARTBEAT_MS):
            return cache
        payload = current.get("payload")
        stamp = _stamp(cache, now)
        if closing:
            current = {**current, "open": False, "state": "done", "tools": {}, "updatedMs": now, "reportedMs": now}
            current.pop("watcher", None)
            outcome["result"] = Beat(_aged({**payload, "state": "done", "tool": ""}, current, now), current.get("cwd", ""), observation_time(stamp), False) if isinstance(payload, dict) else False
        else:
            current = {**current, "reportedMs": now}
            if isinstance(payload, dict):
                outcome["result"] = Beat(_aged({**payload, "state": current["state"]}, current, now), current.get("cwd", ""), observation_time(stamp), True)
        sessions[session] = current
        return {**cache, "lastMs": stamp, "sessions": sessions}

    if not update_json_cache(path, update, timeout=2.0):
        return None
    return outcome["result"]


def _aged(payload: dict[str, Any], entry: dict[str, Any], now: int) -> dict[str, Any]:
    """Count the payload's reset countdowns down to ``now``, as displays do."""
    built = entry.get("payloadMs")
    if not isinstance(built, int):
        return payload
    elapsed = max(0, (now - built) // 60_000)
    return {
        **payload,
        **{key: max(0, payload[key] - elapsed) for key in RESET_FIELDS if isinstance(payload.get(key), int) and not isinstance(payload.get(key), bool)},
    }


def _read_cache(path: str) -> dict[str, Any]:
    """Read the cache without the lock. Writers replace it atomically."""
    try:
        with open(path, encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _owned_entry(cache: dict[str, Any], session: str, me: dict[str, Any]) -> dict[str, Any] | None:
    """The session's entry while its turn is open and this watcher owns it."""
    entry = (cache.get("sessions") or {}).get(session)
    if not isinstance(entry, dict) or not entry.get("open"):
        return None
    watcher = entry.get("watcher")
    return entry if isinstance(watcher, dict) and watcher.get("pid") == me["pid"] else None


def watch(path: str, session: str, deliver: Callable[[Beat], None], sleep: Callable[[float], None] = time.sleep) -> None:
    """Keep one session's open turn visible until it ends.

    ``deliver`` sends a Beat to every display. The loop exits when the turn
    closes, the agent exits, or another watcher owns the session.
    """
    me = {"pid": os.getpid(), "name": process_name(os.getpid())}
    if not claim(path, session, me):
        return
    while True:
        sleep(WATCH_TICK_SECONDS)
        beat = tick(path, session, me)
        if isinstance(beat, Beat):
            deliver(beat)
            if not beat.heartbeat:
                return
        elif beat is False:
            return


# ============================================================================
# Transcript
# ============================================================================


def interrupt_observable(path: Any) -> bool:
    """Report whether the watcher can see a user interrupt in this session.

    A session without a transcript path reports interrupts through hooks. A
    path whose file does not exist means Claude Code does not write the
    transcript (for example, in a session it runs as a child of another one),
    so an interrupt would leave no record.
    """
    return not isinstance(path, str) or not path or os.path.exists(path)


def transcript_ended(path: Any, since_ms: int) -> bool:
    """Report whether the newest conversation record ends the turn after ``since_ms``.

    Claude Code records a user interrupt. Kiro CLI V3 records ``turn_end`` for
    every turn and runs its Stop hook only for a completed one. Kiro CLI V2
    records a cancellation message; its records carry no time, so the file's
    modification time dates them.
    """
    if not isinstance(path, str) or not path:
        return False
    try:
        modified_ms = os.stat(path).st_mtime * 1000
        if modified_ms <= since_ms:
            return False
        with open(path, "rb") as source:
            source.seek(0, os.SEEK_END)
            size = source.tell()
            source.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            lines = source.read().splitlines()
    except OSError:
        return False
    for line in reversed(lines[1:] if size > TRANSCRIPT_TAIL_BYTES else lines):
        try:
            record_value = json.loads(line)
        except ValueError:
            continue
        ended = _turn_end(record_value)
        if ended is None:
            continue
        recorded = _epoch_ms(record_value["timestamp"]) if "timestamp" in record_value else modified_ms
        return ended and recorded > since_ms
    return False


def _turn_end(record_value: Any) -> bool | None:
    """Classify a transcript record: True ends the turn, False continues the conversation, None is neither."""
    if not isinstance(record_value, dict):
        return None
    if isinstance(record_value.get("kind"), str) and "data" in record_value:
        # Kiro CLI V2 sessions/cli/<session_id>.jsonl: {"version", "kind", "data"}.
        return record_value["kind"] != "Prompt" and _has_cancel_marker(record_value["data"], 4)
    payload = record_value.get("payload")
    if isinstance(payload, dict):
        # Kiro CLI V3 messages.jsonl: {"timestamp", "payload": {"type", ...}}.
        kind = payload.get("type")
        if kind == "turn_end":
            return True
        return False if kind in ("user", "turn_start", "assistant") else None
    kind = record_value.get("type")
    if kind not in ("user", "assistant"):
        return None
    return kind == "user" and _interrupt_text(record_value.get("message"))


def _has_cancel_marker(value: Any, depth: int) -> bool:
    if isinstance(value, str):
        return value.startswith(KIRO_V2_CANCEL_MARKERS)
    if depth <= 0:
        return False
    children = value.values() if isinstance(value, dict) else value if isinstance(value, list) else ()
    return any(_has_cancel_marker(child, depth - 1) for child in children)


def _interrupt_text(message: Any) -> bool:
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content.startswith(INTERRUPT_MARKER)
    return isinstance(content, list) and any(
        isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str) and part["text"].startswith(INTERRUPT_MARKER)
        for part in content
    )


def _epoch_ms(value: Any) -> int:
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


# ============================================================================
# Agent process
# ============================================================================


def agent_process() -> dict[str, Any] | None:
    """Identify the agent process that ran this hook: its nearest non-wrapper ancestor."""
    pid = os.getppid()
    for _ in range(MAX_ANCESTRY_DEPTH):
        if pid <= 1:
            return None
        info = _process_info(pid)
        if info is None:
            return None
        parent, name = info
        if _base_name(name) not in WRAPPER_PROCESSES:
            return {"pid": pid, "name": name}
        pid = parent
    return None


def process_name(pid: int) -> str:
    info = _process_info(pid)
    return info[1] if info else ""


def process_alive(pid: Any, name: Any) -> bool:
    """Report whether ``pid`` still runs the process named ``name``.

    The name check keeps a reused process ID from passing for the agent.
    """
    if not pid_exists(pid):
        return False
    if not name:
        return True
    info = _process_info(pid)
    return info is not None and info[1] == name


def pid_exists(pid: Any) -> bool:
    """Report whether a process ID is in use, without starting a process."""
    if not isinstance(pid, int) or pid <= 1:
        return False
    if os.name == "nt":
        return pid in _windows_processes()
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _base_name(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")).lower()
    base = base[:-4] if base.endswith(".exe") else base
    # Versioned interpreters (python3.12) are the same wrapper.
    return "python" if base.startswith("python") else base


def _process_info(pid: int) -> tuple[int, str] | None:
    """Return (parent pid, process name) for a running process, or None."""
    if os.name == "nt":
        return _windows_processes().get(pid)
    stat = f"/proc/{pid}/stat"
    if os.path.exists(stat):
        try:
            with open(stat, encoding="utf-8", errors="replace") as source:
                text = source.read()
            name = text[text.index("(") + 1:text.rindex(")")]
            return int(text[text.rindex(")") + 2:].split()[1]), name
        except (OSError, ValueError, IndexError):
            return None
    try:
        output = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)], capture_output=True, text=True, timeout=2).stdout.strip()
        parent, name = output.split(None, 1)
        return int(parent), name
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _windows_processes() -> dict[int, tuple[int, str]]:
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snapshot in (None, wintypes.HANDLE(-1).value):
        return {}
    processes: dict[int, tuple[int, str]] = {}
    entry = Entry()
    entry.dwSize = ctypes.sizeof(Entry)
    try:
        found = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while found:
            processes[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile)
            found = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return processes
