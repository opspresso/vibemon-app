from unittest.mock import Mock
import pytest
from account_identity import authenticated
from account_service import AccountService
from account_sources import tool_profile
from account_store import JsonAccountStore


def fixture(tmp_path):
    env = {'HOME': str(tmp_path), 'VIBEMON_INSTANCE_ID': 'fixture'}
    target = tool_profile('codex', env)
    source = Mock()
    source.resolve.return_value = authenticated('codex', 'user-a', 'org-a', 'Account A', 'fixture')
    service = AccountService(source, JsonAccountStore(str(tmp_path / 'accounts.json')), now=lambda: 100)
    return service, source, target, env


def test_existing_session_keeps_its_account_after_another_login(tmp_path):
    service, source, target, env = fixture(tmp_path)
    a = service.bind(target, env, 'session-a', 'SessionStart')
    source.resolve.return_value = authenticated('codex', 'user-b', 'org-b', 'Account B', 'fixture')
    b = service.bind(target, env, 'session-b', 'SessionStart')
    assert a.id != b.id
    assert service.bind(target, env, 'session-a', 'PreToolUse') == a
    assert service.bind(target, env, 'session-b', 'PreToolUse') == b
    assert source.resolve.call_count == 2


def test_resumed_session_reidentifies_current_login(tmp_path):
    service, source, target, env = fixture(tmp_path)
    a = service.bind(target, env, 'same', 'SessionStart')
    source.resolve.return_value = authenticated('codex', 'user-b', 'org-b', 'Account B', 'fixture')
    b = service.bind(target, env, 'same', 'SessionStart')
    assert a.id != b.id
    assert service.bind(target, env, 'same', 'Stop') == b


def test_same_session_string_in_different_profiles_cannot_share_a_binding(tmp_path):
    service, source, first, env = fixture(tmp_path)
    second = tool_profile('codex', env, str(tmp_path / 'other'))
    a = service.bind(first, env, 'same', 'SessionStart')
    source.resolve.return_value = authenticated('codex', 'user-b', 'org-b', 'Account B', 'fixture')
    b = service.bind(second, env, 'same', 'SessionStart')
    assert a.id != b.id
    assert service.bind(first, env, 'same', 'PreToolUse') == a


def test_explicit_ids_do_not_inspect_provider_credentials(tmp_path):
    service, source, target, env = fixture(tmp_path)
    identity = service.bind(target, {**env, 'VIBEMON_CODEX_ACCOUNT_ID': 'work', 'VIBEMON_CODEX_ACCOUNT_NAME': 'My work'}, 'session', 'SessionStart')
    assert identity.id == 'work'
    assert identity.display_name == 'My work'
    source.resolve.assert_not_called()


def test_expired_bindings_are_replaced_and_cache_has_no_credentials(tmp_path):
    service, source, target, env = fixture(tmp_path)
    a = service.bind(target, env, 'session', 'SessionStart')
    service.now = lambda: 90000
    source.resolve.return_value = authenticated('codex', 'user-b', 'org-b', 'B', 'fixture')
    assert service.bind(target, env, 'session', 'PreToolUse').id != a.id
    raw = (tmp_path / 'accounts.json').read_text()
    assert 'user-a' not in raw and 'user-b' not in raw and 'org-b' not in raw
    assert (tmp_path / 'accounts.json').stat().st_mode & 0o077 == 0


def test_failed_persistence_does_not_claim_a_session_was_bound(tmp_path):
    service, source, target, env = fixture(tmp_path)
    service.store.update = Mock(side_effect=OSError('busy'))
    with pytest.raises(OSError):service.bind(target, env, 'session', 'SessionStart')
