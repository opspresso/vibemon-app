"""Local host adapter; RAM is system memory, including Spark unified memory."""
import math
from pathlib import Path
import shutil
import subprocess
import psutil
from .domain import Sample
from .disk import DISK_METRICS, HOST_DEFINITIONS


def number(value: str, maximum: float) -> float | None:
    try:
        parsed = float(value.strip())
        return parsed if math.isfinite(parsed) and 0 <= parsed <= maximum else None
    except ValueError:
        return None


class HostSampler:
    def __init__(self, metrics, memory_type="auto"):
        self.metrics = metrics
        self.memory_type = memory_type
        self.metric_definitions = HOST_DEFINITIONS if set(metrics).intersection(DISK_METRICS) else None
        self.gpu_command = shutil.which("nvidia-smi")
        self.gpu_name = ""
        psutil.cpu_percent(interval=None)
        try:
            self.gpu_name = Path("/proc/device-tree/model").read_text().strip("\x00")
        except OSError:
            pass
        if self.gpu_command:
            try:
                self.gpu_name += subprocess.run([self.gpu_command, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=3, check=True).stdout
            except (OSError, subprocess.SubprocessError):
                pass
        if self.memory_type == 'auto':
            self.memory_type = 'unified' if any(name in self.gpu_name.lower() for name in ('spark', 'gb10')) else 'ram'
        if self.metric_definitions:
            self.metric_definitions = {**HOST_DEFINITIONS, 'memoryPercent': {**HOST_DEFINITIONS['memoryPercent'], 'label': 'Unified memory' if self.memory_type == 'unified' else 'Memory'}}

    def sample(self):
        values = {key: None for key in self.metrics}
        failed = False
        for key, read in [("cpuPercent", lambda: psutil.cpu_percent(interval=None)), ("memoryPercent", lambda: psutil.virtual_memory().percent)]:
            if key in values:
                try:
                    values[key] = number(str(read()), 100)
                except (OSError, RuntimeError):
                    failed = True
        if set(values).intersection(DISK_METRICS):
            try:
                disk = psutil.disk_usage('/')
                if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (disk.free, disk.total)) or not 0 <= disk.free <= disk.total or disk.total <= 0:
                    raise ValueError('Invalid filesystem capacity')
                disk_values = dict(zip(DISK_METRICS, (disk.free / 1024 ** 3, disk.total / 1024 ** 3, 100 * (1 - disk.free / disk.total))))
                values.update({key: value for key, value in disk_values.items() if key in values})
            except (OSError, ValueError):
                failed = True
        if self.gpu_command and any(key in values for key in ("gpuPercent", "gpuTemperatureC")):
            try:
                result = subprocess.run([self.gpu_command, "--query-gpu=utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3, check=True)
                devices = [line.split(",") for line in result.stdout.strip().splitlines()]
                for index, key, limit in [(0, "gpuPercent", 100), (1, "gpuTemperatureC", 150)]:
                    if key not in values:
                        continue
                    supported = [number(row[index], limit) for row in devices if len(row) == 2]
                    valid = [value for value in supported if value is not None]
                    # One host summary: busiest GPU and hottest GPU, not per-device series.
                    values[key] = max(valid) if valid else None
            except (OSError, subprocess.SubprocessError):
                failed = True
        health = "error" if failed else "ok" if any(value is not None for value in values.values()) else "unknown"
        return Sample(values, health, self.memory_type, self.metric_definitions)
