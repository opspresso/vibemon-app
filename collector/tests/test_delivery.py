import io
import os
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from fake_clock import FakeClock, run_host
from vibemon_collector.application import DeliveryFailure
from vibemon_collector.domain import Sample
from vibemon_collector.transport import JsonClient, checked_url
from vibemon_collector import __main__ as cli


class DeliveryTests(unittest.TestCase):
    def test_cli_returns_configuration_exit_code_for_permanent_rejections(self):
        with patch('sys.argv', ['vibemon-collector', '--source-id', 'host', '--name', 'Host', '--url', 'https://web.example', '--once']), patch.dict(os.environ, {'VIBEMON_WRITE_TOKEN': 'vm_' + 'a' * 60}), patch('vibemon_collector.host.HostSampler'), patch.object(cli, 'run', side_effect=DeliveryFailure('Web returned HTTP 401', retryable=False)), self.assertLogs(level='ERROR'), self.assertRaises(SystemExit) as exit_status:
            cli.main()
        self.assertEqual(exit_status.exception.code, 2)

    def client(self, status, headers=None):
        secret = 'vm_' + 'a' * 60
        client = JsonClient(secret)
        failure = HTTPError('https://web.example/api/v1/ingest', status, secret, headers or {}, io.BytesIO(secret.encode()))
        client.opener.open = Mock(side_effect=failure)
        return client, secret

    def test_permanent_rejections_stop_after_one_delivery_without_exposing_credentials(self):
        for status in [301, 400, 401, 403, 404, 409, 413, 422, 501]:
            with self.subTest(status=status):
                client, secret = self.client(status)
                sampler = Mock(sample=lambda: Sample({'cpuPercent': 20}))
                with self.assertRaises(DeliveryFailure) as failure:
                    # Bind this iteration's client explicitly.
                    run_host(sampler, lambda payload, client=client: client.request('https://web.example/api/v1/ingest', payload), FakeClock(), once=True)
                self.assertFalse(failure.exception.retryable)
                self.assertIn(str(status), str(failure.exception))
                self.assertNotIn(secret, str(failure.exception))
                self.assertEqual(client.opener.open.call_count, 1)

    def test_retry_after_keeps_sampling_and_sends_the_newest_window(self):
        client, _ = self.client(429, {'Retry-After': '60'})
        clock, sent = FakeClock(), []
        sampler = Mock(sample=lambda: Sample({'cpuPercent': clock.now}))
        def sender(payload):
            sent.append(payload)
            if len(sent) == 1:
                return client.request('https://web.example/api/v1/ingest', payload)
            return {'accepted': True}
        run_host(sampler, sender, clock, once=True)
        self.assertEqual(clock.now, 90)
        self.assertEqual(sent[-1]['metrics']['cpuPercent'], 80)

    def test_temporary_http_failures_remain_retryable(self):
        for status in [408, 425, 429, 500, 502, 503, 504]:
            with self.subTest(status=status):
                client, _ = self.client(status)
                with self.assertRaises(DeliveryFailure) as failure:
                    client.request('https://web.example/api/v1/ingest', {})
                self.assertTrue(failure.exception.retryable)

    def test_invalid_acknowledgement_does_not_retry_forever(self):
        clock = FakeClock()
        with self.assertRaisesRegex(DeliveryFailure, 'acknowledgement'):
            run_host(Mock(sample=lambda: Sample({'cpuPercent': 20})), lambda _: {}, clock, once=True)
        self.assertEqual(clock.now, 30)

    def test_web_origin_rejects_paths_but_prometheus_may_have_a_prefix(self):
        with self.assertRaises(ValueError): checked_url('https://web.example/dashboard', origin_only=True)
        self.assertEqual(checked_url('https://prometheus.example/prefix'), 'https://prometheus.example/prefix')
        with self.assertRaises(ValueError): checked_url('https://web.example:99999')
