import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


INSTALLER = Path(__file__).parents[2] / 'public' / 'install' / 'install.py'


class InstallerRuntimeTest(unittest.TestCase):
    def test_help_from_file_and_stdin(self):
        for source in ('file', 'stdin'):
            with self.subTest(source=source):
                result = subprocess.run(
                    [sys.executable, str(INSTALLER) if source == 'file' else '-', '--help'],
                    input=INSTALLER.read_text(encoding='utf-8') if source == 'stdin' else None,
                    capture_output=True, encoding='utf-8', timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('--vibemon', result.stdout)

    def test_a_rejected_saved_token_changes_no_file(self):
        # An unattended update with a legacy token must fail before any write.
        # Otherwise a new hook runs against the older shared ~/.vibemon scripts.
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            seeded = {
                '.vibemon/config.json': json.dumps({'vibemon_token': 'old_arbitrary_token'}),
                '.vibemon/vibemon_core.py': '# older shared core\n',
                '.claude/settings.json': json.dumps({'hooks': {}, 'statusLine': {'type': 'command', 'command': 'mine'}}),
                '.claude/hooks/vibemon.py': '# older Claude hook\n',
                '.codex/hooks.json': '{}',
                '.kiro/hooks/vibemon.py': '# older Kiro hook\n',
                '.config/opencode/opencode.json': '{}',
                '.openclaw/openclaw.json': '{}',
            }
            for relative, content in seeded.items():
                (home / relative).parent.mkdir(parents=True, exist_ok=True)
                (home / relative).write_text(content, encoding='utf-8')

            def snapshot():
                return {str(path.relative_to(home)): None if path.is_dir() else path.read_bytes() for path in home.rglob('*')}

            before = snapshot()
            overrides = ('VIBEMON_', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIRO_HOME', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME')
            env = {key: value for key, value in os.environ.items() if not key.startswith(overrides)}
            env.update(HOME=directory, USERPROFILE=directory)
            result = subprocess.run([sys.executable, str(INSTALLER), '--all'], env=env, capture_output=True, encoding='utf-8', timeout=60)

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn('not a generated write token', result.stdout)
            self.assertEqual(snapshot(), before)

    def test_shared_scripts_install_and_import_in_isolated_home(self):
        script = '''
import runpy
import sys
from pathlib import Path
installer, directory = sys.argv[1:]
Path.home = classmethod(lambda cls: Path(directory))
sys.argv = [installer, '--vibemon']
try:
    runpy.run_path(installer, run_name='__main__')
except SystemExit as result:
    assert result.code in (None, 0), result.code
sys.path.insert(0, str(Path(directory) / '.vibemon'))
import vibemon_core
import usage
import http_deadline
assert Path(http_deadline.__file__).parent == Path(directory) / '.vibemon'
print('Installed hook imports verified')
'''
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, '-c', script, str(INSTALLER), directory],
                env={key: value for key, value in os.environ.items() if not key.startswith('VIBEMON_')},
                capture_output=True, encoding='utf-8', timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Installed hook imports verified', result.stdout)
            installed = Path(directory) / '.vibemon'
            self.assertTrue((installed / 'config.json').is_file())
            for source in (INSTALLER.parent / 'vibemon').glob('*.py'):
                self.assertEqual((installed / source.name).read_bytes(), source.read_bytes())
            self.assertEqual((installed / 'http_deadline.py').read_bytes(),
                             (INSTALLER.parents[2] / 'collector/vibemon_collector/http_deadline.py').read_bytes())
