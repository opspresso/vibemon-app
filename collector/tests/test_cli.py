"""Reject unusable configuration before starting collectors or network clients."""
from unittest.mock import patch

import pytest
from vibemon_collector.__main__ import main


@pytest.mark.parametrize('name', ['Host\nOne', 'Host\x00One', 'Host\x7fOne', 'Host\ud800',
    'Host\udfff', '😀' * 65, ' ' + 'A' * 128 + ' ', ' \ufeff \ufeff '])
def test_invalid_name_stops_before_sampling_or_delivery(name, monkeypatch, capsys):
    monkeypatch.setattr('sys.argv', ['vibemon-collector', '--source-id', 'fixture', '--name', name,
                                   '--url', 'https://example.invalid'])
    monkeypatch.setenv('VIBEMON_WRITE_TOKEN', 'vm_' + '0' * 60)
    with (patch('vibemon_collector.host.HostSampler') as sampler,
          patch('vibemon_collector.__main__.JsonClient') as client,
          patch('vibemon_collector.__main__.run') as run):
        with pytest.raises(SystemExit) as failure:
            main()
        assert failure.value.code == 2
        assert 'Invalid source ID or display name' in capsys.readouterr().err
        sampler.assert_not_called()
        client.assert_not_called()
        run.assert_not_called()


@pytest.mark.parametrize('name', ['서버 東京', 'A' * 128, '😀' * 64, 'A' * 126 + '😀', ' Host '])
def test_valid_name_reaches_delivery_unchanged(name, monkeypatch):
    monkeypatch.setattr('sys.argv', ['vibemon-collector', '--source-id', 'fixture', '--name', name,
                                   '--url', 'https://example.invalid'])
    monkeypatch.setenv('VIBEMON_WRITE_TOKEN', 'vm_' + '0' * 60)
    with patch('vibemon_collector.host.HostSampler'), patch('vibemon_collector.__main__.run') as run:
        main()
        assert run.call_args.args[4] == name
