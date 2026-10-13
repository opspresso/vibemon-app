import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import venv

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'public/install'))
import install

FIXTURE = json.loads((ROOT / 'tests/fixtures/windows-hook-commands.json').read_text())


class WindowsHookCommandsTest(unittest.TestCase):
    def test_shared_command_vector_preserves_literal_argv_and_owned_identity(self):
        self.assertEqual(install.windows_hook_command(*FIXTURE['args']), FIXTURE['command'])
        self.assertEqual(install._command_tokens(FIXTURE['command'], windows=True), FIXTURE['args'])
        self.assertTrue(install._is_vibemon_hook({'command': FIXTURE['command']}))
        hooks = {'Stop': [{'hooks': [
            {'command': FIXTURE['command']}, {'command': 'python3 user-owned.py'},
        ]}]}
        install.strip_all_vibemon_hooks(hooks)
        self.assertEqual(hooks, {'Stop': [{'hooks': [{'command': 'python3 user-owned.py'}]}]})

    def test_inspection_rejects_malformed_or_nonliteral_encoded_commands(self):
        for body in ["Write-Output 'vibemon.py'", "& 'python3' 'vibemon.py'; exit $LASTEXITCODE; Write-Output 'extra'"]:
            command = install.WINDOWS_ENCODED_PREFIX + base64.b64encode(body.encode('utf-16le')).decode('ascii')
            self.assertFalse(install._is_vibemon_hook({'command': command}))
        for value in ['bad!', 'AA==', '']:
            self.assertEqual(install._command_tokens(install.WINDOWS_ENCODED_PREFIX + value), [])

    @unittest.skipUnless(os.name == 'nt', 'Real Windows shells are verified in Windows CI')
    def test_provider_commands_deliver_literal_paths_stdin_and_failures_in_each_shell(self):
        git = shutil.which('git')
        bash = Path(git).parent.parent / 'bin/bash.exe' if git else None
        self.assertTrue(bash and bash.is_file(), 'Windows CI must provide Git Bash')
        shells = [
            [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/s', '/c'],
            ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
            [str(bash), '-c'],
        ]
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "O'Connor & $NAME `literal` %NAME% ! ; 한글"
            script = home / 'hooks/vibemon.py'
            script.parent.mkdir(parents=True)
            # venv rejects Windows' PATH separator; keep it in the script path.
            environment = Path(directory) / "Python & $NAME `literal` %NAME% ! 한글"
            venv.EnvBuilder(with_pip=False).create(environment)
            python = install.hook_path(environment / 'Scripts/python.exe')
            script.write_text('import json,sys\nsys.stdin.reconfigure(encoding="utf-8")\nvalue=json.load(sys.stdin)\nprint(json.dumps({"file":__file__,"args":sys.argv[1:],"input":value}))\nsys.exit(value["exit"])\n', encoding='utf-8')
            with patch.object(install, 'IS_WINDOWS', True), patch.object(install, 'hook_python', return_value=python):
                codex = install.adapt_codex_hooks({'hooks': {'Stop': [{'hooks': [{'command': 'python3 ~/.codex/hooks/vibemon.py'}]}]}}, home)
                kiro = json.loads(install.adapt_kiro_hook_config(json.dumps({'hooks': [{'action': {'command': 'python3 ~/.kiro/hooks/vibemon.py Stop'}}]}), home))
            commands = [
                ('Codex', codex['hooks']['Stop'][0]['hooks'][0]['commandWindows'], []),
                ('Kiro', kiro['hooks'][0]['action']['command'], ['Stop']),
            ]
            for shell in shells:
                for provider, command, args in commands:
                    for exit_code in [0, 17]:
                        with self.subTest(shell=shell[0], provider=provider, exit_code=exit_code):
                            value = {'value': '한글 fixture', 'exit': exit_code}
                            result = subprocess.run([*shell, command], input=json.dumps(value, ensure_ascii=False), capture_output=True, encoding='utf-8', timeout=15, env={**os.environ, 'NAME': 'must-not-expand'})
                            self.assertEqual(result.returncode == 0, exit_code == 0, result.stderr)
                            payload = json.loads(result.stdout)
                            self.assertEqual(Path(payload['file']).resolve(), script.resolve())
                            self.assertEqual(payload['args'], args)
                            self.assertEqual(payload['input'], value)
            Path(python).unlink()
            for shell in shells:
                with self.subTest(shell=shell[0], missing_interpreter=True):
                    result = subprocess.run([*shell, commands[0][1]], input='{}', capture_output=True, encoding='utf-8', timeout=15)
                    self.assertNotEqual(result.returncode, 0, 'a missing pinned interpreter must fail')


if __name__ == '__main__':
    unittest.main()
