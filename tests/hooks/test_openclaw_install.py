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


class MalformedConfigShapeTests(unittest.TestCase):
    """Valid JSON whose shape is wrong must not abort an install or removal."""

    def run_action(self, action, home, relative, content, which='/fixture/openclaw'):
        config_file = home / relative
        config_file.parent.mkdir(parents=True, exist_ok=True)
        config_file.write_text(content)
        source = install.FileSource(Path(__file__).parents[2] / 'public' / 'install')
        with patch.object(Path, 'home', return_value=home), patch.dict(install.os.environ, {'CLAUDE_CONFIG_DIR': ''}), patch.object(install, 'IS_WINDOWS', False), patch.object(install, 'configure_vibemon_config', return_value=''), patch.object(install, 'install_vibemon_shared', return_value=True), patch.object(install.shutil, 'which', return_value=which), patch.object(install.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')), contextlib.redirect_stdout(io.StringIO()):
            result = install.run_install('fixture', action, source)
        return result, config_file

    def test_openclaw_install_repairs_non_object_sections(self):
        shapes = ['[]', '{"plugins": []}', '{"plugins": {"entries": []}}', '{"plugins": {"entries": {"vibemon-bridge": "on"}}}', '{"plugins": {"entries": {"vibemon-bridge": {"hooks": []}}}}']
        for content in shapes:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                result, config_file = self.run_action(install.install_openclaw, Path(directory), '.openclaw/openclaw.json', content)
                self.assertTrue(result)
                entry = json.loads(config_file.read_text())['plugins']['entries']['vibemon-bridge']
                self.assertIsInstance(entry, dict)
                self.assertIs(entry['hooks']['allowConversationAccess'], True)

    def test_removal_ignores_a_non_object_top_level(self):
        cases = [(install.uninstall_openclaw, '.openclaw/openclaw.json'), (install.uninstall_claude, '.claude/settings.json')]
        for action, relative in cases:
            with self.subTest(action=action.__name__), tempfile.TemporaryDirectory() as directory:
                result, config_file = self.run_action(action, Path(directory), relative, '["user-owned"]')
                self.assertTrue(result)
                self.assertEqual(json.loads(config_file.read_text()), ['user-owned'])

    def test_vibemon_config_restarts_from_the_example_when_not_an_object(self):
        with tempfile.TemporaryDirectory() as directory:
            config_file = Path(directory) / 'config.json'
            config_file.write_text('["user-owned"]')
            example = (Path(__file__).parents[2] / 'public' / 'install' / 'vibemon' / 'config.example.json').read_text()
            with contextlib.redirect_stdout(io.StringIO()):
                config = install.load_or_create_config(config_file, example)
            self.assertEqual(config, json.loads(example))
            self.assertEqual(json.loads(config_file.with_name('config.json.bak').read_text()), ['user-owned'])
