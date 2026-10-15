import copy
import hashlib
import io
import json
import os
import re
import runpy
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest
import venv
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import pytest

import install

DOCS_DIR = Path(__file__).parents[2] / "public" / "install"
CLAUDE_SETTINGS = json.loads((DOCS_DIR / "claude" / "settings.json").read_text(encoding="utf-8"))
CODEX_HOOKS = json.loads((DOCS_DIR / "codex" / "hooks.json").read_text(encoding="utf-8"))
KIRO_HOOK_CONFIG = (DOCS_DIR / "kiro" / "hooks" / "vibemon.json").read_text(encoding="utf-8")
KIRO_SESSION_END_CONFIG = (DOCS_DIR / "kiro" / "hooks" / "vibemon-session-end.json").read_text(encoding="utf-8")
OPENCODE_PLUGIN = (DOCS_DIR / "opencode" / "plugin" / "vibemon.js").read_text(encoding="utf-8")
# Windows has no POSIX permission bits — os.chmod there only toggles a
# read-only attribute, so st_mode always reads back 0o666.
POSIX_ONLY = unittest.skipIf(os.name == "nt", "POSIX file modes")

VIBEMON_ENTRY = {
    "hooks": [
        {"type": "command", "command": "python3 ~/.codex/hooks/vibemon.py"}
    ]
}
USER_ENTRY = {
    "hooks": [{"type": "command", "command": "python3 ~/my-hook.py"}]
}
NEW_HOOKS = {"Stop": [VIBEMON_ENTRY]}
LEGACY_KIRO_AGENT = {
    "name": "default",
    "hooks": {"stop": [
        {"command": "python3", "args": ["~/.kiro/hooks/vibemon.py", "agentStop"]},
        {"command": "python3", "args": ["~/my-hook.py"]},
    ]},
}


@pytest.fixture(autouse=True)
def fresh_backup_record():
    """backup_file() backs a path up once per run; start every test with none."""
    install.BACKED_UP.clear()
    yield
    install.BACKED_UP.clear()


def adapter_event_map(tool):
    return runpy.run_path(str(DOCS_DIR / tool / "hooks" / "vibemon.py"))["EVENT_STATE_MAP"]


class ReplaceVibemonHooksTest(unittest.TestCase):
    """Reinstalling refreshes VibeMon entries and drops the ones the packaged config no longer uses."""

    def replace(self, existing, new_hooks):
        return install.replace_vibemon_hooks(existing, new_hooks)[0]

    def test_vibemon_only_event_is_deleted(self):
        merged = self.replace({"PostToolUse": [VIBEMON_ENTRY], "Stop": [VIBEMON_ENTRY]}, NEW_HOOKS)
        self.assertEqual(merged, {"Stop": [VIBEMON_ENTRY]})

    def test_user_hooks_under_stale_event_are_preserved(self):
        existing = {"PostToolUse": [{"hooks": [
            {"type": "command", "command": "python3 ~/.codex/hooks/vibemon.py"},
            {"type": "command", "command": "python3 ~/my-hook.py"},
        ]}]}
        merged = self.replace(existing, NEW_HOOKS)
        self.assertEqual(merged["PostToolUse"], [{"hooks": [{"type": "command", "command": "python3 ~/my-hook.py"}]}])
        self.assertEqual(merged["Stop"], [VIBEMON_ENTRY])

    def test_user_hooks_keep_their_order_under_a_used_event(self):
        merged = self.replace({"Stop": [VIBEMON_ENTRY, USER_ENTRY]}, NEW_HOOKS)
        self.assertEqual(merged["Stop"], [USER_ENTRY, VIBEMON_ENTRY])

    def test_kiro_format_args_entry_is_removed(self):
        stop = {"command": "python3", "args": ["~/.kiro/hooks/vibemon.py", "agentStop"]}
        existing = {"postToolUse": [{"command": "python3", "args": ["~/.kiro/hooks/vibemon.py", "postToolUse"]}], "stop": [stop]}
        self.assertEqual(self.replace(existing, {"stop": [stop]}), {"stop": [stop]})

    def test_non_vibemon_stale_event_is_kept(self):
        merged = self.replace({"PostToolUse": [USER_ENTRY]}, NEW_HOOKS)
        self.assertEqual(merged["PostToolUse"], [USER_ENTRY])

    def test_moved_command_replaces_the_old_registration(self):
        moved = {"hooks": [{"type": "command", "command": "python3 ~/.vibemon/hooks/vibemon.py"}]}
        merged = self.replace({"Stop": [VIBEMON_ENTRY, USER_ENTRY]}, {"Stop": [moved]})
        self.assertEqual(merged["Stop"], [USER_ENTRY, moved])

    def test_kiro_args_rename_replaces_the_old_registration(self):
        renamed = {"command": "python3", "args": ["~/.kiro/hooks/vibemon.py", "onStop"]}
        existing = {"stop": [{"command": "python3", "args": ["~/.kiro/hooks/vibemon.py", "agentStop"]}]}
        self.assertEqual(self.replace(existing, {"stop": [renamed]}), {"stop": [renamed]})

    def test_refreshes_fields_without_touching_user_hooks(self):
        old = {
            "hooks": [{
                "type": "command",
                "command": "python3 ~/.codex/hooks/vibemon.py",
                "statusMessage": "old",
            }]
        }
        new = {
            "hooks": [{
                "type": "command",
                "command": "python3 ~/.codex/hooks/vibemon.py",
                "statusMessage": "new",
                "async": True,
            }]
        }
        existing = {"Stop": [old, USER_ENTRY]}

        merged, replaced = install.replace_vibemon_hooks(existing, {"Stop": [new]})

        self.assertEqual(replaced, ["Stop"])
        self.assertIn(USER_ENTRY, merged["Stop"])
        self.assertIn(new, merged["Stop"])
        self.assertNotIn(old, merged["Stop"])


class StripAllVibemonHooksTest(unittest.TestCase):
    def test_similarly_named_user_scripts_survive_removal(self):
        commands = ['python3 ~/my-vibemon.py', 'python3 ~/vibemon.py.backup', 'python3 ~/vibemon.py/helper.py']
        user_hooks = [{'hooks': [{'type': 'command', 'command': command}]} for command in commands]
        user_hooks.append({'command': 'python.exe', 'args': ['C:/custom/my-vibemon.py']})
        existing = {'Stop': [VIBEMON_ENTRY, *user_hooks]}
        install.strip_all_vibemon_hooks(existing)
        self.assertEqual(existing, {'Stop': user_hooks})

    def test_removes_vibemon_and_keeps_user_hooks(self):
        existing = {"Stop": [VIBEMON_ENTRY, USER_ENTRY], "PreToolUse": [VIBEMON_ENTRY]}
        changed = install.strip_all_vibemon_hooks(existing)
        self.assertEqual(sorted(changed), ["PreToolUse", "Stop"])
        self.assertEqual(existing, {"Stop": [USER_ENTRY]})

    def test_no_vibemon_hooks_is_a_noop(self):
        existing = {"Stop": [USER_ENTRY]}
        self.assertEqual(install.strip_all_vibemon_hooks(existing), [])
        self.assertEqual(existing, {"Stop": [USER_ENTRY]})


