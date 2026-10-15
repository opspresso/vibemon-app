import io
import json
import os
import select
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[2] / "public" / "install" / "vibemon"))

import vibemon_core  # noqa: E402


EVENT_STATE_MAP = {"SessionStart": "start", "Stop": "done"}


def run_hook(
    event: dict,
    argv: list[str] | None = None,
    event_aliases: dict[str, str] | None = None,
) -> list[dict]:
    """Drive vibemon_core.run() with a stdin event; return sent payloads."""
    sent: list[dict] = []

    def build_payload(state, tool, project, data):
        return {"state": state, "tool": tool, "project": project}

    def capture_send(payload, is_start, context=None):
        sent.append(payload)

    stdin = io.StringIO(json.dumps(event))
    with (
        patch.object(sys, "argv", ["vibemon.py"] + (argv or [])),
        patch.object(sys, "stdin", stdin),
        patch.object(vibemon_core, "send_to_all", capture_send),
        redirect_stderr(io.StringIO()),
    ):
        vibemon_core.run(
            event_state_map=EVENT_STATE_MAP,
            build_payload=build_payload,
            start_event="SessionStart",
            event_aliases=event_aliases,
        )
    return sent


class ParseJsonTest(unittest.TestCase):
    def test_non_object_json_yields_empty_dict(self):
        for raw in ("[]", "123", "null", '"x"'):
            self.assertEqual(vibemon_core.parse_json(raw), {})

    def test_object_json_is_returned(self):
        self.assertEqual(vibemon_core.parse_json('{"a": 1}'), {"a": 1})

    def test_invalid_json_yields_empty_dict(self):
        self.assertEqual(vibemon_core.parse_json("{not json"), {})


class ProjectMetadataTest(unittest.TestCase):
    def test_invalid_future_or_expired_observations_are_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / 'projects.json'
            config = vibemon_core.Config((), None, str(cache_path), False, None, None)
            key = vibemon_core.project_cache_key('p')
            with patch.object(vibemon_core, 'get_config', return_value=config), patch.object(vibemon_core.time, 'time', return_value=2000):
                for observed_at in [float('nan'), float('inf'), 'NaN', 'Infinity', None, 0, 100, 2031]:
                    with self.subTest(observed_at=observed_at):
                        cache_path.write_text(json.dumps({key: {'model': 'stale-model', 'memory': 42, 'ts': observed_at}}))
                        self.assertEqual(vibemon_core.get_project_metadata('p'), {})
                entry = {'model': 'fresh-model', 'memory': 0, 'ts': 2000}
                cache_path.write_text(json.dumps({key: entry}))
                self.assertEqual(vibemon_core.get_project_metadata('p'), entry)

    def test_non_dict_cache_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "projects.json"
            cache_path.write_text("[]")
            config = vibemon_core.Config(
                http_urls=(),
                serial_port=None,
                cache_path=str(cache_path),
                auto_launch=False,
                vibemon_url=None,
                vibemon_token=None,
            )
            with patch.object(vibemon_core, "get_config", return_value=config):
                self.assertEqual(vibemon_core.get_project_metadata("p"), {})


class UsageFieldsTest(unittest.TestCase):
    def test_usage_fields_include_model_scoped_week(self):
        with patch.object(vibemon_core.time, "time", return_value=1000):
            fields = vibemon_core._usage_fields({
                "session": {"pct": 5, "resets_at": 1600},
                "week_all": {"pct": 7, "resets_at": 7000},
                "week_fable": {"pct": 12, "resets_at": 7000, "label": "Fable"},
            })

        self.assertEqual(fields["usage5h"], 5)
        self.assertEqual(fields["usageWeek"], 7)
        self.assertEqual(fields["usageWeekModel"], 12)
        self.assertEqual(fields["usageWeekModelResetsIn"], 100)
        self.assertEqual(fields["usageWeekModelLabel"], "Fable")

    def test_usage_fields_omit_model_week_when_absent(self):
        fields = vibemon_core._usage_fields({
            "session": {"pct": 5},
            "week_all": {"pct": 7},
        })

        self.assertNotIn("usageWeekModel", fields)
        self.assertNotIn("usageWeekModelLabel", fields)


