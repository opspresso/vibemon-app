"""Root-filesystem measurements: validation, units, and display definitions."""
import math

DISK_METRICS = ('diskAvailableGiB', 'diskTotalGiB', 'diskUsedPercent')


def checked_capacity(available, capacity):
    """Return the byte counts, or raise ValueError when they cannot describe one filesystem."""
    try:
        valid = all(not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) for value in (available, capacity))
    except OverflowError:
        valid = False
    if not valid or not 0 <= available <= capacity or capacity <= 0:
        raise ValueError('Invalid filesystem capacity')
    return available, capacity


def disk_values(available, capacity):
    """Available and total GiB, and the used percentage including reserved space."""
    return dict(zip(DISK_METRICS, (available / 1024 ** 3, capacity / 1024 ** 3, 100 * (1 - available / capacity))))
CLUSTER_DEFINITIONS = {
    'cpuPercent': {'label': 'CPU', 'unit': '%', 'display': 'gauge', 'min': 0, 'max': 100},
    'memoryPercent': {'label': 'Memory', 'unit': '%', 'display': 'gauge', 'min': 0, 'max': 100},
    'diskAvailableGiB': {'label': 'Disk available', 'unit': 'GiB', 'display': 'number', 'min': 0},
    'diskTotalGiB': {'label': 'Disk total', 'unit': 'GiB', 'display': 'number', 'min': 0},
    'diskUsedPercent': {'label': 'Disk used', 'unit': '%', 'display': 'gauge', 'min': 0, 'max': 100},
    'nodesReady': {'label': 'Ready nodes', 'unit': '', 'display': 'number', 'min': 0, 'max': 1000000},
    'nodesTotal': {'label': 'Total nodes', 'unit': '', 'display': 'number', 'min': 0, 'max': 1000000},
    'podsUnhealthy': {'label': 'Unhealthy pods', 'unit': '', 'display': 'number', 'min': 0, 'max': 1000000},
}

HOST_DEFINITIONS = {
    **{key: CLUSTER_DEFINITIONS[key] for key in ('cpuPercent', 'memoryPercent', *DISK_METRICS)},
    'gpuPercent': {'label': 'GPU', 'unit': '%', 'display': 'gauge', 'min': 0, 'max': 100},
    'gpuTemperatureC': {'label': 'GPU temperature', 'unit': '°C', 'display': 'number', 'min': 0, 'max': 150},
}
