import unittest
from vibemon_collector.kubernetes import KubernetesSampler, quantity
from vibemon_collector.domain import CLUSTER_METRICS

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

if __name__ == '__main__': unittest.main()
