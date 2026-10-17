import json
import sys
from types import SimpleNamespace
import account_context
import statusline
import vibemon_core as core
from account_identity import authenticated


def test_two_profiles_in_one_project_report_separate_accounts_and_usage_keys(tmp_path, monkeypatch):
    monkeypatch.delenv('VIBEMON_ACCOUNT_ID', raising=False)
    monkeypatch.delenv('VIBEMON_CODEX_ACCOUNT_ID', raising=False)
    monkeypatch.setattr(sys, 'argv', ['vibemon.py'])
    monkeypatch.setattr(core, 'get_config', lambda: SimpleNamespace(cache_path=str(tmp_path / 'projects.json')))
    monkeypatch.setattr(account_context._source, 'resolve', lambda target, *_: authenticated('codex', target.root, 'org', 'Detected account', 'fixture'))
    sent = []; keys = []
    monkeypatch.setattr(core, 'send_to_all', lambda payload, is_start, context: sent.append(context))

    def payload(state, tool, project, data):
        keys.append(account_context.cache_key('codex'))
        return {'state': state, 'tool': tool, 'project': project, 'character': 'codex'}

    for name in ['work', 'personal']:
        monkeypatch.setenv('CODEX_HOME', str(tmp_path / name))
        monkeypatch.setattr(core, 'read_input', lambda name=name: json.dumps({'session_id': name, 'hook_event_name': 'SessionStart', 'cwd': str(tmp_path)}))
        core.run({'SessionStart': 'start'}, payload, 'SessionStart', account_provider='codex')
    assert len(sent) == 2
    assert sent[0]['account']['id'] != sent[1]['account']['id']
    assert sent[0]['sourceId'] != sent[1]['sourceId']
    assert keys[0] != keys[1]
    assert keys == [f"codex:{value['account']['id']}" for value in sent]


def test_late_heartbeat_keeps_original_account_after_login_changes(tmp_path, monkeypatch):
    first = authenticated('codex', 'first', 'org', 'First', 'fixture')
    monkeypatch.setenv('VIBEMON_CODEX_ACCOUNT_ID', 'another-login')
    sent = []
    monkeypatch.setattr(core, 'send_to_all', lambda payload, is_start, context: sent.append(context))
    core.deliver_report({'state': 'working', 'project': 'same', 'character': 'codex'}, str(tmp_path),
        '2026-10-17T00:00:00.000Z', heartbeat=True, account=first.record())
    assert sent[0]['account'] == first.public()
    assert sent[0]['heartbeat'] is True


def test_statusline_uses_the_hook_session_account_even_after_profile_login_changes(tmp_path, monkeypatch):
    monkeypatch.delenv('VIBEMON_ACCOUNT_ID', raising=False)
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(tmp_path / 'claude-work'))
    first = authenticated('claude', 'first', 'org', 'First', 'fixture')
    second = authenticated('claude', 'second', 'org', 'Second', 'fixture')
    monkeypatch.setattr(account_context._source, 'resolve', lambda *_: first)
    account_context.prepare_account('claude', {'session_id': 's1', 'hook_event_name': 'SessionStart'})
    monkeypatch.setattr(account_context._source, 'resolve', lambda *_: second)
    seen = []
    monkeypatch.setattr(statusline, 'read_input', lambda: json.dumps({'session_id': 's1'}))
    monkeypatch.setattr(statusline, 'render_statusline', lambda data: seen.append(account_context.current_account('claude')))
    statusline.main()
    assert seen == [first]


def test_account_persistence_failure_does_not_publish_misattributed_activity(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['vibemon.py'])
    monkeypatch.setattr(core, 'read_input', lambda: json.dumps({'session_id': 's1', 'hook_event_name': 'SessionStart'}))
    def fail(*args): raise OSError('fixture storage unavailable')
    monkeypatch.setattr(core, 'prepare_account', fail)
    sent = []
    monkeypatch.setattr(core, 'send_to_all', lambda *args: sent.append(args))
    core.run({'SessionStart': 'start'}, lambda *args: {}, 'SessionStart', account_provider='codex')
    assert sent == []


def test_activity_keys_separate_copied_session_ids_in_two_profiles(tmp_path, monkeypatch):
    account = authenticated('codex', 'same-user', 'same-org', 'Same account', 'fixture')
    keys = []
    for name in ['work', 'another-profile']:
        monkeypatch.setenv('CODEX_HOME', str(tmp_path / name))
        keys.append(account_context.activity_key(account, 'copied-session'))
    assert keys[0] != keys[1]


def test_opencode_waits_for_the_selected_backend_without_losing_desktop_launch(tmp_path, monkeypatch):
    from unittest.mock import Mock
    monkeypatch.delenv('VIBEMON_ACCOUNT_ID', raising=False)
    monkeypatch.delenv('VIBEMON_OPENCODE_ACCOUNT_ID', raising=False)
    monkeypatch.setattr(sys, 'argv', ['vibemon.py'])
    monkeypatch.setattr(core, 'read_input', lambda: json.dumps({'session_id': 's1', 'hook_event_name': 'SessionStart', 'account_hint': {'provider': ''}}))
    launch = Mock(); send = Mock(); probe = Mock()
    monkeypatch.setattr(core, 'prepare_desktop', launch)
    monkeypatch.setattr(core, 'send_to_all', send)
    monkeypatch.setattr(core, 'prepare_account', probe)
    core.run({'SessionStart': 'start'}, lambda *args: {}, 'SessionStart', account_provider='opencode')
    launch.assert_called_once()
    send.assert_not_called()
    probe.assert_not_called()


def test_openclaw_agents_share_an_explicit_account_but_keep_distinct_project_sources(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('VIBEMON_OPENCLAW_ACCOUNT_ID', 'shared-account')
    contexts = []
    for agent in ['work', 'personal']:
        data = {'project': 'Shared project', 'cwd': str(tmp_path), 'session_id': agent,
                'hook_event_name': 'SessionStart', 'account_hint': {'agent_id': agent}}
        monkeypatch.setattr(core, 'read_input', lambda data=data: json.dumps(data))
        assert core.resolve_plugin_account('openclaw') is True
        contexts.append(json.loads(capsys.readouterr().out))
    assert contexts[0]['account']['id'] == contexts[1]['account']['id'] == 'shared-account'
    assert contexts[0]['sourceId'] != contexts[1]['sourceId']
    assert set(contexts[0]) == {'account', 'sourceId', 'observedAt'}
