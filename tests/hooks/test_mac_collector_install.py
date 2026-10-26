import io
from pathlib import Path
import plistlib
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

import install


class MacCollectorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        folder = Path(self.directory.name).resolve()
        self.paths = SimpleNamespace(base=folder / 'Collector With Spaces', unit=folder / 'LaunchAgents/collector.plist',
                                     env_file=folder / 'collector.env', state=folder / 'state', label='io.vibemon.collector',
                                     domain='gui/501', target='gui/501/io.vibemon.collector')
        self.paths.unit.parent.mkdir(parents=True)

    def runtime(self, name):
        path = self.paths.base / 'releases' / ('release-' + name)
        path.mkdir(parents=True)
        (path / '.vibemon-release').write_text(install.COLLECTOR_RELEASE_MARKER)
        return path

    def unit(self, runtime):
        return install.mac_collector_plist(self.paths, runtime, 'https://vibemon.io', 'My Mac', 'host-mac')

    def test_plist_uses_an_isolated_launcher_and_contains_no_credentials(self):
        runtime = self.runtime('new')
        (runtime / 'collector.env').write_text('VIBEMON_WRITE_TOKEN=private-value\n')
        unit = self.unit(runtime)
        value = plistlib.loads(unit.encode())
        self.assertNotIn('private-value', unit)
        self.assertNotIn('EnvironmentVariables', value)
        self.assertEqual(value['ProgramArguments'][:3], [str(runtime / 'venv/bin/python'), '-I', str(runtime / 'launch.py')])
        self.assertIn('My Mac', value['ProgramArguments'])
        self.assertEqual(install.mac_owned_runtime(self.paths, unit.encode()), runtime)

    def test_foreign_plists_and_runtimes_are_not_owned(self):
        foreign = self.runtime('foreign')
        for content in [b'not a plist', plistlib.dumps({'Label': self.paths.label}),
                        plistlib.dumps({'Label': self.paths.label, 'VibeMonManaged': True, 'VibeMonRuntime': str(foreign.parent.parent)})]:
            with self.subTest(content=content), self.assertRaisesRegex(RuntimeError, 'not created'):
                install.mac_owned_runtime(self.paths, content)

    def test_only_a_missing_service_is_treated_as_absent(self):
        missing = subprocess.CompletedProcess([], 113, '', 'Could not find service "io.vibemon.collector" in domain for user gui: 501')
        with mock.patch.object(install.subprocess, 'run', return_value=missing):
            self.assertIsNone(install.mac_collector_state(self.paths))
        for failure in [subprocess.CompletedProcess([], 113, '', 'Could not find domain'),
                        subprocess.CompletedProcess([], 1, '', 'Operation not permitted')]:
            with mock.patch.object(install.subprocess, 'run', return_value=failure), self.assertRaises(RuntimeError):
                install.mac_collector_state(self.paths)

    def test_loaded_agent_must_belong_to_the_expected_plist(self):
        result = subprocess.CompletedProcess([], 0, '\tpath = /another/collector.plist\n\tpid = 123\n', '')
        with mock.patch.object(install.subprocess, 'run', return_value=result), self.assertRaisesRegex(RuntimeError, 'another file'):
            install.mac_collector_state(self.paths)

    def test_readiness_rejects_another_program_and_old_acknowledgement(self):
        runtime = self.runtime('new')
        expected = plistlib.loads(self.unit(runtime).encode())['ProgramArguments']
        state = {'pid': 123, 'program': expected[0], 'arguments': expected}
        (runtime / 'health').write_text(str(time.time() - 180))
        with mock.patch.object(install, 'mac_collector_state', return_value=state), self.assertRaisesRegex(RuntimeError, 'timestamp'):
            install.wait_for_mac_collector(self.paths, runtime, expected)
        state['program'] = '/another/python'
        with mock.patch.object(install, 'mac_collector_state', return_value=state), self.assertRaisesRegex(RuntimeError, 'prepared collector'):
            install.wait_for_mac_collector(self.paths, runtime, expected)

    def test_startup_waits_for_a_pid_but_rejects_a_completed_exit(self):
        runtime = self.runtime('new')
        expected = plistlib.loads(self.unit(runtime).encode())['ProgramArguments']
        waiting = {'pid': None, 'exit_code': None, 'program': expected[0], 'arguments': expected}
        running = {**waiting, 'pid': 123}
        clock = [0]
        def tick(seconds):
            clock[0] += seconds
            (runtime / 'health').write_text(str(time.time()))
        with mock.patch.object(install, 'mac_collector_state', side_effect=[waiting, running]):
            install.wait_for_mac_collector(self.paths, runtime, expected, clock=lambda: clock[0], sleep=tick)
        self.assertEqual(clock[0], 1)
        with mock.patch.object(install, 'mac_collector_state', return_value={**waiting, 'exit_code': 2}), self.assertRaisesRegex(RuntimeError, 'stopped'):
            install.wait_for_mac_collector(self.paths, runtime, expected)

    def test_stop_failure_keeps_previous_files_and_never_starts_a_duplicate(self):
        old, new = self.runtime('old'), self.runtime('new')
        previous = self.unit(old).encode()
        self.paths.unit.write_bytes(previous)
        with mock.patch.object(install, 'mac_collector_state', return_value={'pid': 123}), \
                mock.patch.object(install, 'mac_stop_collector', side_effect=RuntimeError('stop failed')), \
                mock.patch.object(install, 'run_checked') as run, self.assertRaisesRegex(RuntimeError, 'stop failed'):
            install.activate_mac_collector(self.paths, new, self.unit(new), previous)
        run.assert_not_called()
        self.assertEqual(self.paths.unit.read_bytes(), previous)
        self.assertTrue(old.exists())

    def test_failed_upgrade_restores_previous_plist_and_restarts_it(self):
        old, new = self.runtime('old'), self.runtime('new')
        previous = self.unit(old).encode()
        self.paths.unit.write_bytes(previous)
        loaded, started = [True], []
        def stop(_paths): loaded[0] = False
        def run(command, *_args, **_kwargs):
            started.append(self.paths.unit.read_bytes())
            loaded[0] = True
        with mock.patch.object(install, 'mac_collector_state', side_effect=lambda *_: {'pid': 123} if loaded[0] else None), \
                mock.patch.object(install, 'mac_stop_collector', side_effect=stop), mock.patch.object(install, 'run_checked', side_effect=run), \
                mock.patch.object(install, 'wait_for_mac_collector', side_effect=RuntimeError('rejected')), self.assertRaisesRegex(RuntimeError, 'rejected'):
            install.activate_mac_collector(self.paths, new, self.unit(new), previous)
        self.assertEqual(started, [self.unit(new).encode(), previous])
        self.assertEqual(self.paths.unit.read_bytes(), previous)
        self.assertTrue(old.exists() and new.exists())
        self.assertTrue(loaded[0])

    def test_concurrent_plist_edit_preserves_the_edit_and_a_recovery_backup(self):
        old, new = self.runtime('old'), self.runtime('new')
        previous = self.unit(old).encode()
        self.paths.unit.write_bytes(previous)
        edited = b'user edited this file'
        def edit(*_args):
            self.paths.unit.write_bytes(edited)
        with mock.patch.object(install, 'mac_collector_state', return_value={'pid': 123}), \
                mock.patch.object(install, 'mac_stop_collector'), mock.patch.object(install, 'run_checked'), \
                mock.patch.object(install, 'wait_for_mac_collector', side_effect=edit), self.assertRaisesRegex(RuntimeError, 'restoration is incomplete'):
            install.activate_mac_collector(self.paths, new, self.unit(new), previous)
        self.assertEqual(self.paths.unit.read_bytes(), edited)
        self.assertEqual((new / 'previous-launchagent.plist').read_bytes(), previous)
        self.assertTrue(old.exists())

    def test_removal_keeps_files_when_the_service_cannot_stop(self):
        old = self.runtime('old')
        previous = self.unit(old).encode()
        self.paths.unit.write_bytes(previous)
        with mock.patch.object(install, 'MacCollectorPaths', return_value=self.paths), \
                mock.patch.object(install.os, 'geteuid', return_value=501, create=True), \
                mock.patch.object(install, 'mac_stop_collector', side_effect=RuntimeError('stop failed')), \
                mock.patch('sys.stdout', io.StringIO()), self.assertRaisesRegex(RuntimeError, 'stop failed'):
            install.uninstall_mac_collector()
        self.assertEqual(self.paths.unit.read_bytes(), previous)
        self.assertTrue(old.exists())