class AskYesNoTest(unittest.TestCase):
    def setUp(self):
        self._saved = (install.AUTO_APPROVE, install.NON_INTERACTIVE)

    def tearDown(self):
        install.AUTO_APPROVE, install.NON_INTERACTIVE = self._saved

    def test_auto_approve_answers_yes_even_when_unattended_is_false(self):
        install.AUTO_APPROVE, install.NON_INTERACTIVE = True, True
        self.assertTrue(install.ask_yes_no("?", unattended=False))

    def test_unattended_answer_is_used_without_yes_flag(self):
        install.AUTO_APPROVE, install.NON_INTERACTIVE = False, True
        # statusLine-style prompt: leave the user's setting alone.
        self.assertFalse(install.ask_yes_no("?", unattended=False))
        # Owned-file upgrade prompt: proceed.
        self.assertTrue(install.ask_yes_no("?", unattended=True))

    def test_unattended_falls_back_to_default(self):
        install.AUTO_APPROVE, install.NON_INTERACTIVE = False, True
        self.assertTrue(install.ask_yes_no("?", default=True))
        self.assertFalse(install.ask_yes_no("?", default=False))

    def test_lost_interactive_input_preserves_user_owned_configuration(self):
        install.AUTO_APPROVE, install.NON_INTERACTIVE = False, False
        with mock.patch('builtins.input', side_effect=EOFError):
            self.assertFalse(install.ask_yes_no('Replace statusLine?', unattended=False))
            self.assertTrue(install.ask_yes_no('Upgrade owned script?', unattended=True))


class SelectedPlatformsTest(unittest.TestCase):
    class Args:
        def __init__(self, **kw):
            for key in ("claude", "codex", "kiro", "openclaw", "opencode", "vibemon", "all"):
                setattr(self, key, kw.get(key, False))

    def test_all_expands_to_the_five_tools(self):
        self.assertEqual(
            install.selected_platforms(self.Args(all=True)), list(install.ALL_PLATFORMS)
        )

    def test_flags_keep_a_stable_order(self):
        args = self.Args(openclaw=True, claude=True)
        self.assertEqual(install.selected_platforms(args), ["claude", "openclaw"])

    def test_no_flags_means_show_the_menu(self):
        self.assertEqual(install.selected_platforms(self.Args()), [])


class ReportAndExitTest(unittest.TestCase):
    def _exit_code(self, results):
        try:
            install.report_and_exit(results, "Install")
        except SystemExit as e:
            return e.code
        return 0

    def test_all_succeeded_exits_zero(self):
        self.assertEqual(self._exit_code([("Claude Code", True)]), 0)

    def test_partial_failure_exits_nonzero(self):
        """any() used to report exit 0 here, hiding broken installs."""
        self.assertEqual(
            self._exit_code([("Claude Code", True), ("Codex CLI", False)]), 1
        )

    def test_skipped_tool_does_not_fail_the_run(self):
        self.assertEqual(
            self._exit_code([("Claude Code", True), ("Kiro IDE", install.SKIPPED)]), 0
        )

    def test_everything_skipped_exits_nonzero(self):
        self.assertEqual(self._exit_code([("Kiro IDE", install.SKIPPED)]), 1)

    def test_uninstall_prints_uninstalled_not_trailing_ed(self):
        out = io.StringIO()
        with (
            mock.patch.object(sys, "stdout", out),
            self.assertRaises(SystemExit),
        ):
            install.report_and_exit([("Kiro IDE", install.SKIPPED)], "Uninstall")

        message = out.getvalue()
        self.assertIn("Nothing was uninstalled.", message)
        self.assertNotIn("uninstalleded", message)


class WriteTextAtomicTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "settings.json"

    @POSIX_ONLY
    def test_creates_file_with_requested_mode(self):
        install.write_text_atomic(self.path, "{}\n", mode=0o600)
        self.assertEqual(self.path.read_text(), "{}\n")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    @POSIX_ONLY
    def test_preserves_existing_mode(self):
        self.path.write_text("old")
        os.chmod(self.path, 0o600)
        install.write_text_atomic(self.path, "new")
        self.assertEqual(self.path.read_text(), "new")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_leaves_no_temp_file_behind(self):
        install.write_text_atomic(self.path, "x")
        self.assertEqual([p.name for p in Path(self.tmp.name).iterdir()], ["settings.json"])

    def test_original_survives_a_failed_write(self):
        self.path.write_text("original")
        with mock.patch.object(install.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                install.write_text_atomic(self.path, "replacement")
        self.assertEqual(self.path.read_text(), "original")
        self.assertEqual([p.name for p in Path(self.tmp.name).iterdir()], ["settings.json"])

    def test_line_endings_are_preserved_verbatim(self):
        """The installed bytes have to hash to the manifest value on every OS.

        Text-mode writes translate \\n to \\r\\n on Windows, which would leave
        every installed script permanently mismatched against manifest.json.
        """
        install.write_text_atomic(self.path, "a\nb\n")
        self.assertEqual(self.path.read_bytes(), b"a\nb\n")


class BackupFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "settings.json"

    def test_backs_up_a_valid_file(self):
        self.path.write_text("valid")
        install.backup_file(self.path)
        self.assertEqual((self.path.with_suffix(".json.bak")).read_text(), "valid")

    def test_backs_up_only_once_per_run(self):
        self.path.write_text("first")
        install.backup_file(self.path)
        self.path.write_text("second")
        install.backup_file(self.path)
        self.assertEqual((self.path.with_suffix(".json.bak")).read_text(), "first")

    def test_missing_file_is_a_noop(self):
        install.backup_file(self.path)
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_failed_backup_stops_and_can_be_retried(self):
        self.path.write_text("valid")
        with mock.patch.object(
            install.shutil, "copy2", side_effect=OSError("permission denied")
        ):
            with self.assertRaisesRegex(RuntimeError, "Could not back up settings.json"):
                install.backup_file(self.path)

        self.assertNotIn(str(self.path), install.BACKED_UP)
        install.backup_file(self.path)
        self.assertEqual((self.path.with_suffix(".json.bak")).read_text(), "valid")


class VerifyContentTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(install.REMOTE_MANIFEST)
        install.REMOTE_MANIFEST.clear()

    def tearDown(self):
        install.REMOTE_MANIFEST.clear()
        install.REMOTE_MANIFEST.update(self._saved)

    def test_matching_hash_passes(self):
        content = "print('hi')\n"
        digest = hashlib.sha256(content.encode()).hexdigest()
        install.REMOTE_MANIFEST["claude/statusline.py"] = digest
        install.verify_content("claude/statusline.py", content)  # no raise

    def test_mismatched_hash_raises(self):
        install.REMOTE_MANIFEST["claude/statusline.py"] = "0" * 64
        with self.assertRaises(install.IntegrityError):
            install.verify_content("claude/statusline.py", "tampered")

    def test_unmanifested_remote_template_is_rejected(self):
        with self.assertRaises(install.IntegrityError):
            install.verify_content("claude/settings.json", "anything")


class LifecycleConfigTest(unittest.TestCase):
    DOCUMENT_HEADINGS = {"Claude Code": "claude", "Codex CLI": "codex", "Kiro IDE": "kiro", "opencode": "opencode"}

    @staticmethod
    def _markdown_section(readme, heading):
        """Content of the `### {heading}` section, matched on whole lines.

        A substring split would truncate at a longer heading with the same
        prefix (e.g. `### opencode Configuration` vs `### opencode`).
        """
        lines = readme.splitlines()
        start = next(i for i, line in enumerate(lines) if line == f"### {heading}")
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].startswith("### ")),
            len(lines),
        )
        return "\n".join(lines[start + 1:end])

    def test_claude_config_and_adapter_cover_the_same_lifecycle(self):
        event_map = adapter_event_map("claude")
        self.assertEqual(set(CLAUDE_SETTINGS["hooks"]), set(event_map))
        self.assertEqual(event_map["PostToolUse"], "thinking")
        self.assertEqual(event_map["PostCompact"], "thinking")
        self.assertNotIn("SubagentStart", event_map)
        self.assertNotIn("SubagentStop", event_map)
        self.assertEqual(
            CLAUDE_SETTINGS["hooks"]["SessionStart"][0]["matcher"],
            "startup|resume|clear",
        )
        session_end = CLAUDE_SETTINGS["hooks"]["SessionEnd"][0]["hooks"][0]
        self.assertNotIn("async", session_end)

    def test_codex_config_and_adapter_cover_the_same_lifecycle(self):
        event_map = adapter_event_map("codex")
        self.assertEqual(set(CODEX_HOOKS["hooks"]), set(event_map))
        self.assertEqual(event_map["PostToolUse"], "thinking")
        self.assertEqual(event_map["PostCompact"], "thinking")
        self.assertNotIn("SubagentStart", event_map)
        self.assertNotIn("SubagentStop", event_map)
        self.assertEqual(
            CODEX_HOOKS["hooks"]["SessionStart"][0]["matcher"],
            "startup|resume|clear",
        )

    def test_kiro_config_and_adapter_cover_the_same_lifecycle(self):
        event_map = adapter_event_map("kiro")
        main = [hook["trigger"] for hook in json.loads(KIRO_HOOK_CONFIG)["hooks"]]
        session_end = [hook["trigger"] for hook in json.loads(KIRO_SESSION_END_CONFIG)["hooks"]]
        # A surface without SessionEnd may reject its file; the main file must not carry it.
        self.assertEqual(session_end, ["SessionEnd"])
        self.assertNotIn("SessionEnd", main)
        self.assertEqual(set(main + session_end), set(event_map))
        self.assertEqual(event_map["SessionEnd"], "done")
        self.assertEqual(event_map["PostToolUse"], "thinking")

    def test_opencode_plugin_bridges_every_adapter_event(self):
        event_map = adapter_event_map("opencode")
        emitted = set(re.findall(r'(?:, |toolHook\(|": )"([A-Z][A-Za-z]+)"', OPENCODE_PLUGIN))
        self.assertEqual(emitted, set(event_map))
        self.assertEqual(event_map["SessionStart"], "start")
        self.assertEqual(event_map["Stop"], "done")
        self.assertEqual(event_map["SessionEnd"], "done")

    def test_opencode_plugin_imports_no_opencode_package(self):
        """opencode 2.x has no `@opencode-ai/plugin` package, so the plugin
        must not import one. tests/hooks/opencode.test.mjs checks the export."""
        self.assertNotIn("@opencode", OPENCODE_PLUGIN.split("*/", 1)[1])

    def test_canonical_document_tables_match_hook_adapters(self):
        readme = (DOCS_DIR.parents[1] / "docs" / "hooks.md").read_text(encoding="utf-8")

        for heading, tool in self.DOCUMENT_HEADINGS.items():
            event_map = adapter_event_map(tool)
            markdown_rows = dict(
                re.findall(
                    r"^\| ([A-Za-z]+) \| ([a-z]+) \|$",
                    self._markdown_section(readme, heading),
                    re.M,
                )
            )
            self.assertEqual(markdown_rows, event_map, heading)


class PlatformFake:
    """Pin install.py to one platform with every tool-home override unset."""

    windows = False

    def patches(self):
        return [
            mock.patch.object(install, "IS_WINDOWS", self.windows),
            mock.patch.dict(os.environ, {
                "CLAUDE_CONFIG_DIR": "", "CODEX_HOME": "", "KIRO_HOME": "",
                "OPENCODE_CONFIG_DIR": "", "XDG_CONFIG_HOME": "",
            }),
        ]

    def __enter__(self):
        self._stack = ExitStack()
        for patch in self.patches():
            self._stack.enter_context(patch)
        return self

    def __exit__(self, *exc):
        return self._stack.__exit__(*exc)


class WindowsFake(PlatformFake):
    """Pretend to be Windows with a known Python and home directory."""

    windows = True
    PYTHON = "C:/Python313/python.exe"
    HOME = "C:/Users/dev"

    def patches(self):
        return super().patches() + [
            mock.patch.object(install.sys, "executable", self.PYTHON),
            mock.patch.object(install.Path, "home", staticmethod(lambda: Path(self.HOME))),
            mock.patch.object(install, "has_git_bash", lambda: True),
        ]


class PosixFake(PlatformFake):
    """Pin the platform to POSIX, so the "adapters are a no-op here" contract
    can be asserted from any runner.

    Without it these tests only assert anything on a POSIX machine: on the
    Windows CI runner the adapters correctly rewrite the config and the
    assertion inverts.
    """


