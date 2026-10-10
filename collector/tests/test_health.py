from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from vibemon_collector.application import DeliveryFailure, run
from vibemon_collector.domain import Sample
from vibemon_collector.health import DeliveryHealth


class ReadinessTests(unittest.TestCase):
    def test_only_acknowledged_delivery_becomes_ready_and_then_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            health = DeliveryHealth(Path(directory) / 'health')
            clock, attempts = [0], []
            def send(payload):
                self.assertFalse(health.ready(clock[0]))
                attempts.append(payload)
                if len(attempts) == 1:
                    raise DeliveryFailure('Temporary failure', retryable=True)
                return {'accepted': True}
            with self.assertLogs(level='WARNING'):
                run(Mock(sample=lambda: Sample({'cpuPercent': 10})), send, 'host', 'host', 'Host', ['cpuPercent'], lambda: clock[0], lambda: clock[0], lambda delay: clock.__setitem__(0, clock[0] + delay), once=True, on_delivery=health.record)
            self.assertTrue(health.ready(clock[0]))
            self.assertFalse(health.ready(clock[0] + 121))
            self.assertFalse(health.ready(clock[0] - 1))
            self.assertEqual(health.path.stat().st_mode & 0o777, 0o600)
            health.reset()
            self.assertFalse(health.ready(clock[0]))

    def test_invalid_ack_and_invalid_files_cannot_report_ready(self):
        now = [0]
        delivered = Mock()
        with self.assertRaises(DeliveryFailure):
            run(Mock(sample=lambda: Sample({'cpuPercent': 10})), lambda _: {}, 'host', 'host', 'Host', ['cpuPercent'], lambda: now[0], lambda: now[0], lambda delay: now.__setitem__(0, now[0] + delay), once=True, on_delivery=delivered)
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
