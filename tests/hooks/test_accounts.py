import json
import os
import runpy
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch

import account_context
import usage_cache
import vibemon_core
import statusline

ROOT = Path(__file__).parents[2] / 'public' / 'install'


class AccountIsolationTest(unittest.TestCase):
    def test_four_provider_accounts_keep_usage_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'usage.json')
            for provider in ['claude', 'codex']:
                for identity, percent in [('work', 20), ('personal', 70)]:
                    with patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': identity}, clear=True):
                        self.assertTrue(usage_cache.save_usage_cache(path, {provider: {'session': {'pct': percent}}}, now=100))
            data = usage_cache.load_usage_cache(path)
            for provider in ['claude', 'codex']:
                for identity, percent in [('work', 20), ('personal', 70)]:
                    with patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': identity}, clear=True):
                        fresh = usage_cache.get_fresh_provider(data, provider, 60, now=120)
                        self.assertEqual(fresh['session']['pct'], percent)
            with patch.dict(os.environ, {'HOME': directory, 'USERPROFILE': directory}, clear=True):
                self.assertIsNone(usage_cache.get_fresh_provider(data, 'claude', 60, now=120))

    def test_named_account_never_reads_default_account_cache(self):
        with patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': 'work'}, clear=True):
            self.assertIsNone(usage_cache.get_fresh_provider({'claude': {'updated_at': 100, 'session': {'pct': 95}}}, 'claude', 60, now=110))

    def test_same_project_cache_is_separate_for_each_account(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'projects.json')
            for identity, memory in [('work', 10), ('personal', 80)]:
                with patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': identity, 'VIBEMON_CACHE_PATH': path}, clear=True):
                    statusline.save_to_cache('same-project', identity, memory)
            for identity, memory in [('work', 10), ('personal', 80)]:
                with patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': identity}, clear=True), patch.object(vibemon_core, 'get_config', return_value=SimpleNamespace(cache_path=path)):
                    self.assertEqual(vibemon_core.get_project_metadata('same-project'), {'model': identity, 'memory': memory, 'ts': json.loads(Path(path).read_text())[account_context.project_cache_key('same-project')]['ts']})

    def test_same_basename_in_different_workspaces_never_shares_context(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'projects.json')
            with patch.dict(os.environ, {'VIBEMON_CACHE_PATH': path, 'HOME': directory, 'USERPROFILE': directory}, clear=True), patch.object(vibemon_core, 'get_config', return_value=SimpleNamespace(cache_path=path)):
                statusline.save_to_cache('project', 'model-a', 10, '/workspace/a/project')
                statusline.save_to_cache('project', 'model-b', 80, '/workspace/b/project')
                self.assertEqual(vibemon_core.get_project_metadata('project', '/workspace/a/project')['memory'], 10)
                self.assertEqual(vibemon_core.get_project_metadata('project', '/workspace/b/project')['memory'], 80)
                self.assertEqual(vibemon_core.get_project_metadata('project', '/workspace/c/project'), {})

    def test_source_ids_include_provider_account_machine_and_workspace(self):
        identities = set()
        for character in ['clawd', 'codex', 'kiro']:
            for account in ['work', 'personal']:
                for machine in ['one', 'two']:
                    with patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': account, 'VIBEMON_INSTANCE_ID': machine}, clear=True):
                        result = account_context.cloud_context(character, 'same-project', '/workspace/project')
                        self.assertEqual(result['account']['id'], account)
                        identities.add(result['sourceId'])
        self.assertEqual(len(identities), 12)

    def test_explicit_openclaw_source_ids_remain_wire_compatible(self):
        # Existing OpenClaw installations used this POSIX workspace identity.
        # Keep that exact input here instead of resolving it onto a CI drive.
        with patch.dict(os.environ, {'VIBEMON_OPENCLAW_ACCOUNT_ID': 'work', 'VIBEMON_INSTANCE_ID': 'test-machine'}, clear=True), patch.object(account_context.Path, 'resolve', return_value=PurePosixPath('/server')):
            result = account_context.cloud_context('openclaw', 'OpenClaw', '/server')
        self.assertEqual(result['sourceId'], 'agent:84718e3543c37148d811992cd3a6f77d4fdae75b02dff7d410b6b43c30dd536b')

    def test_plugin_cloud_delivery_keeps_the_local_event_timestamp(self):
        with patch.dict(os.environ, {'VIBEMON_OPENCLAW_ACCOUNT_ID': 'work', 'HOME': str(Path.home()), 'USERPROFILE': str(Path.home())}, clear=True):
            context = account_context.cloud_context('openclaw', 'Project')
            payload = {'project': 'Project', 'state': 'working', **context}
            config = SimpleNamespace(vibemon_url='https://web.example', vibemon_token='fixture-write')
            with patch.object(vibemon_core, 'get_config', return_value=config), patch.object(vibemon_core, 'read_input', return_value=json.dumps(payload)), patch.object(vibemon_core, 'send_vibemon_api', return_value=True) as send:
                self.assertTrue(vibemon_core.send_cloud_status('openclaw'))
                self.assertEqual(send.call_args.args[3], context)

    def test_custom_claude_profile_does_not_read_default_keychain(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': directory, 'CODEX_HOME': directory}, clear=True):
            Path(directory, '.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': 'fixture-only'}}))
            module = runpy.run_path(str(ROOT / 'vibemon' / 'usage.py'))
            self.assertEqual(module['CODEX_AUTH_FILE'], str(Path(directory) / 'auth.json'))
            self.assertEqual(module['CODEX_SESSIONS_DIR'], str(Path(directory) / 'sessions'))
            with patch.object(sys, 'platform', 'darwin'), patch('subprocess.run') as command:
                self.assertEqual(module['read_claude_token'](), 'fixture-only')
                command.assert_not_called()

    def test_local_and_cloud_receive_the_same_source_identity(self):
        payload = {'project': 'same-project', 'character': 'codex', 'state': 'working'}
        config = SimpleNamespace(http_urls=['http://127.0.0.1:19280'], auto_launch=False, serial_port=None, vibemon_url='https://web.example', vibemon_token='fixture-write')
        context = {'sourceId': 'agent:work', 'account': {'id': 'work', 'provider': 'codex', 'displayName': 'Work'}, 'observedAt': '2026-10-09T00:00:00.000Z'}
        with patch.object(vibemon_core, 'get_config', return_value=config), patch.object(vibemon_core, 'send_http_post', return_value=(True, None)) as local, patch.object(vibemon_core, 'send_vibemon_api', return_value=True) as cloud:
            vibemon_core.send_to_all(payload, False, context)
        self.assertEqual(json.loads(local.call_args.args[2]), {**payload, **context})
        self.assertNotIn('sourceId', payload)
        cloud.assert_called_once_with('https://web.example', 'fixture-write', payload, context)
