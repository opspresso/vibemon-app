"""Unknown values must survive provider parsing and cloud serialization."""
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

import statusline
import usage_cache
import vibemon_core

ROOT = Path(__file__).parents[2] / 'public' / 'install'


@pytest.mark.parametrize('value', [None, 'invalid', True, -1, 101, float('inf'), float('nan')])
def test_invalid_provider_percent_is_unknown(value):
    assert usage_cache.normalize_percent(value) is None


@pytest.mark.parametrize('window, expected', [
    ({}, ''),
    ({'used_percentage': 0}, '0%'),
    ({'used_percentage': 42}, '42%'),
    ({'used_percentage': float('inf')}, ''),
    ({'context_window_size': 100}, ''),
    ({'context_window_size': 100, 'current_usage': {}}, ''),
    ({'context_window_size': 100, 'current_usage': {'input_tokens': 0}}, '0%'),
    ({'context_window_size': 100, 'current_usage': {'input_tokens': 20, 'cache_read_input_tokens': 10}}, '30%'),
    ({'context_window_size': float('inf'), 'current_usage': {'input_tokens': 1}}, ''),
    ({'context_window_size': 10**400, 'current_usage': {'input_tokens': 1}}, ''),
    ({'context_window_size': 100, 'current_usage': {'input_tokens': 10**400}}, ''),
    ({'context_window_size': 1, 'current_usage': {'input_tokens': 10**308, 'cache_read_input_tokens': 10**308}}, ''),
    ({'context_window_size': 100.0, 'current_usage': {'input_tokens': 10**308, 'cache_read_input_tokens': 10**308}}, ''),
])
def test_context_distinguishes_zero_from_missing(window, expected):
    assert statusline.format_percent(statusline.get_context_percent({'context_window': window})) == expected


def test_zero_session_usage_is_not_invented_from_weekly_usage(tmp_path):
    data = usage_cache.usage_from_rate_limits({'rate_limits': {
        'five_hour': {'used_percentage': 0}, 'seven_day': {'used_percentage': 30}
    }})
    path = str(tmp_path / 'usage.json')
    assert usage_cache.save_usage_cache(path, {'claude': data}, now=100)
    assert usage_cache.get_fresh_provider(usage_cache.load_usage_cache(path), 'claude', 60, now=110)['session']['pct'] == 0


@pytest.mark.parametrize('memory', [None, 0, 42, 1.005])
def test_cloud_omits_unknown_context_but_keeps_measured_zero(memory):
    response = MagicMock()
    response.__enter__.return_value.status = 200
    payload = {'state': 'working', 'character': 'codex', 'project': 'fixture', 'memory': memory}
    with patch.object(vibemon_core, 'open_credential_request', return_value=response) as transport:
        assert vibemon_core.send_vibemon_api('https://web.example', 'fixture', payload)
    body = json.loads(transport.call_args.args[0].data)
    if memory is None:
        assert 'memory' not in body
    else:
        assert body['memory'] == memory


@pytest.mark.parametrize('value', [float('inf'), float('nan'), 'Infinity'])
def test_invalid_reset_epoch_is_not_cached(value):
    assert usage_cache.build_bucket({'utilization': 0, 'resets_at': value}, 'utilization') == {'pct': 0}


def test_reset_countdown_is_absent_without_provider_evidence():
    assert statusline.format_usage_reset({'session': {'pct': 20}}) == ''


@pytest.mark.parametrize('reset', [True, float('nan'), float('inf'), 10**400, 1e308])
def test_invalid_reset_metadata_does_not_drop_a_valid_usage_measurement(reset):
    assert vibemon_core._usage_fields({'session': {'pct': 1.005, 'resets_at': reset}}) == {'usage5h': 1.005}


@pytest.mark.parametrize('invalid', [True, '12.5', float('nan'), float('inf'), 101, -1])
def test_cached_percentages_use_the_same_strict_numeric_boundary_as_desktop(invalid):
    cache = {'claude': {'updated_at': 100, 'session': {'pct': invalid}, 'week_all': {'pct': 12.5}}}
    fresh = usage_cache.get_fresh_provider(cache, 'claude', 1800, now=100)
    assert 'session' not in fresh
    # Epoch 100 is when the provider entry was measured.
    assert vibemon_core._usage_fields(fresh) == {'usageWeek': 12.5, 'usageObservedAt': '1970-01-01T00:01:40.000Z'}


def test_percentage_cache_and_transport_keep_measured_precision():
    buckets = usage_cache.usage_from_rate_limits({'rate_limits': {
        'five_hour': {'used_percentage': 1.005}, 'seven_day': {'used_percentage': 12.3456}
    }})
    buckets.update({'week_first': {'pct': 22.1, 'label': 'First'}, 'week_second': {'pct': 22.4, 'label': 'Second'}})
    assert buckets['session']['pct'] == 1.005
    assert buckets['week_all']['pct'] == 12.3456
    assert vibemon_core._usage_fields(buckets) == {
        'usage5h': 1.005, 'usageWeek': 12.3456, 'usageWeekModel': 22.4, 'usageWeekModelLabel': 'Second'
    }


def test_terminal_percentages_follow_the_shared_measurement_cases():
    cases = json.loads((ROOT.parents[1] / 'src/shared/monitoring/cases.json').read_text())['measurements']
    for case in cases:
        value = case['value']
        if case['unit'] == '%' and isinstance(value, (int, float)) and 0 <= value <= 100:
            assert usage_cache.format_percent(value) == case['expected'] + '%'
    for invalid in [None, float('inf'), float('nan'), -1, 101]:
        assert statusline.build_progress_bar(invalid) == ''
    assert usage_cache.format_percent(-0.0) == '0%'


def test_codex_context_is_not_rounded_before_delivery(tmp_path):
    transcript = tmp_path / 'session.jsonl'
    transcript.write_text(json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
        'last_token_usage': {'total_tokens': 12345}, 'model_context_window': 100000
    }}}) + '\n')
    assert vibemon_core.get_codex_context_usage({'transcript_path': str(transcript)}) == 12.345


def test_statusline_caches_raw_context_instead_of_parsing_its_rounded_display():
    data = {'model': {'display_name': 'Fixture'}, 'workspace': {'current_dir': '/workspace/demo'}, 'context_window': {'used_percentage': 1.005}}
    with patch.object(statusline, 'read_input', return_value=json.dumps(data)), patch.object(statusline, 'get_git_info', return_value=''), \
         patch.object(statusline, 'load_usage_cache', return_value=None), patch.object(statusline, 'save_cache_background') as save:
        statusline.main()
    assert save.call_args.args[2] == 1.005
    assert statusline.format_percent(statusline.get_context_percent(data)) == '1.01%'
