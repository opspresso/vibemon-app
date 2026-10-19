import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from contextlib import ExitStack
from unittest import mock

import install


class CollectorFixture:
    def __init__(self, root, existing=True, active=True, enabled=True):
        self.paths = install.CollectorPaths(system=True)
        self.paths.base = root / 'collector'
        self.paths.unit = root / 'systemd/collector.service'
        self.paths.env_file = root / 'config/collector.env'
        self.paths.state = root / 'state'
        self.active = active if existing else False
        self.enabled = enabled if existing else False
        self.failure = None
        self.failures = set()
        self.commands = []
        self.before_ready = None
        self.original = {}
        if existing:
            self.original = {
                self.paths.base / 'app/vibemon_collector/__main__.py': '# working collector\n',
                self.paths.base / 'venv/bin/python': '# working interpreter\n',
                self.paths.unit: install.collector_unit(self.paths, 'https://old.example', 'Fixture', 'host-fixture'),
                self.paths.env_file: 'VIBEMON_WRITE_TOKEN=vm_' + 'a' * 60 + '\nVIBEMON_URL=https://old.example\n',
            }
            for path, content in self.original.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            self.paths.unit.chmod(0o640)
            self.paths.env_file.chmod(0o600)
        self.source = mock.Mock(get_file=mock.Mock(return_value='# new collector\n'))

    def run(self, command, description, **kwargs):
        self.commands.append((description, command))
        if description in self.failures or description == self.failure:
            self.failure = None
            raise RuntimeError('fixture failed: ' + description)
        if description == 'Reading the collector service':
            return f'FragmentPath={self.paths.unit if self.paths.unit.exists() else ""}\nActiveState={"active" if self.active else "inactive"}\nUnitFileState={"enabled" if self.enabled else "disabled"}\n'
        if 'stop' in command or 'disable' in command:
            self.active = False
        if 'disable' in command:
            self.enabled = False
        if 'start' in command:
            self.active = True
        if 'enable' in command:
            self.enabled = True
        return ''

    def ready(self, paths):
        assert not (paths.state / 'health').exists(), 'previous readiness must be cleared'
        if self.before_ready:
            self.before_ready()
        if self.failure == 'readiness':
            self.failure = None
            raise RuntimeError('fixture failed: readiness')
        (paths.state / 'health').write_text(str(time.time()))

    def __enter__(self):
        self.stack = ExitStack()
        for patch in [
            mock.patch.object(install, 'CollectorPaths', return_value=self.paths),
            mock.patch.object(install.platform, 'system', return_value='Linux'),
            mock.patch.object(install.shutil, 'which', return_value='/bin/systemctl'),
            mock.patch.object(install, 'SOURCE_NAME', 'Fixture'),
            mock.patch.object(install, 'collector_token', return_value='vm_' + 'b' * 60),
            mock.patch.object(install, 'web_origin', return_value='https://new.example'),
            mock.patch.object(install, 'run_checked', side_effect=self.run),
            mock.patch.object(install, 'wait_for_collector', side_effect=self.ready),
            mock.patch.object(install, 'verify_collector_runtime'),
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch('sys.stdout', io.StringIO()),
        ]:
            self.stack.enter_context(patch)
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)

    def install(self):
        return install.install_collector(self.source)

    def runtimes(self):
        return list((self.paths.base / 'releases').glob('release-*'))

    def assert_preserved(self, test, unit=True):
        for path, content in self.original.items():
            if path == self.paths.unit and not unit:
                continue
            test.assertTrue(path.exists(), path)
            test.assertEqual(path.read_text(), content, path)
        test.assertEqual(self.paths.env_file.stat().st_mode & 0o777, 0o600)


