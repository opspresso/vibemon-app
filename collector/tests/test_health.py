import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from fake_clock import FakeClock, run_host
from vibemon_collector.application import DeliveryFailure
from vibemon_collector.domain import Sample
from vibemon_collector.health import DeliveryHealth


class ReadinessTests(unittest.TestCase):
    def test_duplicate_acknowledgement_does_not_refresh_delivery_readiness(self):
        delivered = Mock()
        run_host(Mock(sample=lambda: Sample({'cpuPercent': 10})), lambda _: {'accepted': False, 'reason': 'duplicate_or_older'},
                 FakeClock(), once=True, on_delivery=delivered)
        delivered.assert_not_called()

    def test_only_acknowledged_delivery_becomes_ready_and_then_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            health = DeliveryHealth(Path(directory) / 'health')
            clock, attempts = FakeClock(), []
            def send(payload):
                self.assertFalse(health.ready(clock.now))
                attempts.append(payload)
                if len(attempts) == 1:
                    raise DeliveryFailure('Temporary failure', retryable=True)
                return {'accepted': True}
            with self.assertLogs(level='WARNING'):
                run_host(Mock(sample=lambda: Sample({'cpuPercent': 10})), send, clock, once=True, on_delivery=health.record)
            self.assertTrue(health.ready(clock.now))
            self.assertFalse(health.ready(clock.now + 120))
            self.assertFalse(health.ready(clock.now + 121))
            self.assertFalse(health.ready(clock.now - 1))
            if os.name == "posix":
                self.assertEqual(health.path.stat().st_mode & 0o777, 0o600)
            health.reset()
            self.assertFalse(health.ready(clock.now))

    def test_invalid_ack_and_invalid_files_cannot_report_ready(self):
        delivered = Mock()
        with self.assertRaises(DeliveryFailure):
            run_host(Mock(sample=lambda: Sample({'cpuPercent': 10})), lambda _: {}, FakeClock(), once=True, on_delivery=delivered)
        delivered.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            health = DeliveryHealth(Path(directory) / 'health')
            for content in ['nan', 'inf', '', 'not a timestamp']:
                health.path.write_text(content)
                self.assertFalse(health.ready(100))

    def test_unwritable_readiness_is_a_permanent_configuration_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            health = DeliveryHealth(Path(directory) / 'missing' / 'health')
            with self.assertRaises(DeliveryFailure) as error:
                health.record(100)
            self.assertFalse(error.exception.retryable)
