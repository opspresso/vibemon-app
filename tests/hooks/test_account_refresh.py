from types import SimpleNamespace
from account_identity import authenticated, named
from account_refresh import profile_environments, refresh_profiles
from account_sources import tool_profile
from account_store import JsonAccountStore
from dataclasses import asdict


def registry(tmp_path):
    env = {'HOME': str(tmp_path), 'VIBEMON_INSTANCE_ID': 'fixture', 'PATH': '/fixture/bin'}
    store = JsonAccountStore(str(tmp_path / 'accounts.json'))
    work = tool_profile('codex', env, str(tmp_path / 'work'))
    personal = tool_profile('codex', env, str(tmp_path / 'personal'))
    store.update(lambda _: {'version':1,'sessions':{},'profiles':{
        work.key:{**asdict(work),'account':named('codex','work','Work').record()},
        personal.key:{**asdict(personal),'account':authenticated('codex','person','org','Personal','fixture').record()}}})
    return env, store, work, personal


def test_each_profile_gets_its_own_home_and_cannot_inherit_another_profiles_secret(tmp_path):
    env, store, work, personal = registry(tmp_path)
    env.update(CODEX_HOME=work.root, OPENAI_API_KEY='fixture-private-key', VIBEMON_ACCOUNT_ID='work')
    jobs = profile_environments(store, env, {'codex'})
    by_home = {child['CODEX_HOME']: child for _, child in jobs}
    assert by_home[work.root]['OPENAI_API_KEY'] == 'fixture-private-key'
    assert by_home[work.root]['VIBEMON_CODEX_ACCOUNT_ID'] == 'work'
    assert 'OPENAI_API_KEY' not in by_home[personal.root]
    assert 'VIBEMON_ACCOUNT_ID' not in by_home[personal.root]
    assert 'VIBEMON_CODEX_ACCOUNT_ID' not in by_home[personal.root]
    assert all(child['VIBEMON_SUPPRESS_HOOKS'] == '1' for _, child in jobs)


def test_default_claude_profile_keeps_the_home_override_unset(tmp_path):
    env = {'HOME':str(tmp_path),'VIBEMON_INSTANCE_ID':'fixture'}
    jobs = profile_environments(JsonAccountStore(str(tmp_path/'empty.json')), env, {'claude'})
    assert len(jobs) == 1
    assert 'CLAUDE_CONFIG_DIR' not in jobs[0][1]


def test_refresh_reports_partial_failure_and_limits_child_runtime(tmp_path):
    env, store, work, personal = registry(tmp_path)
    seen=[]
    def run(args, **kwargs):
        seen.append((args,kwargs))
        return SimpleNamespace(returncode=1 if kwargs['env'].get('CODEX_HOME') == personal.root else 0)
    assert refresh_profiles('/fixture/usage.py', store.path, env, {'codex'}, 90, run=run) is False
    assert len(seen) == 3
    assert all(args[2:4] == ['--provider','codex'] for args,_ in seen)
    assert all(kwargs['timeout'] <= 20 for _,kwargs in seen)
    assert not any('fixture-private' in str(args) for args,_ in seen)


def test_registered_cache_paths_and_instance_names_survive_background_refresh(tmp_path):
    env, store, work, personal = registry(tmp_path)
    cache = str(tmp_path / 'custom-cache' / 'projects.json')
    store.update(lambda data: {**data, 'profiles': {**data['profiles'], work.key: {**data['profiles'][work.key], 'cachePath': cache}}})
    env['VIBEMON_INSTANCE_ID'] = 'another-launcher'
    jobs = profile_environments(store, env, {'codex'})
    child = next(child for _, child in jobs if child.get('CODEX_HOME') == work.root)
    assert child['VIBEMON_CACHE_PATH'] == cache
    assert child['VIBEMON_INSTANCE_ID'] == 'fixture'


def test_expired_deadline_leaves_unattempted_profiles_eligible_for_next_cycle(tmp_path):
    env, store, work, personal = registry(tmp_path)
    ticks = iter([0, 46, 46, 46])
    def never(*args, **kwargs):
        raise AssertionError('No child may start beyond the deadline')
    assert not refresh_profiles('/fixture/usage.py', store.path, env, {'codex'}, 90, run=never, now=lambda: next(ticks))
    assert not store.read().get('refreshAttempts')