class CodexContextUsageTest(unittest.TestCase):
    def test_reads_latest_context_usage_for_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            session_path = Path(directory) / "rollout-thread-123.jsonl"
            session_path.write_text(
                json.dumps({
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "last_token_usage": {"total_tokens": 42000},
                            "model_context_window": 100000,
                        },
                    },
                })
                + "\n"
            )
            with patch.object(vibemon_core, "CODEX_SESSIONS_DIR", directory):
                result = vibemon_core.get_codex_context_usage({
                    "session_id": "thread-123"
                })

        self.assertEqual(result, 42)

    def test_uses_most_recent_token_count(self):
        with tempfile.TemporaryDirectory() as directory:
            session_path = Path(directory) / "session.jsonl"
            session_path.write_text(
                "\n".join([
                    json.dumps({
                        "type": "event_msg",
                        "payload": {
                            "type": "token_count",
                            "info": {
                                "last_token_usage": {"total_tokens": 10000},
                                "model_context_window": 100000,
                            },
                        },
                    }),
                    json.dumps({
                        "type": "event_msg",
                        "payload": {
                            "type": "token_count",
                            "info": {
                                "last_token_usage": {"total_tokens": 73000},
                                "model_context_window": 100000,
                            },
                        },
                    }),
                ])
                + "\n"
            )
            result = vibemon_core.get_codex_context_usage({
                "transcript_path": str(session_path)
            })

        self.assertEqual(result, 73)

    def test_returns_unknown_without_context_data(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(vibemon_core.get_codex_context_usage({}))


class VibemonHomeGuardTest(unittest.TestCase):
    def test_session_in_vibemon_home_is_not_reported(self):
        vibemon_home = os.path.expanduser("~/.vibemon")
        sent = run_hook({"hook_event_name": "SessionStart", "cwd": vibemon_home})
        self.assertEqual(sent, [])

    def test_suppress_env_still_skips_reporting(self):
        with patch.dict(os.environ, {"VIBEMON_SUPPRESS_HOOKS": "1"}):
            sent = run_hook({"hook_event_name": "SessionStart", "cwd": "/tmp"})
        self.assertEqual(sent, [])

    def test_regular_project_session_is_reported(self):
        sent = run_hook({"hook_event_name": "SessionStart", "cwd": "/tmp"})
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["state"], "start")

    def test_unmapped_event_is_skipped(self):
        # e.g. an obsolete registration left behind by an older install
        sent = run_hook({"hook_event_name": "ObsoleteEvent", "cwd": "/tmp"})
        self.assertEqual(sent, [])

    def test_non_object_stdin_payload_is_skipped_not_crashed(self):
        sent = run_hook([1, 2, 3])
        self.assertEqual(sent, [])

    def test_event_alias_is_normalized_before_state_mapping(self):
        sent = run_hook(
            {"hook_event_name": "sessionStart", "cwd": "/tmp"},
            event_aliases={"sessionStart": "SessionStart"},
        )
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["state"], "start")


