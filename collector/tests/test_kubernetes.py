import time
import unittest
from copy import deepcopy
from threading import Event
from unittest.mock import patch

from vibemon_collector.disk import DISK_METRICS
from vibemon_collector.domain import CLUSTER_METRICS, summarize
from vibemon_collector.kubernetes import KubernetesSampler, quantity

class Reader:
    def __init__(self):
        self.nodes = [['one', '2', '1Gi', 'True'], ['two', '6', '3Gi', 'False']]
        self.usage = {'items': [
            {'metadata': {'name': 'one'}, 'timestamp': '1970-01-01T00:16:40Z', 'usage': {'cpu': '500000000n', 'memory': '512Mi'}},
            {'metadata': {'name': 'two'}, 'timestamp': '1970-01-01T00:16:40Z', 'usage': {'cpu': '1500m', 'memory': '512Mi'}},
        ]}
        self.pods = [['Running', 'True'], ['Running', 'False'], ['Pending', ''], ['Failed', ''], ['Succeeded', 'False']]
    def read(self, kind): return getattr(self, kind)

class KubernetesTests(unittest.TestCase):
    def sample(self, reader): return KubernetesSampler(reader, CLUSTER_METRICS, lambda: 1000).sample()
    def test_capacity_weighting_and_unhealthy_pods_exclude_completed_jobs(self):
        result = self.sample(Reader())
        self.assertEqual(result.metrics, {'cpuPercent': 25, 'memoryPercent': 25, 'nodesReady': 1, 'nodesTotal': 2, 'podsUnhealthy': 3})
        self.assertEqual(result.health, 'warning')
    def test_missing_usage_does_not_report_partial_cluster_utilization(self):
        reader = Reader(); reader.usage['items'].pop()
        result = self.sample(reader)
        self.assertIsNone(result.metrics['cpuPercent']); self.assertIsNone(result.metrics['memoryPercent'])
        self.assertEqual(result.metrics['nodesTotal'], 2); self.assertEqual(result.health, 'error')
    def test_stale_or_future_usage_is_unknown(self):
        for timestamp in ['1970-01-01T00:00:00Z', '1970-01-01T01:00:00Z']:
            reader = Reader(); reader.usage['items'][0]['timestamp'] = timestamp
            self.assertIsNone(self.sample(reader).metrics['cpuPercent'])
    def test_invalid_memory_does_not_hide_valid_cpu(self):
        reader = Reader(); reader.usage['items'][0]['usage']['memory'] = 'NaN'
        result = self.sample(reader)
        self.assertEqual(result.metrics['cpuPercent'], 25); self.assertIsNone(result.metrics['memoryPercent'])
    def test_genuine_zero_usage_and_zero_unhealthy_remain_zero(self):
        reader = Reader(); reader.pods = [['Succeeded', 'False'], ['Running', 'True']]
        for item in reader.usage['items']: item['usage']['cpu'] = '0'
        result = self.sample(reader)
        self.assertEqual(result.metrics['cpuPercent'], 0); self.assertEqual(result.metrics['podsUnhealthy'], 0)
    def test_quantities(self):
        for value, expected in [('250m', .25), ('1Gi', 1073741824), ('1e3', 1000), ('5M', 5000000), ('0', 0)]: self.assertEqual(quantity(value), expected)
        for value in ['NaN', '-1', 'inf', '1unknown', '1e999']:
            with self.assertRaises(ValueError): quantity(value)
    def test_api_failure_is_unknown_not_healthy(self):
        class Failed:
            def read(self, kind): raise OSError('unavailable')
        result = self.sample(Failed())
        self.assertTrue(all(value is None for value in result.metrics.values())); self.assertEqual(result.health, 'error')

class DiskTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader()
        self.reader.endpoints = [['one', '10.0.0.1', '10250'], ['two', '10.0.0.2', '10250']]
        self.responses = {
            address: {'node': {'nodeName': name, 'fs': {'time': '1970-01-01T00:16:40Z', 'availableBytes': free * 1024 ** 3, 'capacityBytes': total * 1024 ** 3}}}
            for name, address, free, total in [('one', '10.0.0.1', 10, 20), ('two', '10.0.0.2', 30, 80)]
        }

    def read(self, address, port):
        self.assertEqual(port, '10250')
        return self.responses[address]

    def sample(self):
        return KubernetesSampler(self.reader, CLUSTER_METRICS + DISK_METRICS, lambda: 1000, self).sample()

    def test_capacity_weighted_root_disks(self):
        sample = self.sample()
        self.assertEqual({key: sample.metrics[key] for key in DISK_METRICS}, {'diskAvailableGiB': 40, 'diskTotalGiB': 100, 'diskUsedPercent': 60})
        self.assertEqual(sample.metrics['cpuPercent'], 25)

    def test_full_disk_is_zero_available(self):
        for response in self.responses.values(): response['node']['fs']['availableBytes'] = 0
        sample = self.sample()
        self.assertEqual(sample.metrics['diskAvailableGiB'], 0)
        self.assertEqual(sample.metrics['diskUsedPercent'], 100)

    def test_partial_stale_or_invalid_disk_does_not_hide_cpu_or_report_partial_totals(self):
        original = deepcopy(self.responses)
        cases = [{'time': '1970-01-01T00:00:00Z'}, {'time': '1970-01-01T01:00:00Z'}, {'time': '1970-01-01T00:16:40'}, {'capacityBytes': 0}, {'availableBytes': -1}, {'availableBytes': float('nan')}, {'availableBytes': True}, {'availableBytes': 100 * 1024 ** 3}, {'availableBytes': None}]
        for change in cases:
            with self.subTest(change=change):
                self.responses = deepcopy(original)
                self.responses['10.0.0.2']['node']['fs'].update(change)
                sample = self.sample()
                self.assertTrue(all(sample.metrics[key] is None for key in DISK_METRICS))
                self.assertEqual(sample.metrics['cpuPercent'], 25)
                self.assertEqual(sample.health, 'error')

    def test_missing_endpoint_or_failed_request_is_unavailable(self):
        self.reader.endpoints.pop()
        self.assertIsNone(self.sample().metrics['diskAvailableGiB'])
        self.reader.endpoints = [['one', '10.0.0.1', '10250'], ['two', '10.0.0.2', '10250']]
        del self.responses['10.0.0.2']
        self.assertIsNone(self.sample().metrics['diskAvailableGiB'])

    def test_wrong_node_is_rejected(self):
        self.responses['10.0.0.2']['node']['nodeName'] = 'other'
        self.assertIsNone(self.sample().metrics['diskAvailableGiB'])

    def test_unselected_disk_does_not_query_kubelet(self):
        def fail(*_args): raise AssertionError('Unexpected kubelet request')
        self.read = fail
        self.assertEqual(KubernetesSampler(self.reader, CLUSTER_METRICS, lambda: 1000, self).sample().health, 'warning')

    def test_summary_carries_display_definitions_for_existing_clients(self):
        sample = self.sample()
        summary = summarize([sample] * 3, 'k3s', 'cluster', 'K3S', 1000)
        self.assertEqual(summary['kind'], 'cluster')
        self.assertEqual(summary['resourceType'], 'Kubernetes')
        self.assertEqual(summary['metricDefinitions']['diskAvailableGiB']['unit'], 'GiB')
        self.assertEqual(summary['metricOrder'][2], 'diskAvailableGiB')
        self.assertEqual(summary['metrics']['diskAvailableGiB'], 40)

    def test_slow_node_batches_do_not_block_other_metrics_or_grow_worker_pool(self):
        release = Event()
        self.reader.nodes = [[str(i), '2', '1Gi', 'True'] for i in range(20)]
        self.reader.endpoints = [[str(i), f'10.0.0.{i + 1}', '10250'] for i in range(20)]
        self.reader.usage['items'] = [{'metadata': {'name': str(i)}, 'timestamp': '1970-01-01T00:16:40Z', 'usage': {'cpu': '500m', 'memory': '256Mi'}} for i in range(20)]
        def stalled(_address, _port):
            release.wait(2)
            raise OSError('timeout')
        self.read = stalled
        sampler = KubernetesSampler(self.reader, CLUSTER_METRICS + DISK_METRICS, lambda: 1000, self)
        try:
            with patch('vibemon_collector.kubernetes.DISK_QUERY_TIMEOUT', 0.02):
                for _ in range(2):
                    started = time.monotonic()
                    sample = sampler.sample()
                    self.assertLess(time.monotonic() - started, 0.5)
                    self.assertEqual(sample.metrics['cpuPercent'], 25)
                    self.assertEqual(sample.metrics['podsUnhealthy'], 3)
                    self.assertTrue(all(sample.metrics[key] is None for key in DISK_METRICS))
                self.assertLessEqual(len(sampler.disk_executor._threads), 8)
        finally:
            release.set()
            sampler.disk_executor.shutdown(wait=True, cancel_futures=True)
