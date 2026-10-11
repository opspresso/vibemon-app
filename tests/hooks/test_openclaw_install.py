import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[2] / 'public' / 'install'))
import install


class OpenClawRegistrationTests(unittest.TestCase):
    def test_failed_registry_refresh_makes_install_and_removal_incomplete(self):
        for action in [install.install_openclaw, install.uninstall_openclaw]:
            with self.subTest(action=action.__name__), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                config_file = home / '.openclaw' / 'openclaw.json'
                config_file.parent.mkdir()
                config_file.write_text(json.dumps({'agents': {'defaults': {'model': 'keep-model'}}}))
                source = install.FileSource(Path(__file__).parents[2] / 'public' / 'install')
                output = io.StringIO()
                with patch.object(Path, 'home', return_value=home), patch.object(install, 'IS_WINDOWS', False), patch.object(install, 'configure_vibemon_config', return_value=''), patch.object(install, 'install_vibemon_shared', return_value=True), patch.object(install.shutil, 'which', return_value='/fixture/openclaw'), patch.object(install.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'fixture-private-diagnostic')), contextlib.redirect_stdout(output):
                    self.assertFalse(install.run_install('OpenClaw', action, source))
                self.assertEqual(json.loads(config_file.read_text())['agents']['defaults']['model'], 'keep-model')
                self.assertNotIn('fixture-private-diagnostic', output.getvalue())

    def test_refresh_reports_success_missing_cli_and_process_failure(self):
        with contextlib.redirect_stdout(io.StringIO()), patch.object(install.shutil, 'which', return_value=None):
            self.assertFalse(install.refresh_openclaw_plugin_registry())
        with contextlib.redirect_stdout(io.StringIO()), patch.object(install.shutil, 'which', return_value='/fixture/openclaw'), patch.object(install.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
            self.assertTrue(install.refresh_openclaw_plugin_registry())
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(install.shutil, 'which', return_value='/fixture/openclaw'), patch.object(install.subprocess, 'run', side_effect=OSError('fixture-private-diagnostic')):
            self.assertFalse(install.refresh_openclaw_plugin_registry())
        self.assertNotIn('fixture-private-diagnostic', output.getvalue())