class SerialDebounceLockTest(unittest.TestCase):
    """The debounce coordination must never block the hook on a busy lock:
    a held debounce lock (e.g. while a peer drives an unresponsive device)
    used to stall the process on a blocking flock(LOCK_EX) forever.
    """

    def _send(self, directory, acquire_side_effect):
        port = Path(directory) / "ttyDevice"
        port.touch()
        lock_path = str(Path(directory) / "debounce.lock")
        sent = []
        with (
            patch.object(vibemon_core, "_acquire_lock", side_effect=acquire_side_effect),
            patch.object(
                vibemon_core, "_get_serial_debounce_lock_path", return_value=lock_path
            ),
            patch.object(vibemon_core, "_get_serial_debounce_path", return_value=str(Path(directory) / "debounce.json")),
            patch.object(vibemon_core.time, "sleep"),
            patch.object(
                vibemon_core,
                "send_serial_raw",
                side_effect=lambda p, d: sent.append((p, d)) or True,
            ),
        ):
            result = vibemon_core.send_serial(str(port), '{"x":1}')
        return result, sent

    def test_lock_busy_at_write_falls_back_to_direct_send(self):
        with tempfile.TemporaryDirectory() as directory:
            result, sent = self._send(directory, [False])

        self.assertTrue(result)
        self.assertEqual(sent, [(str(Path(directory) / "ttyDevice"), '{"x":1}')])

    def test_relock_busy_at_check_falls_back_to_direct_send(self):
        with tempfile.TemporaryDirectory() as directory:
            result, sent = self._send(directory, [True, False])

        self.assertTrue(result)
        self.assertEqual(sent, [(str(Path(directory) / "ttyDevice"), '{"x":1}')])

    @unittest.skipIf(vibemon_core.fcntl is None, 'POSIX serial transport')
    def test_debounce_replaces_its_own_link_without_writing_the_link_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'private.json'; target.write_text('preserve')
            debounce = root / 'debounce.json'; debounce.symlink_to(target)
            port = root / 'fixture-device'; port.touch()
            with patch.object(vibemon_core, '_get_serial_debounce_path', return_value=str(debounce)), patch.object(vibemon_core, '_get_serial_debounce_lock_path', return_value=str(root / 'lock')), patch.object(vibemon_core, 'send_serial_raw', return_value=True), patch.object(vibemon_core.time, 'sleep'):
                self.assertTrue(vibemon_core.send_serial(str(port), '{}'))
            self.assertEqual(target.read_text(), 'preserve')
            self.assertFalse(debounce.is_symlink())
            self.assertEqual(debounce.stat().st_mode & 0o777, 0o600)


class SuppressedHookTest(unittest.TestCase):
    def test_cli_command_runs_even_when_hooks_are_suppressed(self):
        called = []

        def fake_handle(cmd, args):
            called.append(cmd)
            return True

        with (
            patch.dict(os.environ, {"VIBEMON_SUPPRESS_HOOKS": "1"}),
            patch.object(vibemon_core, "handle_command", fake_handle),
            patch.object(sys, "argv", ["vibemon.py", "--status"]),
        ):
            with self.assertRaises(SystemExit) as ctx:
                vibemon_core.run(EVENT_STATE_MAP, lambda *a: {}, "SessionStart")

        self.assertEqual(ctx.exception.code, 0)
        self.assertEqual(called, ["--status"])


