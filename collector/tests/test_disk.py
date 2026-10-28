import unittest
from types import SimpleNamespace
from unittest.mock import patch

from vibemon_collector.disk import DISK_METRICS
from vibemon_collector.domain import HOST_METRICS, Sample, summarize
from vibemon_collector.host import HostSampler


class HostDiskTests(unittest.TestCase):
    def sampler(self, metrics=HOST_METRICS + DISK_METRICS):
        with patch('vibemon_collector.host.shutil.which', return_value=None), patch('vibemon_collector.host.psutil.cpu_percent'):
            return HostSampler(metrics, 'unified')

    def test_spark_disk_and_unified_memory_are_independent(self):
        sampler = self.sampler()
        with patch('vibemon_collector.host.psutil.disk_usage', return_value=SimpleNamespace(free=512 * 1024 ** 3, total=2048 * 1024 ** 3)) as disk, patch('vibemon_collector.host.psutil.cpu_percent', return_value=20), patch('vibemon_collector.host.psutil.virtual_memory', return_value=SimpleNamespace(percent=40)):
            sample = sampler.sample()
        disk.assert_called_once_with('/')
        self.assertEqual(sample.metrics['diskAvailableGiB'], 512)
        self.assertEqual(sample.metrics['diskTotalGiB'], 2048)
        self.assertEqual(sample.metrics['diskUsedPercent'], 75)
        self.assertEqual(sample.metrics['memoryPercent'], 40)
        summary = summarize([sample] * 3, 'spark', 'host', 'Spark', 1000)
        self.assertEqual(summary['resourceType'], 'DGX Spark')
        self.assertEqual(summary['metricDefinitions']['memoryPercent']['label'], 'Unified memory')
        # DGX Spark shows GPU and unified memory first.
        self.assertEqual(summary['metricOrder'], ['gpuPercent', 'memoryPercent', 'cpuPercent', 'diskUsedPercent', 'diskAvailableGiB', 'diskTotalGiB', 'gpuTemperatureC'])

    def test_a_host_without_unified_memory_keeps_cpu_and_memory_first(self):
        with patch('vibemon_collector.host.shutil.which', return_value=None), patch('vibemon_collector.host.psutil.cpu_percent'):
            sampler = HostSampler(HOST_METRICS + DISK_METRICS, 'ram')
        self.assertEqual(list(sampler.metric_definitions), ['cpuPercent', 'memoryPercent', 'diskUsedPercent', 'diskAvailableGiB', 'diskTotalGiB', 'gpuPercent', 'gpuTemperatureC'])
        self.assertEqual(sampler.metric_definitions['memoryPercent']['label'], 'Memory')

    def test_a_host_reports_its_platform_as_the_resource_type(self):
        for system, expected in [('Darwin', 'macOS'), ('Linux', 'Linux'), ('', 'Server')]:
            with self.subTest(system=system), patch('vibemon_collector.host.platform.system', return_value=system), patch('vibemon_collector.host.shutil.which', return_value=None), patch('vibemon_collector.host.psutil.cpu_percent'):
                sampler = HostSampler(HOST_METRICS + DISK_METRICS, 'ram')
                summary = summarize([Sample({'cpuPercent': 10}, metric_definitions=sampler.metric_definitions, resource_type=sampler.resource_type)], 'mac', 'host', 'Mac', 1000)
                self.assertEqual(summary['resourceType'], expected)

    def test_full_disk_is_zero_but_failure_and_invalid_capacity_are_unavailable(self):
        sampler = self.sampler()
        for disk in [SimpleNamespace(free=0, total=100), OSError('unavailable'), SimpleNamespace(free=0, total=0), SimpleNamespace(free=-1, total=100), SimpleNamespace(free=101, total=100), SimpleNamespace(free=float('nan'), total=100)]:
            with self.subTest(disk=disk), patch('vibemon_collector.host.psutil.disk_usage', side_effect=disk if isinstance(disk, Exception) else None, return_value=disk), patch('vibemon_collector.host.psutil.cpu_percent', return_value=20):
                sample = sampler.sample()
                self.assertEqual(sample.metrics['cpuPercent'], 20)
                if not isinstance(disk, Exception) and disk.free == 0 and disk.total > 0:
                    self.assertEqual(sample.metrics['diskAvailableGiB'], 0)
                    self.assertEqual(sample.metrics['diskUsedPercent'], 100)
                else:
                    self.assertTrue(all(sample.metrics[key] is None for key in DISK_METRICS))
                    self.assertEqual(sample.health, 'error')

    def test_default_host_payload_and_permissions_are_unchanged(self):
        sampler = self.sampler(HOST_METRICS)
        with patch('vibemon_collector.host.psutil.disk_usage') as disk:
            sample = sampler.sample()
        disk.assert_not_called()
        self.assertNotIn('metricDefinitions', summarize([sample] * 3, 'host', 'host', 'Host', 1000))

    def test_unrepresentable_disk_counts_do_not_drop_valid_cpu_and_memory(self):
        sampler = self.sampler()
        for disk in [SimpleNamespace(free=10 ** 400, total=10 ** 401), SimpleNamespace(free=10, total=10 ** 400)]:
            with self.subTest(disk=disk), patch('vibemon_collector.host.psutil.disk_usage', return_value=disk), patch('vibemon_collector.host.psutil.cpu_percent', return_value=20), patch('vibemon_collector.host.psutil.virtual_memory', return_value=SimpleNamespace(percent=40)):
                sample = sampler.sample()
                self.assertEqual(sample.metrics['cpuPercent'], 20)
                self.assertEqual(sample.metrics['memoryPercent'], 40)
                self.assertTrue(all(sample.metrics[key] is None for key in DISK_METRICS))
                self.assertEqual(sample.health, 'error')
