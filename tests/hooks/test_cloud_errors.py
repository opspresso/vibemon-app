"""Cloud failures stay observable even when local delivery succeeds."""
import io
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import pytest

import vibemon_core


@pytest.mark.parametrize('code, guidance', [(401, 'write token'), (403, 'write permission'), (429, 'rate limit'), (503, 'Web service')])
def test_cloud_http_errors_are_visible_without_debug_and_without_secrets(code, guidance, capsys):
    token = 'vm_' + 'a' * 60
    error = HTTPError('https://web.example/' + token, code, token, {}, io.BytesIO(token.encode()))
    with patch.object(vibemon_core, 'DEBUG', False), patch.object(vibemon_core, 'open_credential_request', side_effect=error):
        assert not vibemon_core.send_vibemon_api('https://web.example', token, {'project': 'fixture', 'character': 'codex'})
    output = capsys.readouterr()
    assert str(code) in output.err
    assert guidance in output.err
    assert token not in output.err + output.out
    assert error.fp.closed


def test_cloud_network_errors_do_not_interrupt_other_targets(capsys):
    config = vibemon_core.Config(('http://127.0.0.1:19280',), None, '', False, 'https://web.example', 'fixture-secret')
    with patch.object(vibemon_core, 'DEBUG', False), patch.object(vibemon_core, 'get_config', return_value=config), patch.object(vibemon_core, 'send_http_post', return_value=(True, None)) as local, patch.object(vibemon_core, 'open_credential_request', side_effect=URLError('fixture-secret')):
        vibemon_core.send_to_all({'project': 'fixture', 'character': 'codex'}, False)
    local.assert_called_once()
    output = capsys.readouterr()
    assert 'Web connection' in output.err
    assert 'fixture-secret' not in output.err + output.out
