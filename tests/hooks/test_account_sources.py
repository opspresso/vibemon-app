import json
from pathlib import Path
from unittest.mock import Mock
from account_sources import LocalAccountSource, tool_profile, read_json
from test_account_identity import codex


def environment(tmp_path):
    return {'HOME': str(tmp_path), 'VIBEMON_INSTANCE_ID': 'fixture', 'PATH': '/fixture/bin'}


def test_codex_adapter_uses_cli_selected_home_without_exposing_credentials(tmp_path):
    env = environment(tmp_path); env['CODEX_HOME'] = str(tmp_path / 'work')
    probe = Mock(return_value=codex())
    target = tool_profile('codex', env)
    result = LocalAccountSource(codex=probe).resolve(target, env, str(tmp_path))
    assert result.kind == 'account'
    assert probe.call_args.args[0]['CODEX_HOME'] == str(tmp_path / 'work')
    assert 'secret-fixture' not in json.dumps(result.record())


def test_custom_claude_profile_never_uses_default_account_metadata(tmp_path):
    env = environment(tmp_path); env['CLAUDE_CONFIG_DIR'] = str(tmp_path / 'work')
    status = {'loggedIn': True, 'authMethod': 'claude.ai', 'email': 'work@example.invalid', 'orgId': 'org-work'}
    read = Mock(return_value={'oauthAccount': {'accountUuid': 'work-user', 'emailAddress': status['email'], 'organizationUuid': status['orgId']}})
    target = tool_profile('claude', env)
    identity = LocalAccountSource(read=read, command=Mock(return_value=status)).resolve(target, env)
    assert identity.kind == 'account'
    assert read.call_args.args[0] == tmp_path / 'work' / '.claude.json'
    assert read.call_count == 1


def test_default_claude_home_does_not_become_an_explicit_custom_home(tmp_path):
    env = environment(tmp_path)
    status = {'loggedIn': True, 'authMethod': 'claude.ai', 'email': 'a@example.invalid', 'orgId': 'org'}
    settings = {'oauthAccount': {'accountUuid': 'user', 'emailAddress': status['email'], 'organizationUuid': status['orgId']}}
    command = Mock(return_value=status); read = Mock(return_value=settings)
    target = tool_profile('claude', env)
    assert 'CLAUDE_CONFIG_DIR' not in target.environment(env)
    assert LocalAccountSource(read=read, command=command).resolve(target, env).kind == 'account'
    assert read.call_args.args[0] == tmp_path / '.claude.json'
    explicit = tool_profile('claude', {**env, 'CLAUDE_CONFIG_DIR': str(tmp_path / '.claude')})
    assert explicit.key != target.key
    assert explicit.environment(env)['CLAUDE_CONFIG_DIR'] == str(tmp_path / '.claude')


def test_failed_probe_is_an_explicit_local_profile_not_another_account(tmp_path):
    env = environment(tmp_path)
    source = LocalAccountSource(command=lambda *args: None, codex=lambda *args: None)
    results = [source.resolve(tool_profile('codex', env, str(tmp_path / name)), env) for name in ['work', 'personal']]
    assert all(item.kind == 'profile' for item in results)
    assert results[0].id != results[1].id
    assert 'Account not identified' in results[0].display_name


def test_discovery_does_not_initialize_an_unused_claude_profile(tmp_path):
    env = environment(tmp_path)
    command = Mock(side_effect=AssertionError('An unused profile must not launch Claude'))
    result = LocalAccountSource(read=lambda *_: None, command=command).resolve(tool_profile('claude', env), env)
    assert result.kind == 'profile'
    command.assert_not_called()


def test_kiro_reader_uses_machine_readable_status(tmp_path):
    env = environment(tmp_path); command = Mock(return_value={'accountType': 'BuilderId', 'email': 'person@example.invalid'})
    result = LocalAccountSource(command=command).resolve(tool_profile('kiro', env), env, hint={'runtime': 'kiro-cli'})
    assert result.kind == 'account'
    assert command.call_args.args[0] == ['kiro-cli', 'whoami', '--format', 'json']


def test_bounded_metadata_reader_rejects_malformed_and_oversized_files(tmp_path):
    path = tmp_path / 'metadata.json'
    assert read_json(path) is None
    path.write_text('{invalid')
    assert read_json(path) is None
    path.write_text('"' + 'a' * (1024 * 1024) + '"')
    assert read_json(path) is None


def test_codex_reads_effective_credentials_instead_of_stale_auth_file(tmp_path, monkeypatch):
    import os
    import subprocess
    import sys
    import account_sources
    from test_account_identity import token
    old = codex(organization='old-workspace')
    (tmp_path / 'auth.json').write_text(json.dumps(old))
    calls = tmp_path / 'calls.json'
    helper = tmp_path / 'fake_codex.py'
    helper.write_text('''import sys,json
calls=[]
for line in sys.stdin:
    message=json.loads(line)
    calls.append({'method':message['method'],'params':message.get('params')})
    open(CALLS,'w').write(json.dumps(calls))
    if 'id' not in message:continue
    if message['method']=='initialize':result={}
    elif message['method']=='account/read':result={'requiresOpenaiAuth':True,'account':{'type':'chatgpt','email':'person@example.invalid','planType':'plus'}}
    elif message['method']=='getAuthStatus':result={'authMethod':'chatgpt','authToken':TOKEN}
    else:raise AssertionError(message['method'])
    print(json.dumps({'id':message['id'],'result':result}),flush=True)
'''.replace('CALLS', repr(str(calls))).replace('TOKEN', repr(token(organization='current-workspace'))))
    original = subprocess.Popen; children = []
    def spawn(*args, **kwargs):
        child = original([sys.executable, '-u', str(helper)], **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(account_sources.subprocess, 'Popen', spawn)
    monkeypatch.setattr(account_sources.shutil, 'which', lambda *args, **kwargs: sys.executable)
    env = {**os.environ, 'CODEX_HOME': str(tmp_path)}
    identity = account_sources.LocalAccountSource().resolve(tool_profile('codex', env), env)
    from account_parsers import codex_account
    assert identity.id == codex_account(codex(organization='current-workspace')).id
    assert identity.id != codex_account(old).id
    requests = json.loads(calls.read_text())
    assert [r['method'] for r in requests] == ['initialize','initialized','account/read','getAuthStatus']
    assert requests[-1]['params']['refreshToken'] is False
    assert all(child.poll() is not None for child in children)


def test_api_credentials_are_distinct_without_claiming_they_identify_people(tmp_path):
    env = environment(tmp_path)
    source = LocalAccountSource(read=lambda *_: None)
    identities = [source.resolve(tool_profile('claude', env), {**env, 'ANTHROPIC_API_KEY': secret}) for secret in ['fixture-key-a','fixture-key-b']]
    assert all(identity.kind == 'credential' for identity in identities)
    assert identities[0].id != identities[1].id
    assert not any(secret in json.dumps([i.record() for i in identities]) for secret in ['fixture-key-a','fixture-key-b'])


def test_kiro_ide_never_borrows_the_cli_login(tmp_path):
    env = environment(tmp_path)
    command = Mock(side_effect=AssertionError('IDE identity must not come from the CLI'))
    identity = LocalAccountSource(command=command).resolve(tool_profile('kiro', env), env, hint={'runtime':'kiro-ide'})
    assert identity.kind == 'profile'
    command.assert_not_called()