@unittest.skipUnless(hasattr(os, 'geteuid'), 'The host collector uses POSIX service paths')
class CollectorUpgradeTest(unittest.TestCase):
    def test_preparation_failures_preserve_the_working_installation(self):
        for failure in ('Creating the Python environment', 'Installing psutil', 'Checking the collector'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
                fixture.failure = failure
                with self.assertRaisesRegex(RuntimeError, 'fixture failed'):
                    fixture.install()
                fixture.assert_preserved(self)
                self.assertTrue(fixture.active)
                self.assertEqual(fixture.runtimes(), [])
                self.assertFalse(any('stop' in command for _, command in fixture.commands))
                install.collector_token.assert_not_called()

    def test_invalid_settings_or_an_orphan_service_do_not_start_sign_in(self):
        for orphan in (False, True):
            with self.subTest(orphan=orphan), tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
                if orphan:
                    fixture.paths.unit.unlink()
                else:
                    install.SOURCE_NAME = 'invalid"name'
                with self.assertRaises((ValueError, RuntimeError)):
                    fixture.install()
                install.collector_token.assert_not_called()
                fixture.source.get_file.assert_not_called()
                self.assertTrue(fixture.active)

    def test_failed_sign_in_leaves_the_previous_collector_running(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            install.collector_token.side_effect = RuntimeError('Sign-in was denied')
            with self.assertRaisesRegex(RuntimeError, 'Sign-in was denied'):
                fixture.install()
            fixture.assert_preserved(self)
            self.assertTrue(fixture.active)
            self.assertEqual(fixture.runtimes(), [])
            self.assertFalse(any('stop' in command for _, command in fixture.commands))

    def test_activation_failures_restore_files_and_service_state(self):
        for failure in ('Stopping the previous collector', 'Reloading systemd', 'Enabling the collector', 'Starting the collector', 'readiness'):
            for active in (False, True):
                with self.subTest(failure=failure, active=active), tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory), active=active, enabled=False) as fixture:
                    fixture.failure = failure
                    fixture.paths.state.mkdir()
                    (fixture.paths.state / 'health').write_text(str(time.time()))
                    with self.assertRaisesRegex(RuntimeError, 'fixture failed'):
                        fixture.install()
                    fixture.assert_preserved(self)
                    self.assertEqual(fixture.paths.unit.stat().st_mode & 0o777, 0o640)
                    self.assertEqual(fixture.active, active)
                    self.assertFalse(fixture.enabled)
                    self.assertEqual(fixture.runtimes(), [])
                    self.assertEqual(list(fixture.paths.unit.parent.glob('.vibemon-rollback-*')), [])

    def test_failed_fresh_install_removes_only_its_candidate(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory), existing=False) as fixture:
            fixture.failure = 'readiness'
            with self.assertRaisesRegex(RuntimeError, 'fixture failed'):
                fixture.install()
            self.assertFalse(fixture.paths.unit.exists())
            self.assertFalse(fixture.paths.env_file.exists())
            self.assertFalse(fixture.active)
            self.assertFalse(fixture.enabled)
            self.assertEqual(fixture.runtimes(), [])

    def test_switches_to_a_complete_runtime_and_prunes_only_owned_previous_releases(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            self.assertTrue(fixture.install())
            first = install.owned_collector_runtime(fixture.paths, fixture.paths.unit.read_text())
            fixture.assert_preserved(self, unit=False)
            self.assertIn(str(first / 'venv/bin/python'), fixture.paths.unit.read_text())
            self.assertIn(str(first / 'collector.env'), fixture.paths.unit.read_text())
            self.assertEqual((first / 'collector.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual(install.saved_collector_token(first / 'collector.env'), ('vm_' + 'b' * 60, 'https://new.example'))
            foreign = first.parent / 'release-user-files'
            foreign.mkdir()
            (foreign / 'keep.txt').write_text('user content')
            fixture.before_ready = lambda: self.assertTrue(first.exists(), 'keep the previous runtime until the new delivery is accepted')
            self.assertTrue(fixture.install())
            self.assertFalse(first.exists())
            self.assertEqual((foreign / 'keep.txt').read_text(), 'user content')
            self.assertEqual(install.collector_token.call_args.args[1:3], ('vm_' + 'b' * 60, 'https://new.example'))
            self.assertTrue(fixture.active)
            self.assertTrue(fixture.enabled)

    def test_incomplete_restoration_retains_runtime_and_backup_for_recovery(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            fixture.failure = 'readiness'
            fixture.failures.add('Stopping the failed collector')
            with self.assertRaisesRegex(RuntimeError, 'restoration is incomplete'):
                fixture.install()
            self.assertEqual(len(fixture.runtimes()), 1)
            self.assertEqual(len(list(fixture.paths.unit.parent.glob('.vibemon-rollback-*'))), 1)
            self.assertFalse(any(description == 'Restoring the previous collector' for description, _ in fixture.commands))

    def test_a_concurrent_unit_edit_is_kept_with_the_previous_unit_backup(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            edited = '# user changed this unit during deployment\n'
            fixture.before_ready = lambda: fixture.paths.unit.write_text(edited)
            fixture.failure = 'readiness'
            with self.assertRaisesRegex(RuntimeError, 'restoration is incomplete'):
                fixture.install()
            self.assertEqual(fixture.paths.unit.read_text(), edited)
            backup = next(fixture.paths.unit.parent.glob('.vibemon-rollback-*/unit'))
            self.assertEqual(backup.read_text(), fixture.original[fixture.paths.unit])
            self.assertFalse(fixture.active)

    def test_an_overridden_runtime_is_rejected_before_pruning_the_previous_version(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            self.assertTrue(fixture.install())
            previous = install.owned_collector_runtime(fixture.paths, fixture.paths.unit.read_text())
            unit = fixture.paths.unit.read_bytes()
            install.verify_collector_runtime.side_effect = RuntimeError('Unexpected running version')
            with self.assertRaisesRegex(RuntimeError, 'Unexpected running version'):
                fixture.install()
            self.assertTrue(previous.is_dir())
            self.assertEqual(fixture.paths.unit.read_bytes(), unit)
            self.assertTrue(fixture.active)

    def test_operations_share_a_stable_lock_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = CollectorFixture(Path(directory))
            with install.collector_lock(fixture.paths):
                inode = (fixture.paths.env_file.parent / '.collector.lock').stat().st_ino
                with self.assertRaisesRegex(RuntimeError, 'Another collector'):
                    with install.collector_lock(fixture.paths):
                        self.fail('concurrent operation entered')
            with install.collector_lock(fixture.paths):
                self.assertEqual((fixture.paths.env_file.parent / '.collector.lock').stat().st_ino, inode)

    def test_a_symlinked_install_root_does_not_prune_the_current_runtime(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            alias = Path(directory) / 'collector-alias'
            alias.symlink_to(fixture.paths.base, target_is_directory=True)
            fixture.paths.base = alias
            self.assertTrue(fixture.install())
            runtime = install.owned_collector_runtime(fixture.paths, fixture.paths.unit.read_text())
            self.assertTrue((runtime / 'collector.env').is_file())

    def test_a_broken_unit_link_is_preserved_before_install_or_removal(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            fixture.paths.unit.unlink()
            fixture.paths.unit.symlink_to('missing-user-unit')
            for action in (fixture.install, install.uninstall_collector):
                with self.assertRaisesRegex(RuntimeError, 'unit link is broken'):
                    action()
            self.assertTrue(fixture.paths.unit.is_symlink())
            self.assertEqual(os.readlink(fixture.paths.unit), 'missing-user-unit')
            self.assertEqual(fixture.commands, [])

    def test_uninstall_refuses_foreign_units_and_stop_failures_before_removing_files(self):
        for foreign in (False, True):
            with self.subTest(foreign=foreign), tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
                if foreign:
                    fixture.paths.unit.write_text('# user service\n')
                else:
                    fixture.failure = 'Stopping and disabling the collector'
                before = fixture.paths.unit.read_bytes()
                with self.assertRaises(RuntimeError):
                    install.uninstall_collector()
                fixture.assert_preserved(self, unit=False)
                self.assertEqual(fixture.paths.unit.read_bytes(), before)
                self.assertTrue(fixture.active)

    def test_uninstall_keeps_unrelated_files_in_managed_parent_directories(self):
        with tempfile.TemporaryDirectory() as directory, CollectorFixture(Path(directory)) as fixture:
            self.assertTrue(fixture.install())
            files = [fixture.paths.base / 'keep.txt', fixture.paths.base / 'app/user-package.py', fixture.paths.state / 'keep.txt']
            for path in files:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('keep')
            self.assertTrue(install.uninstall_collector())
            self.assertFalse(fixture.active)
            self.assertFalse(fixture.enabled)
            self.assertFalse(fixture.paths.unit.exists())
            self.assertFalse(fixture.paths.env_file.exists())
            self.assertEqual(fixture.runtimes(), [])
            for path in files:
                self.assertEqual(path.read_text(), 'keep')


class CollectorReadinessTest(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, 'geteuid'), 'Service process inspection uses POSIX process files')
    def test_checks_the_running_arguments_environment_and_working_directory_without_logging_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            runtime = root / 'runtime'
            runtime.mkdir()
            process = root / 'proc/123'
            process.mkdir(parents=True)
            (process / 'cwd').symlink_to(runtime, target_is_directory=True)
            args = [str(runtime / 'venv/bin/python'), '-m', 'vibemon_collector']
            (process / 'cmdline').write_bytes(b'\0'.join(os.fsencode(arg) for arg in args) + b'\0')
            (process / 'environ').write_bytes(b'PYTHONPATH=' + os.fsencode(runtime / 'app') + b'\0VIBEMON_WRITE_TOKEN=private-fixture\0')
            with mock.patch.object(install, 'collector_service_state', return_value={'ActiveState': 'active', 'MainPID': '123'}):
                install.verify_collector_runtime(None, runtime, args, 'private-fixture', process_root=root/'proc')
                for changed in ('arguments', 'environment', 'directory', 'python-home'):
                    (process / 'cmdline').write_bytes(b'\0'.join(os.fsencode(arg) for arg in args) + b'\0')
                    (process / 'environ').write_bytes(b'PYTHONPATH=' + os.fsencode(runtime / 'app') + b'\0VIBEMON_WRITE_TOKEN=private-fixture\0')
                    (process / 'cwd').unlink()
                    (process / 'cwd').symlink_to(runtime, target_is_directory=True)
                    if changed == 'arguments':
                        (process / 'cmdline').write_bytes(b'/old/python\0-m\0vibemon_collector\0')
                    elif changed == 'environment':
                        (process / 'environ').write_bytes(b'VIBEMON_WRITE_TOKEN=another-private-fixture\0')
                    elif changed == 'directory':
                        (process / 'cwd').unlink()
                        (process / 'cwd').symlink_to(root, target_is_directory=True)
                    else:
                        with (process / 'environ').open('ab') as output:
                            output.write(b'PYTHONHOME=/old-python\0')
                    with self.assertRaisesRegex(RuntimeError, '^The collector process does not use the prepared runtime; check systemd overrides$'):
                        install.verify_collector_runtime(None, runtime, args, 'private-fixture', process_root=root/'proc')

    def test_missing_readiness_is_bounded_and_malformed_content_is_not_disclosed(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = mock.Mock(state=Path(directory))
            now = [0]
            with mock.patch.object(install, 'collector_service_state', return_value={'ActiveState': 'active'}), \
                    mock.patch.object(install, 'COLLECTOR_START_TIMEOUT_SECONDS', 2):
                with self.assertRaisesRegex(RuntimeError, 'within 2 seconds'):
                    install.wait_for_collector(paths, clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
                self.assertEqual(now[0], 2)
                (paths.state / 'health').write_text('private fixture contents')
                with self.assertRaisesRegex(RuntimeError, '^The collector readiness file is invalid$'):
                    install.wait_for_collector(paths)

    def test_waits_for_a_new_acknowledgement_and_rejects_stopped_services(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = mock.Mock(state=Path(directory))
            now = [0]
            def sleep(seconds):
                now[0] += seconds
                (paths.state / 'health').write_text(str(time.time()))
            with mock.patch.object(install, 'collector_service_state', return_value={'ActiveState': 'active'}):
                install.wait_for_collector(paths, clock=lambda: now[0], sleep=sleep)
            self.assertEqual(now[0], 1)
            with mock.patch.object(install, 'collector_service_state', return_value={'ActiveState': 'failed'}), self.assertRaisesRegex(RuntimeError, 'stopped'):
                install.wait_for_collector(paths)
