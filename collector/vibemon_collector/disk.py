"""Display definitions for optional root-filesystem measurements."""
DISK_METRICS = ('diskAvailableGiB', 'diskTotalGiB', 'diskUsedPercent')
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
