"""Unknown values must survive provider parsing and cloud serialization."""
import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

ROOT = Path(__file__).parents[2] / 'public' / 'install'
sys.path.insert(0, str(ROOT / 'vibemon'))
sys.path.insert(0, str(ROOT / 'claude'))
import statusline
import usage_cache
import vibemon_core


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
])
def test_context_distinguishes_zero_from_missing(window, expected):
    assert statusline.get_context_usage({'context_window': window}) == expected


def test_zero_session_usage_is_not_invented_from_weekly_usage(tmp_path):
    data = usage_cache.usage_from_rate_limits({'rate_limits': {
        'five_hour': {'used_percentage': 0}, 'seven_day': {'used_percentage': 30}
    }})
    path = str(tmp_path / 'usage.json')
    assert usage_cache.save_usage_cache(path, {'claude': data}, now=100)
    assert usage_cache.get_fresh_provider(usage_cache.load_usage_cache(path), 'claude', 60, now=110)['session']['pct'] == 0


@pytest.mark.parametrize('memory', [None, 0, 42])
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
