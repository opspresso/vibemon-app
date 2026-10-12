import unittest
from unittest.mock import patch
from vibemon_collector.domain import Sample, TransmissionPolicy, summarize
from vibemon_collector.application import run
from vibemon_collector.host import HostSampler
from vibemon_collector.prometheus import PrometheusSampler, scalar_summary
from vibemon_collector.transport import checked_url


class PolicyTests(unittest.TestCase):
    def window(self, policy, value, wall=30, health="ok"):
        for _ in range(3):
            policy.observe(Sample({"cpuPercent": value}, health), "host-1", "host", "Host", wall)

    def test_threshold_is_relative_to_last_transmitted_mean(self):
        policy = TransmissionPolicy()
        self.window(policy, 20)
        first = policy.next_payload(30)
        self.assertFalse(first["heartbeat"])
        policy.succeeded(first, 30)
        self.window(policy, 21.9, 60)
        self.assertIsNone(policy.next_payload(60))
        self.window(policy, 22, 90)
        self.assertFalse(policy.next_payload(90)["heartbeat"])

    def test_heartbeat_and_failure_transition(self):
        policy = TransmissionPolicy()
        self.window(policy, 20)
        policy.succeeded(policy.next_payload(30), 30)
        self.window(policy, 20, 60)
        self.assertIsNone(policy.next_payload(60))
        self.window(policy, 20, 90)
        heartbeat = policy.next_payload(90)
        self.assertTrue(heartbeat["heartbeat"])
        policy.succeeded(heartbeat, 90)
        self.window(policy, None, 120, "error")
        self.assertFalse(policy.next_payload(120)["heartbeat"])
        self.assertIsNone(policy.next_payload(120)["metrics"]["cpuPercent"])

    def test_outage_is_bounded_and_recovery_sends_only_newest_window(self):
        policy = TransmissionPolicy()
        for window in range(1000):
            self.window(policy, window % 100, 30 * (window + 1))
            self.assertLessEqual(len(policy.samples), 3)
            payload = policy.next_payload(30 * (window + 1))
            if payload:
                policy.failed(30 * (window + 1))
            self.assertLessEqual(policy.retry_at - 30 * (window + 1), 60)
        self.window(policy, 99, 40_000)
        recovered = policy.next_payload(40_000)
        self.assertEqual(recovered["metrics"]["cpuPercent"], 99)
        self.assertIn("11:06:40", recovered["observedAt"])
        policy.succeeded(recovered, 40_000)
        self.assertEqual(policy.failures, 0)
        self.assertIsNone(policy.pending)

    def test_summary_keeps_average_maximum_and_missing_separate(self):
        summary = summarize([Sample({"cpuPercent": 10, "memoryPercent": 20}), Sample({"cpuPercent": 40, "memoryPercent": None}), Sample({"cpuPercent": 10, "memoryPercent": None}, "error")], "host", "host", "Host", 30)
        self.assertEqual(summary["metrics"]["cpuPercent"], 20)
        self.assertEqual(summary["maximums"]["cpuPercent"], 40)
        self.assertIsNone(summary["metrics"]["memoryPercent"])
        self.assertEqual(summary["health"], "error")

    def test_adapter_latency_does_not_stretch_ten_second_cadence(self):
        now, observations = [0], []
        class Sampler:
            def sample(self):
                observations.append(now[0])
                now[0] += 2
                return Sample({"cpuPercent": 20})
        run(Sampler(), lambda payload: {"accepted": True}, "host", "host", "Host", ["cpuPercent"], lambda: now[0], lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds), once=True)
        self.assertEqual(observations, [10, 20, 30])

    def test_sender_latency_does_not_delay_the_sixty_second_heartbeat(self):
        now, sent = [0], []
        class Sampler:
            def sample(self): return Sample({"cpuPercent": 20})
        def wait(seconds):
            now[0] += seconds
            if now[0] >= 95: raise StopIteration()
        def sender(payload):
            sent.append(now[0])
            now[0] += .5
            return {"accepted": True}
        with self.assertRaises(StopIteration):
            run(Sampler(), sender, "host", "host", "Host", ["cpuPercent"], lambda: now[0], lambda: now[0], wait)
        self.assertEqual(sent, [30, 90])

    def test_sampler_jitter_cannot_skip_a_due_heartbeat(self):
        now, sent, count = [0], [], [0]
        class Sampler:
            def sample(self):
                count[0] += 1
                now[0] += .5 if count[0] == 3 else .05
                return Sample({"cpuPercent": 20})
        def wait(seconds):
            now[0] += seconds
            if now[0] >= 95: raise StopIteration()
        def sender(payload):
            sent.append(now[0]); return {"accepted": True}
        with self.assertRaises(StopIteration):
            run(Sampler(), sender, "host", "host", "Host", ["cpuPercent"], lambda: now[0], lambda: now[0], wait)
        self.assertEqual(sent, [30.5, 90.05])

    def test_collection_and_transmission_failures_do_not_stop_loop(self):
        now = [0]
        sent = []
        class Sampler:
            def sample(self):
                if now[0] <= 30:
                    raise OSError("offline")
                return Sample({"cpuPercent": now[0]})
        def sender(payload):
            sent.append(payload)
            if len(sent) == 1:
                raise OSError("disconnected")
            return {"accepted": True}
        run(Sampler(), sender, "host", "host", "Host", ["cpuPercent"], lambda: now[0], lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds), once=True)
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0]["health"], "error")
        self.assertEqual(sent[1]["metrics"]["cpuPercent"], 50)
        self.assertEqual(now[0], 60)


