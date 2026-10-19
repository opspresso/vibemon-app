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