class PosixInstall(PosixFake):
    """Install into `home` on POSIX without touching the shared VibeMon files."""

    def __init__(self, home):
        self.home = home

    def patches(self):
        return super().patches() + [
            mock.patch.object(install.Path, "home", staticmethod(lambda: self.home)),
            mock.patch.object(install, "configure_vibemon_config"),
            mock.patch.object(install, "install_vibemon_shared", return_value=True),
        ]


class ToolHomeTest(unittest.TestCase):
    def test_defaults_to_a_directory_under_the_user_home(self):
        with mock.patch.dict(os.environ, {"CODEX_HOME": ""}):
            self.assertEqual(
                install.tool_home("CODEX_HOME", ".codex"), Path.home() / ".codex"
            )

    def test_honors_and_expands_the_environment_override(self):
        with mock.patch.dict(os.environ, {"CODEX_HOME": "~/codex-work"}):
            self.assertEqual(
                install.tool_home("CODEX_HOME", ".codex"),
                Path.home() / "codex-work",
            )

    def test_tool_detection_accepts_command_aliases(self):
        with mock.patch.object(
            install.shutil,
            "which",
            side_effect=lambda command: (
                "/bin/kiro-cli" if command == "kiro-cli" else None
            ),
        ):
            self.assertTrue(
                install.is_tool_installed(("kiro", "kiro-cli"), Path("/missing"))
            )


class AdaptClaudeSettingsTest(unittest.TestCase):
    def test_posix_output_is_byte_identical_to_the_packaged_file(self):
        """Existing POSIX installs must not see a single changed character."""
        settings = copy.deepcopy(CLAUDE_SETTINGS)
        with PosixFake():
            self.assertEqual(install.adapt_claude_settings(settings), CLAUDE_SETTINGS)

    def test_windows_hooks_use_exec_form(self):
        with WindowsFake():
            settings = install.adapt_claude_settings(copy.deepcopy(CLAUDE_SETTINGS))
        hook = settings["hooks"]["SessionStart"][0]["hooks"][0]
        self.assertEqual(hook["command"], WindowsFake.PYTHON)
        self.assertEqual(hook["args"], [f"{WindowsFake.HOME}/.claude/hooks/vibemon.py"])
        # Untouched fields survive the rewrite.
        self.assertTrue(hook["async"])
        self.assertEqual(hook["timeout"], 10)

    def test_windows_hooks_never_keep_a_tilde(self):
        """PowerShell does not expand `~` in argument position."""
        with WindowsFake():
            settings = install.adapt_claude_settings(copy.deepcopy(CLAUDE_SETTINGS))
        self.assertNotIn("~", json.dumps(settings))
        self.assertNotIn("python3", json.dumps(settings))

    def test_windows_statusline_stays_shell_form(self):
        """statusLine has no exec form, so it must remain a single string."""
        with WindowsFake():
            settings = install.adapt_claude_settings(copy.deepcopy(CLAUDE_SETTINGS))
        status_line = settings["statusLine"]
        self.assertNotIn("args", status_line)
        self.assertEqual(
            status_line["command"],
            f"{WindowsFake.PYTHON} {WindowsFake.HOME}/.claude/statusline.py",
        )

    def test_custom_posix_home_rewrites_hook_and_statusline_commands(self):
        custom_home = Path("/tmp/Claude Profile")
        with PosixFake():
            settings = install.adapt_claude_settings(
                copy.deepcopy(CLAUDE_SETTINGS), custom_home
            )
        hook = settings["hooks"]["SessionStart"][0]["hooks"][0]
        self.assertEqual(
            shlex.split(hook["command"]), ["python3", "/tmp/Claude Profile/hooks/vibemon.py"]
        )
        self.assertEqual(
            shlex.split(settings["statusLine"]["command"]),
            ["python3", "/tmp/Claude Profile/statusline.py"],
        )