class AdapterTests(unittest.TestCase):
    def test_rejects_insecure_remote_or_credential_urls(self):
        for url in ["http://example.com", "https://user:secret@example.com", "https://example.com/#secret"]:
            with self.assertRaises(ValueError): checked_url(url, True)
        self.assertEqual(checked_url("http://127.0.0.1:3000", True), "http://127.0.0.1:3000")

    def test_missing_and_nonfinite_prometheus_are_unknown(self):
        self.assertIsNone(scalar_summary({"status": "success", "data": {"resultType": "vector", "result": []}}, 100))
        for value in ["NaN", "+Inf", "-1"]:
            self.assertIsNone(scalar_summary({"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [100, value]}]}}, 100))
        with self.assertRaises(ValueError):
            scalar_summary({"status": "success", "data": {"resultType": "vector", "result": [{"metric": {"pod": "sensitive"}, "value": [100, "5"]}]}}, 100)

    def test_malformed_query_keeps_other_metrics_and_invalid_time_is_unknown(self):
        for timestamp in ['NaN', '+Inf', 0]:
            self.assertIsNone(scalar_summary({"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [timestamp, "5"]}]}}, 1000))
        class Client:
            def request(self, url):
                if 'node_cpu' in url:
                    return []
                return {"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1000, "25"]}]}}
        sample = PrometheusSampler('https://prometheus', Client(), ['cpuPercent', 'memoryPercent'], lambda: 1000).sample()
        self.assertEqual(sample.metrics, {'cpuPercent': None, 'memoryPercent': 25})
        self.assertEqual(sample.health, 'error')

    def test_prometheus_errors_do_not_become_zero(self):
        class Client:
            def request(self, url): raise OSError("unavailable")
        sample = PrometheusSampler("https://prometheus", Client(), ["cpuPercent", "podsUnhealthy"], lambda: 100).sample()
        self.assertEqual(sample.metrics, {"cpuPercent": None, "podsUnhealthy": None})
        self.assertEqual(sample.health, "error")

    def test_spark_reports_unified_memory_and_unsupported_gpu_as_null(self):
        sampler = HostSampler.__new__(HostSampler)
        sampler.metrics = ["memoryPercent", "gpuPercent", "gpuTemperatureC"]
        sampler.gpu_command = "/usr/bin/nvidia-smi"
        sampler.gpu_name = "NVIDIA GB10"
        sampler.memory_type = "auto"
        sampler.metric_definitions = None
        with patch("vibemon_collector.host.psutil.virtual_memory") as memory, patch("vibemon_collector.host.subprocess.run") as command:
            memory.return_value.percent = 42
            command.return_value.stdout = "[N/A], 48\n"
            sample = sampler.sample()
        self.assertEqual(sample.memory_type, "unified")
        self.assertEqual(sample.metrics, {"memoryPercent": 42, "gpuPercent": None, "gpuTemperatureC": 48})
        self.assertEqual(sample.health, "ok")


if __name__ == "__main__": unittest.main()
