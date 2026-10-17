"""Identity semantics and provider boundaries use synthetic data only."""
import base64
import json
import pytest
from account_identity import AccountIdentity, authenticated, named, profile
from account_parsers import claude_account, codex_account, jwt_claims, kiro_account


def token(user='person-1', organization='workspace-1', email='person@example.invalid'):
    claims = {'sub': user, 'email': email, 'https://api.openai.com/auth': {'chatgpt_user_id': user, 'chatgpt_account_id': organization}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    return 'fixture.' + payload + '.unsigned'


def codex(user='person-1', organization='workspace-1', email='person@example.invalid'):
    return {'auth_mode': 'chatgpt', 'tokens': {'access_token': 'secret-fixture', 'id_token': token(user, organization, email), 'account_id': organization}}


def test_same_person_and_workspace_survive_email_and_token_changes():
    old = codex_account(codex())
    new = codex_account(codex(email='renamed@example.invalid'))
    assert old.id == new.id
    assert old.display_name != new.display_name
    assert 'secret-fixture' not in json.dumps(old.record())
    assert 'person-1' not in json.dumps(old.record())


def test_people_and_workspaces_are_independent_dimensions():
    identities = {codex_account(codex(user, workspace)).id for user in ['a', 'b'] for workspace in ['personal', 'team']}
    assert len(identities) == 4


def test_codex_must_not_label_api_key_or_inconsistent_tokens_as_chatgpt_account():
    value = codex(); value['auth_mode'] = 'apikey'
    assert codex_account(value) is None
    value = codex(); value['tokens']['account_id'] = 'different-workspace'
    assert codex_account(value) is None
    assert codex_account({'tokens': {'id_token': token()}}) is None


@pytest.mark.parametrize('value', [None, '', 'not.jwt', 'x.!invalid!.x', 'x.W10.x', 'x.' + 'a' * 70000 + '.x'])
def test_invalid_identity_claims_are_not_accounts(value):
    assert jwt_claims(value) == {}


def test_claude_requires_effective_login_to_match_saved_metadata():
    status = {'loggedIn': True, 'authMethod': 'claude.ai', 'email': 'a@example.invalid', 'orgId': 'org-a'}
    settings = {'oauthAccount': {'accountUuid': 'user-a', 'emailAddress': status['email'], 'organizationUuid': status['orgId']}}
    first = claude_account(status, settings)
    assert first.kind == 'account'
    assert claude_account({**status, 'authMethod': 'api_key'}, settings) is None
    assert claude_account({**status, 'loggedIn': False}, settings) is None
    assert claude_account({**status, 'email': 'b@example.invalid'}, settings) is None
    assert claude_account({**status, 'orgId': 'org-b'}, settings) is None


def test_profile_fallbacks_never_merge_distinct_machines_or_directories():
    identities = {profile('codex', root, machine, 'Not identified').id for root in ['/profiles/work', '/profiles/personal'] for machine in ['one', 'two']}
    assert len(identities) == 4
    assert profile('claude', '/profile', 'one', 'Profile').kind == 'profile'
    assert profile('opencode', '/profile', 'one', 'Work', 'credential-id').kind == 'credential'


def test_kiro_identity_includes_login_authority():
    first = {'email': 'a@example.invalid', 'accountType': 'IdentityCenter', 'startUrl': 'https://one.awsapps.com/start'}
    second = {**first, 'startUrl': 'https://two.awsapps.com/start'}
    assert kiro_account(first).id != kiro_account(second).id
    assert kiro_account({}) is None


def test_explicit_account_names_preserve_existing_contract():
    assert named('codex', 'work', 'Work').public() == {'provider': 'codex', 'id': 'work', 'displayName': 'Work'}
    with pytest.raises(ValueError): named('codex', '../escape')
    with pytest.raises(ValueError): named('codex', 'work', 'unsafe\nname')
    identity = authenticated('claude', 'subject', 'org', 'User', 'fixture')
    assert AccountIdentity.restore(identity.record()) == identity