@unittest.skipIf(vibemon_core.fcntl is None, "POSIX serial transport")
class SerialWriteTest(unittest.TestCase):
    def test_a_regular_file_cannot_be_used_as_a_serial_device(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'user-settings.json'
            target.write_text('{"preserve":"user data"}')
            self.assertFalse(vibemon_core.send_serial_raw(str(target), '{"state":"working"}'))
            self.assertEqual(target.read_text(), '{"preserve":"user data"}')

    def test_real_terminal_accepts_a_complete_json_frame(self):
        master, slave = os.openpty()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(vibemon_core, '_get_serial_lock_path', return_value=str(Path(directory) / 'lock')):
                self.assertTrue(vibemon_core.send_serial_raw(os.ttyname(slave), '{"state":"working"}'))
                self.assertTrue(select.select([master], [], [], 1)[0])
                self.assertEqual(json.loads(os.read(master, 4096).decode()), {'state': 'working'})
        finally:
            os.close(master); os.close(slave)

    def test_failed_terminal_configuration_never_writes_the_frame(self):
        master, slave = os.openpty()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                command = root / 'stty'; command.write_text('#!/bin/sh\nexit 1\n'); command.chmod(0o755)
                with patch.dict(os.environ, {'PATH': str(root) + os.pathsep + os.environ.get('PATH', '')}), patch.object(vibemon_core, '_get_serial_lock_path', return_value=str(root / 'lock')):
                    self.assertFalse(vibemon_core.send_serial_raw(os.ttyname(slave), '{"state":"working"}'))
                self.assertFalse(select.select([master], [], [], 0)[0])
        finally:
            os.close(master); os.close(slave)

    def _send(self, write_side_effect):
        with tempfile.TemporaryDirectory() as directory:
            port = str(Path(directory) / "ttyDevice")
            Path(port).touch()
            with (
                patch.object(vibemon_core, "IS_WINDOWS", False),
                patch.object(vibemon_core, "_acquire_lock", return_value=True),
                patch.object(vibemon_core.os, "isatty", return_value=True),
                patch.object(vibemon_core.time, "sleep"),
                patch.object(vibemon_core.subprocess, "run"),
                patch.object(vibemon_core.os, "write", side_effect=write_side_effect),
            ):
                return vibemon_core.send_serial_raw(port, '{"x":1}')

    def test_retries_eagain_then_writes_the_whole_payload(self):
        written = []
        state = {"first": True}

        def fake_write(fd, data):
            if state["first"]:
                state["first"] = False
                raise BlockingIOError()
            written.append(bytes(data))
            return len(data)

        self.assertTrue(self._send(fake_write))
        self.assertEqual(b"".join(written), b'{"x":1}\n')

    def test_zero_byte_write_aborts_instead_of_looping(self):
        self.assertFalse(self._send(lambda fd, data: 0))


class DesktopLaunchTest(unittest.TestCase):
    def test_macos_opens_installed_application_without_a_shell(self):
        with patch.object(vibemon_core, 'IS_WINDOWS', False), patch.object(sys, 'platform', 'darwin'), patch.object(vibemon_core.subprocess, 'Popen') as spawn, patch.object(vibemon_core.time, 'sleep'):
            self.assertTrue(vibemon_core.launch_desktop())
        self.assertEqual(spawn.call_args.args[0], ['/usr/bin/open', '-g', '-a', 'VibeMon'])
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])

    def test_windows_launches_installed_executable_with_spaces(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'Programs/VibeMon/VibeMon.exe'
            executable.parent.mkdir(parents=True)
            executable.touch()
            with patch.dict(os.environ, {'LOCALAPPDATA': directory}, clear=True), patch.object(vibemon_core, 'IS_WINDOWS', True), patch.object(vibemon_core.subprocess, 'Popen') as spawn, patch.object(vibemon_core.time, 'sleep'):
                self.assertTrue(vibemon_core.launch_desktop())
            self.assertEqual(spawn.call_args.args[0], [str(executable)])

    def test_missing_windows_installation_does_not_download_an_app(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(vibemon_core, 'IS_WINDOWS', True), patch.object(vibemon_core.shutil, 'which', return_value=None), patch.object(vibemon_core.subprocess, 'Popen') as spawn:
            self.assertFalse(vibemon_core.launch_desktop())
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class SerialPortTest(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "serial output is POSIX-only")
    def test_port_setting_expands_home_and_wildcard(self):
        with tempfile.TemporaryDirectory() as home:
            for name in ("cu.usbserial-2", "cu.usbserial-1"):
                Path(home, name).touch()
            with patch.dict(os.environ, {"HOME": home}):
                self.assertEqual(vibemon_core.resolve_serial_port("~/cu.usbserial-*"), str(Path(home, "cu.usbserial-1")))
                self.assertEqual(vibemon_core.resolve_serial_port(" ~/fixed "), str(Path(home, "fixed")))
                self.assertIsNone(vibemon_core.resolve_serial_port("~/missing-*"))

    def test_plugin_serial_entry_resolves_the_port_setting(self):
        sent = []
        with (
            patch.object(sys, "stdin", io.StringIO('{"state": "working"}')),
            patch.object(vibemon_core, "resolve_serial_port", return_value="/dev/cu.usbmodem1"),
            patch.object(vibemon_core, "send_serial", lambda port, data: sent.append((port, json.loads(data))) or True),
        ):
            self.assertTrue(vibemon_core.send_serial_input(["/dev/cu.usbmodem*"]))
        self.assertEqual(sent, [("/dev/cu.usbmodem1", {"state": "working"})])
        with patch.object(sys, "stdin", io.StringIO('{"state": "working"}')), patch.object(vibemon_core, "resolve_serial_port", return_value=None):
            self.assertFalse(vibemon_core.send_serial_input(["/dev/none*"]))