class WindowsShellCommandTest(unittest.TestCase):
    PY = "C:/Python313/python.exe"
    PY_SPACED = "C:/Program Files/Python313/python.exe"
    SCRIPT_SPACED = "C:/Users/a b/.claude/statusline.py"

    def test_literal_commands_keep_the_complete_installed_path_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "O'Connor & $NAME `literal`" / 'statusline.py'
            for bash in (True, False):
                with mock.patch.object(install, 'has_git_bash', return_value=bash), mock.patch.object(install, 'IS_WINDOWS', True):
                    command = install.windows_shell_command(self.PY_SPACED, install.hook_path(script))
                    self.assertTrue(install._uses_installed_script(command, script))
                    self.assertFalse(install._uses_installed_script(command, script.parent / 'other.py'))

    def _run_shell(self, shell, args, bash):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "O'Connor & $NAME `literal`" / 'statusline.py'
            script.parent.mkdir()
            environment = script.parent / 'Python environment'
            venv.EnvBuilder(with_pip=False).create(environment)
            python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            script.write_text('import json,sys\nfrom pathlib import Path\ntrace=Path(__file__).with_suffix(".trace")\ntrace.write_text("reading stdin")\nsys.stdin.reconfigure(encoding="utf-8")\ndata=json.load(sys.stdin)\ntrace.write_text("input received")\nprint(json.dumps({"name":__file__,"data":data}))\n', encoding='utf-8')
            with mock.patch.object(install, 'has_git_bash', return_value=bash):
                command = install.windows_shell_command(install.hook_path(python), install.hook_path(script))
            try:
                result = subprocess.run([shell, *args, command], input='{"value":"한글 fixture"}', capture_output=True, encoding='utf-8', timeout=10, env={**os.environ, 'NAME': 'must-not-expand'})
            except subprocess.TimeoutExpired as error:
                trace = script.with_suffix('.trace')
                phase = trace.read_text() if trace.exists() else 'Python has not entered the script'
                self.fail(f'{shell} timed out: {phase}; stdout bytes={len(error.stdout or b"")}, stderr bytes={len(error.stderr or b"")}')
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(Path(output['name']).resolve(), script.resolve())
            self.assertEqual(output['data'], {'value': '한글 fixture'})

    def test_real_bash_preserves_paths_and_stdin(self):
        if os.name == 'nt':
            # Do not accidentally run Windows' WSL bash launcher.
            git = shutil.which('git')
            shell = Path(git).parent.parent / 'bin' / 'bash.exe' if git else None
            self.assertTrue(shell and shell.is_file(), 'Windows CI must provide Git Bash')
        else:
            shell = shutil.which('bash')
            if not shell:
                self.skipTest('Bash executable required')
        self._run_shell(str(shell), ['-c'], True)

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell is verified on Windows CI')
    def test_real_windows_powershell_preserves_paths_and_stdin(self):
        self._run_shell('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], False)


class AdaptCodexHooksTest(unittest.TestCase):
    def test_posix_output_is_unchanged(self):
        hooks = copy.deepcopy(CODEX_HOOKS)
        with PosixFake():
            self.assertEqual(install.adapt_codex_hooks(hooks), CODEX_HOOKS)

    def test_windows_override_is_added_beside_the_posix_command(self):
        with WindowsFake():
            hooks = install.adapt_codex_hooks(copy.deepcopy(CODEX_HOOKS))
        hook = hooks["hooks"]["Stop"][0]["hooks"][0]
        self.assertEqual(hook["command"], "python3 ~/.codex/hooks/vibemon.py")
        self.assertEqual(
            hook["commandWindows"],
            f"{WindowsFake.PYTHON} {WindowsFake.HOME}/.codex/hooks/vibemon.py",
        )

    def test_custom_posix_home_rewrites_the_main_command(self):
        with PosixFake():
            hooks = install.adapt_codex_hooks(
                copy.deepcopy(CODEX_HOOKS), Path("/tmp/Codex Profile")
            )
        hook = hooks["hooks"]["Stop"][0]["hooks"][0]
        self.assertEqual(
            shlex.split(hook["command"]), ["python3", "/tmp/Codex Profile/hooks/vibemon.py"]
        )


class AdaptKiroTest(unittest.TestCase):
    def test_posix_hook_config_is_returned_verbatim(self):
        """The file is hashed in manifest.json, so POSIX must not touch it."""
        with PosixFake():
            self.assertEqual(
                install.adapt_kiro_hook_config(KIRO_HOOK_CONFIG), KIRO_HOOK_CONFIG
            )

    def test_v1_config_has_current_global_triggers(self):
        config = json.loads(KIRO_HOOK_CONFIG)
        self.assertEqual(config["version"], "v1")
        self.assertEqual(
            [hook["trigger"] for hook in config["hooks"]],
            [
                "SessionStart",
                "UserPromptSubmit",
                "PreToolUse",
                "PostToolUse",
                "Stop",
            ],
        )

    def test_windows_commands_keep_event_arguments(self):
        with WindowsFake():
            config = json.loads(install.adapt_kiro_hook_config(KIRO_HOOK_CONFIG))
        command = config["hooks"][0]["action"]["command"]
        self.assertEqual(
            command,
            f"{WindowsFake.PYTHON} {WindowsFake.HOME}/.kiro/hooks/vibemon.py SessionStart",
        )

    def test_windows_hook_config_has_no_tilde_or_python3(self):
        with WindowsFake():
            adapted = install.adapt_kiro_hook_config(KIRO_HOOK_CONFIG)
        self.assertNotIn("~", adapted)
        self.assertNotIn("python3", adapted)

    def test_custom_posix_home_rewrites_commands_and_keeps_event_arguments(self):
        with PosixFake():
            config = json.loads(
                install.adapt_kiro_hook_config(
                    KIRO_HOOK_CONFIG, Path("/tmp/Kiro Profile")
                )
            )
        self.assertEqual(
            shlex.split(config["hooks"][0]["action"]["command"]),
            ["python3", "/tmp/Kiro Profile/hooks/vibemon.py", "SessionStart"],
        )

    def test_a_hook_config_without_vibemon_is_left_alone(self):
        other = json.dumps({
            "version": "v1",
            "hooks": [{"action": {"type": "command", "command": "echo hi"}}],
        })
        with WindowsFake():
            self.assertEqual(install.adapt_kiro_hook_config(other), other)


class OpencodeConfigHomeTest(unittest.TestCase):
    def test_honors_the_config_dir_override(self):
        with mock.patch.dict(os.environ, {
            "OPENCODE_CONFIG_DIR": "~/opencode-work", "XDG_CONFIG_HOME": "/tmp/xdg",
        }):
            self.assertEqual(
                install.opencode_config_home(),
                Path("~/opencode-work").expanduser().resolve(),
            )

    def test_falls_back_to_xdg_config_home(self):
        with mock.patch.dict(os.environ, {
            "OPENCODE_CONFIG_DIR": "", "XDG_CONFIG_HOME": "/tmp/xdg",
        }):
            self.assertEqual(install.opencode_config_home(), Path("/tmp/xdg/opencode"))

    def test_defaults_to_dot_config(self):
        with mock.patch.dict(os.environ, {
            "OPENCODE_CONFIG_DIR": "", "XDG_CONFIG_HOME": "",
        }):
            self.assertEqual(
                install.opencode_config_home(), Path.home() / ".config" / "opencode"
            )


class AdaptOpencodePluginTest(unittest.TestCase):
    def test_posix_plugin_is_returned_verbatim(self):
        """The file is hashed in manifest.json, so POSIX must not touch it."""
        with PosixFake():
            self.assertEqual(install.adapt_opencode_plugin(OPENCODE_PLUGIN), OPENCODE_PLUGIN)

    def test_windows_pins_the_interpreter(self):
        with WindowsFake():
            plugin = install.adapt_opencode_plugin(OPENCODE_PLUGIN)
        self.assertIn(f'const PYTHON = "{WindowsFake.PYTHON}";', plugin)
        self.assertNotIn("python3", plugin)

    def test_windows_keeps_the_default_script_variable(self):
        with WindowsFake():
            plugin = install.adapt_opencode_plugin(OPENCODE_PLUGIN)
        # Default home: OPENCODE_HOME already resolves via os.homedir().
        self.assertIn('const HOOK_SCRIPT = path.join(OPENCODE_HOME, "hooks", "vibemon.py");', plugin)

    def test_windows_with_custom_home_inlines_both(self):
        with WindowsFake():
            plugin = install.adapt_opencode_plugin(OPENCODE_PLUGIN, Path("C:/opencode profile"))
        self.assertIn(f'const PYTHON = "{WindowsFake.PYTHON}";', plugin)
        self.assertIn('path.join("C:/opencode profile/hooks/vibemon.py")', plugin)

    def test_custom_posix_home_inlines_only_the_script_path(self):
        with PosixFake():
            plugin = install.adapt_opencode_plugin(OPENCODE_PLUGIN, Path("/tmp/opencode home"))
        self.assertIn('const PYTHON = "python3";', plugin)
        self.assertIn(
            'const HOOK_SCRIPT = path.join("/tmp/opencode home/hooks/vibemon.py");', plugin
        )
        self.assertNotIn("path.join(OPENCODE_HOME,", plugin)

    def test_windows_escapes_a_backslash_interpreter_path(self):
        """`sys.executable` uses backslashes on Windows; raw interpolation
        would let JavaScript read them as escape sequences."""
        with WindowsFake(), mock.patch.object(
            install.sys, "executable", r"C:\Python313\python.exe"
        ):
            plugin = install.adapt_opencode_plugin(OPENCODE_PLUGIN)
        self.assertIn('const PYTHON = "C:/Python313/python.exe";', plugin)
        self.assertNotIn("C:\\Python313", plugin)

    def test_custom_home_quote_is_escaped(self):
        with PosixFake():
            plugin = install.adapt_opencode_plugin(
                OPENCODE_PLUGIN, Path('/tmp/open"code')
            )
        self.assertIn(
            'const HOOK_SCRIPT = path.join("/tmp/open\\"code/hooks/vibemon.py");',
            plugin,
        )

    def test_unknown_plugin_shape_raises(self):
        with self.assertRaisesRegex(RuntimeError, "Could not find 'const HOOK_SCRIPT"):
            install._replace_opencode_line(
                'const PYTHON = "python3";\n', "const HOOK_SCRIPT = ", "replacement"
            )


class LegacyKiroCleanupTest(unittest.TestCase):
    def test_removes_only_vibemon_legacy_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            kiro_home = Path(directory)
            agent_file = kiro_home / "agents" / "default.json"
            agent_file.parent.mkdir(parents=True)
            agent_file.write_text(json.dumps(LEGACY_KIRO_AGENT))
            hooks_dir = kiro_home / "hooks"
            hooks_dir.mkdir()
            for name in install.LEGACY_KIRO_HOOK_FILES:
                (hooks_dir / name).write_text("legacy")
            current = hooks_dir / "vibemon.json"
            current.write_text(KIRO_HOOK_CONFIG)

            install.remove_legacy_kiro_hooks(kiro_home)

            agent = json.loads(agent_file.read_text())
            self.assertEqual(
                agent["hooks"]["stop"],
                [{"command": "python3", "args": ["~/my-hook.py"]}],
            )
            self.assertTrue(current.exists())
            self.assertTrue(all(
                not (hooks_dir / name).exists()
                for name in install.LEGACY_KIRO_HOOK_FILES
            ))


class InstallKiroV1Test(unittest.TestCase):
    def test_installs_global_config_and_migrates_legacy_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            kiro_home = home / ".kiro"
            agent_file = kiro_home / "agents" / "default.json"
            agent_file.parent.mkdir(parents=True)
            agent_file.write_text(json.dumps(LEGACY_KIRO_AGENT))
            source = install.FileSource(DOCS_DIR)

            with PosixInstall(home):
                result = install.install_kiro(source)

            self.assertTrue(result)
            config = json.loads((kiro_home / "hooks" / "vibemon.json").read_text())
            self.assertEqual(config["version"], "v1")
            self.assertEqual(
                (kiro_home / "hooks" / "vibemon-session-end.json").read_text(),
                KIRO_SESSION_END_CONFIG,
            )
            self.assertEqual(
                json.loads(agent_file.read_text())["hooks"]["stop"],
                [{"command": "python3", "args": ["~/my-hook.py"]}],
            )


class InstallCodexOwnershipTest(unittest.TestCase):
    def test_does_not_create_machine_config(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".codex").mkdir()
            with PosixInstall(home):
                self.assertTrue(install.install_codex(install.FileSource(DOCS_DIR)))
            self.assertFalse((home / ".codex/config.toml").exists())
            self.assertTrue((home / ".codex/hooks.json").is_file())
            self.assertTrue((home / ".codex/hooks/vibemon.py").is_file())

    def test_preserves_existing_config_toml_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            codex_home = home / ".codex"
            codex_home.mkdir()
            config_file = codex_home / "config.toml"
            original = '# Machine preferences\nmodel = "gpt-test"\n[features]\nhooks = false\n[tui]\nstatus_line = []\n'
            config_file.write_text(original)
            source = install.FileSource(DOCS_DIR)

            with PosixInstall(home):
                result = install.install_codex(source)

            self.assertTrue(result)
            self.assertEqual(config_file.read_text(), original)
            self.assertFalse((codex_home / "config.toml.bak").exists())


class InstallOpencodeTest(unittest.TestCase):
    def _opens_home(self, home):
        return home / ".config" / "opencode"

    def test_installs_plugin_and_adapter_byte_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self._opens_home(home).mkdir(parents=True)  # tool detection
            source = install.FileSource(DOCS_DIR)

            with PosixInstall(home), mock.patch.object(install.shutil, "which", return_value=None):
                result = install.install_opencode(source)

            self.assertTrue(result)
            plugin = self._opens_home(home) / "plugins" / "vibemon.js"
            hook = self._opens_home(home) / "hooks" / "vibemon.py"
            self.assertEqual(
                plugin.read_text(encoding="utf-8"),
                (DOCS_DIR / "opencode" / "plugin" / "vibemon.js").read_text(encoding="utf-8"),
            )
            self.assertEqual(
                hook.read_text(encoding="utf-8"),
                (DOCS_DIR / "opencode" / "hooks" / "vibemon.py").read_text(encoding="utf-8"),
            )

    def test_skips_when_opencode_is_not_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            source = install.FileSource(DOCS_DIR)
            with (
                PosixFake(),
                mock.patch.object(install.Path, "home", staticmethod(lambda: home)),
                mock.patch.object(install.shutil, "which", return_value=None),
            ):
                result = install.install_opencode(source)
        self.assertIsNone(result)


class UninstallOpencodeTest(unittest.TestCase):
    def test_removes_only_vibemon_files(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            opencode_home = home / ".config" / "opencode"
            (opencode_home / "plugins").mkdir(parents=True)
            (opencode_home / "hooks").mkdir()
            (opencode_home / "plugins" / "vibemon.js").write_text("plugin")
            (opencode_home / "hooks" / "vibemon.py").write_text("hook")
            (opencode_home / "plugins" / "user.js").write_text("user")

            with (
                PosixFake(),
                mock.patch.object(install.Path, "home", staticmethod(lambda: home)),
            ):
                self.assertTrue(install.uninstall_opencode())

            self.assertFalse((opencode_home / "plugins" / "vibemon.js").exists())
            self.assertFalse((opencode_home / "hooks" / "vibemon.py").exists())
            self.assertTrue((opencode_home / "plugins" / "user.js").exists())


class HookIdentityTest(unittest.TestCase):
    def test_args_and_windows_override_are_part_of_the_identity(self):
        exec_form = {"command": "python.exe", "args": ["C:/x/.claude/hooks/vibemon.py"]}
        self.assertIn("vibemon.py", install._hook_identity(exec_form))
        override = {"command": "python3 ~/a.py", "commandWindows": "python.exe C:/a.py"}
        self.assertIn("C:/a.py", install._hook_identity(override))

    def test_exec_form_and_windows_override_are_recognized_as_vibemon(self):
        self.assertTrue(
            install._is_vibemon_hook(
                {"command": "python.exe", "args": ["C:/x/.claude/hooks/vibemon.py"]}
            )
        )
        self.assertTrue(
            install._is_vibemon_hook(
                {"command": "echo hi", "commandWindows": "python.exe C:/x/vibemon.py"}
            )
        )
        self.assertFalse(install._is_vibemon_hook({"command": "python.exe", "args": ["x.py"]}))

    def test_a_user_hook_sharing_the_interpreter_does_not_shadow_ours(self):
        """Deduping on `command` alone would drop the VibeMon hook entirely."""
        existing = [{"hooks": [{"type": "command", "command": "python.exe", "args": ["fmt.py"]}]}]
        ours = {"hooks": [{"type": "command", "command": "python.exe", "args": ["vibemon.py"]}]}
        kept = install.filter_new_hooks(ours, install.get_hook_identities(existing))
        self.assertEqual(kept, ours)

    def test_an_identical_exec_form_hook_is_deduped(self):
        entry = {"hooks": [{"type": "command", "command": "python.exe", "args": ["vibemon.py"]}]}
        self.assertIsNone(
            install.filter_new_hooks(entry, install.get_hook_identities([entry]))
        )


class WriteFileWithDiffTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "vibemon.py"

    def test_crlf_copy_is_rewritten_instead_of_reported_unchanged(self):
        """An older Windows install wrote CRLF; its hash never matches the manifest.

        A text comparison sees no difference, so the file would stay mismatched
        forever and the Desktop app would keep reporting an update.
        """
        self.path.write_bytes(b"print('x')\r\n")
        self.assertTrue(install.write_file_with_diff(self.path, "print('x')\n", "hook"))
        self.assertEqual(self.path.read_bytes(), b"print('x')\n")

    def test_identical_bytes_are_left_alone(self):
        self.path.write_bytes(b"print('x')\n")
        before = self.path.stat().st_mtime_ns
        self.assertTrue(install.write_file_with_diff(self.path, "print('x')\n", "hook"))
        self.assertEqual(self.path.stat().st_mtime_ns, before)


class UninstallHooksFromJsonTest(unittest.TestCase):
    """--uninstall --codex used to leave every VibeMon hook in hooks.json.

    hooks.json *is* {"hooks": {...events...}}, so descending into "hooks" and
    then reading "hooks" again found nothing and the function returned early.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "hooks.json"

    def _write(self, config):
        self.path.write_text(json.dumps(config), encoding="utf-8")

    def test_codex_shape_hooks_are_removed(self):
        self._write({"hooks": {"Stop": [VIBEMON_ENTRY]}})
        install._uninstall_hooks_from_json(self.path, [], "hooks.json")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {})

    def test_user_hooks_and_other_keys_survive(self):
        self._write({"version": 2, "hooks": {"Stop": [VIBEMON_ENTRY, USER_ENTRY]}})
        install._uninstall_hooks_from_json(self.path, [], "hooks.json")
        self.assertEqual(
            json.loads(self.path.read_text(encoding="utf-8")),
            {"version": 2, "hooks": {"Stop": [USER_ENTRY]}},
        )


class UninstallClaudeStatuslineTest(unittest.TestCase):
    def test_only_the_installed_statusline_path_is_removed(self):
        for command, remove in [
            ('python3 ~/.claude/statusline.py', True),
            ('python3 ~/custom/statusline.py', False),
            ('python3 ~/.claude/my-statusline.py', False),
            ('python3 ~/.claude/statusline.py.backup', False),
        ]:
            with self.subTest(command=command), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                settings_path = home / '.claude/settings.json'
                settings_path.parent.mkdir()
                settings = {'statusLine': {'type': 'command', 'command': command}, 'env': {'KEEP': 'unchanged'}}
                settings_path.write_text(json.dumps(settings))
                with PosixFake(), mock.patch.object(Path, 'home', return_value=home):
                    self.assertTrue(install.uninstall_claude())
                result = json.loads(settings_path.read_text())
                self.assertEqual('statusLine' not in result, remove)
                if not remove:
                    self.assertEqual(result['statusLine'], settings['statusLine'])
                self.assertEqual(result['env'], settings['env'])


class WindowsInterpreterPathTest(unittest.TestCase):
    BACKSLASH_PYTHON = r"C:\Python313\python.exe"

    def test_statusline_command_forward_slashes_interpreter(self):
        with WindowsFake(), mock.patch.object(
            install.sys, "executable", self.BACKSLASH_PYTHON
        ):
            settings = install.adapt_claude_settings(copy.deepcopy(CLAUDE_SETTINGS))
        self.assertEqual(
            settings["statusLine"]["command"],
            "C:/Python313/python.exe C:/Users/dev/.claude/statusline.py",
        )

    def test_codex_command_windows_forward_slashes_interpreter(self):
        with WindowsFake(), mock.patch.object(
            install.sys, "executable", self.BACKSLASH_PYTHON
        ):
            hooks = install.adapt_codex_hooks(copy.deepcopy(CODEX_HOOKS))
        self.assertEqual(
            hooks["hooks"]["Stop"][0]["hooks"][0]["commandWindows"],
            "C:/Python313/python.exe C:/Users/dev/.codex/hooks/vibemon.py",
        )

    def test_kiro_command_forward_slashes_interpreter(self):
        with WindowsFake(), mock.patch.object(
            install.sys, "executable", self.BACKSLASH_PYTHON
        ):
            config = json.loads(install.adapt_kiro_hook_config(KIRO_HOOK_CONFIG))
        self.assertEqual(
            config["hooks"][0]["action"]["command"],
            "C:/Python313/python.exe C:/Users/dev/.kiro/hooks/vibemon.py SessionStart",
        )


class InstallClaudeSettingsTest(unittest.TestCase):
    def _run(self, settings):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            claude_home = home / ".claude"
            claude_home.mkdir()
            settings_file = claude_home / "settings.json"
            settings_file.write_text(json.dumps(settings), encoding="utf-8")
            source = install.FileSource(DOCS_DIR)
            with (
                PosixInstall(home),
                mock.patch.object(install.shutil, "which", return_value="/usr/bin/claude"),
                mock.patch.object(install, "configure_statusline_config", return_value=True),
            ):
                result = install.install_claude(source)
            return result, json.loads(settings_file.read_text(encoding="utf-8"))

    def test_existing_vibemon_hook_fields_are_refreshed(self):
        old_hook = {
            "type": "command",
            "command": "python3 ~/.claude/hooks/vibemon.py",
            "async": True,
            "timeout": 1,
        }
        result, settings = self._run({"hooks": {"SessionEnd": [{"hooks": [old_hook]}]}})
        self.assertTrue(result)
        session_end = settings["hooks"]["SessionEnd"][0]["hooks"][0]
        self.assertNotIn("async", session_end)
        self.assertEqual(session_end["timeout"], 10)

    def test_non_object_status_line_does_not_abort_install(self):
        with mock.patch.object(install, "ask_yes_no", return_value=False):
            result, settings = self._run(
                {"hooks": {}, "statusLine": "python3 ~/custom.py"}
            )
        self.assertTrue(result)
        self.assertEqual(settings["statusLine"], "python3 ~/custom.py")

    def test_non_object_status_line_replaced_when_accepted(self):
        with mock.patch.object(install, "ask_yes_no", return_value=True):
            result, settings = self._run({"hooks": {}, "statusLine": 5})
        self.assertTrue(result)
        self.assertIsInstance(settings["statusLine"], dict)

    def test_custom_status_line_values_are_preserved_without_logging_them(self):
        value = 'PRIVATE_MARKER_FOR_TEST_ONLY custom-statusline'
        for statusline in ({'type': 'command', 'command': value}, value):
            with self.subTest(statusline_type=type(statusline).__name__), mock.patch.object(install, 'ask_yes_no', return_value=False), mock.patch('sys.stdout', new_callable=io.StringIO) as output:
                result, settings = self._run({'hooks': {}, 'statusLine': statusline})
            self.assertTrue(result)
            self.assertEqual(settings['statusLine'], statusline)
            self.assertNotIn(value, output.getvalue())


class ConfigRobustnessTest(unittest.TestCase):
    def test_get_hook_identities_tolerates_null_hooks(self):
        self.assertEqual(install.get_hook_identities([{"hooks": None}]), set())

    def test_uninstall_hooks_from_json_ignores_non_object_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hooks.json"
            path.write_text("[]", encoding="utf-8")
            install._uninstall_hooks_from_json(path, [], "hooks.json")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), [])

    def test_download_file_converts_oserror_to_runtime_error(self):
        with mock.patch.object(install, "urlopen", side_effect=TimeoutError("stall")):
            with self.assertRaises(RuntimeError):
                install.download_file("https://example.invalid/x")


class TokenEnvironmentTest(unittest.TestCase):
    def test_unattended_upgrade_rejects_existing_legacy_credential_without_overwriting_it(self):
        for flag in ['AUTO_APPROVE', 'NON_INTERACTIVE']:
            with self.subTest(flag=flag):
                config = {'vibemon_token': 'old_arbitrary_token', 'http_urls': ['http://127.0.0.1:19280']}
                output = io.StringIO()
                with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(install, flag, True), mock.patch('sys.stdout', output):
                    with self.assertRaisesRegex(ValueError, 'VIBEMON_WRITE_TOKEN'):
                        install.configure_token(config)
                self.assertEqual(config['vibemon_token'], 'old_arbitrary_token')
                self.assertNotIn('old_arbitrary_token', output.getvalue())

    def test_interactive_upgrade_replaces_legacy_credential_with_hidden_input(self):
        token = 'vm_' + 'b' * 60
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(install, 'AUTO_APPROVE', False), mock.patch.object(install, 'NON_INTERACTIVE', False), mock.patch.object(install.getpass, 'getpass', return_value=token), mock.patch('sys.stdout', io.StringIO()):
            configured = install.configure_token({'vibemon_token': 'old_arbitrary_token'})
        self.assertEqual(configured['vibemon_token'], token)

    def test_unattended_upgrade_preserves_generated_credential_and_local_only_setup(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(install, 'NON_INTERACTIVE', True), mock.patch('sys.stdout', io.StringIO()):
            for token in ['', 'vm_' + 'c' * 60]:
                self.assertEqual(install.configure_token({'vibemon_token': token})['vibemon_token'], token)

    def test_generated_write_token_uses_environment_without_logging_plaintext(self):
        token = 'vm_' + 'a' * 60
        output = io.StringIO()
        with mock.patch.dict(os.environ, {'VIBEMON_WRITE_TOKEN': token}), mock.patch('sys.stdout', output):
            configured = install.configure_token({})
        self.assertEqual(configured['vibemon_token'], token)
        self.assertNotIn(token, output.getvalue())

    def test_legacy_arbitrary_token_cannot_be_saved_as_a_new_credential(self):
        with mock.patch.dict(os.environ, {'VIBEMON_WRITE_TOKEN': 'old_arbitrary_token'}), self.assertRaises(ValueError):
            install.configure_token({})


class ManifestAvailabilityTest(unittest.TestCase):
    def test_custom_source_binds_manifest_and_files_to_the_same_base(self):
        content = 'print("custom")\n'
        digest = hashlib.sha256(content.encode()).hexdigest()
        def download(url):
            if url.endswith('/manifest.json'):
                return json.dumps({'files': {'claude/statusline.py': digest}})
            return content
        with mock.patch.object(install, '_MANIFEST_LOADED', False), mock.patch.dict(os.environ, {'VIBEMON_DOCS_URL': 'https://custom.example/install/'}), mock.patch.object(install, 'download_file', side_effect=download) as fetch:
            self.assertEqual(install.FileSource().get_file('claude/statusline.py'), content)
            self.assertEqual(fetch.call_args_list, [mock.call('https://custom.example/install/manifest.json'), mock.call('https://custom.example/install/claude/statusline.py')])

    def test_remote_manifest_failure_stops_before_any_file_download(self):
        with mock.patch.object(install, '_MANIFEST_LOADED', False), mock.patch.object(install, 'download_file', side_effect=RuntimeError('unavailable')) as download:
            with self.assertRaises(install.IntegrityError):
                install.FileSource().get_file('claude/statusline.py')
            self.assertEqual(download.call_args_list, [mock.call(f'{install.DOCS_BASE_URL}/manifest.json')])

    def test_invalid_manifest_is_not_cached_as_success(self):
        with mock.patch.object(install, '_MANIFEST_LOADED', False), mock.patch.object(install, 'download_file', return_value='{"files": {}}'):
            with self.assertRaises(install.IntegrityError):
                install.load_manifest(install.FileSource())
            self.assertFalse(install._MANIFEST_LOADED)


class RemovalFailureTest(unittest.TestCase):
    def test_shared_uninstall_reports_an_unremovable_script_as_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            script = home / ".vibemon" / "usage.py"
            script.parent.mkdir()
            script.write_text("# installed helper\n")
            with mock.patch.object(Path, "home", return_value=home), \
                 mock.patch.object(Path, "unlink", side_effect=PermissionError("denied")), \
                 mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertFalse(install.run_install("shared", install.uninstall_vibemon, None))
            self.assertTrue(script.exists())
