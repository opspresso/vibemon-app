"""Read-only Metrics API adapter for clusters without Prometheus."""
import json
import math
import re
import subprocess
from datetime import datetime
from decimal import Decimal, InvalidOperation
from .domain import Sample

# Output only capacity/readiness fields; pod specs, environment and logs are not read into Python.
NODE_FIELDS = '{range .items[*]}{.metadata.name}{"\\t"}{.status.capacity.cpu}{"\\t"}{.status.capacity.memory}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'
POD_FIELDS = '{range .items[*]}{.status.phase}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'
SCALES = {'n': 1e-9, 'u': 1e-6, 'm': 1e-3, '': 1, **{unit: 1000 ** (index + 1) for index, unit in enumerate('kMGTPE')}, **{unit + 'i': 1024 ** (index + 1) for index, unit in enumerate('KMGTPE')}}
SCALES['K'] = 1000

def quantity(value):
    match = re.fullmatch(r'([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)', str(value))
    if not match or match[2] not in SCALES:
        raise ValueError('Invalid resource quantity')
    try:
        number = float(Decimal(match[1]) * Decimal(str(SCALES[match[2]])))
    except (InvalidOperation, OverflowError) as error:
        raise ValueError('Invalid resource quantity') from error
    if not math.isfinite(number) or number < 0:
        raise ValueError('Invalid resource quantity')
    return number

class KubectlReader:
    def __init__(self, command):
        if not command: raise ValueError('A kubectl command is required')
        self.command = command

    def read(self, kind):
        arguments = {
            'nodes': ['get', 'nodes', '-o', f'jsonpath={NODE_FIELDS}'],
            'pods': ['get', 'pods', '-A', '-o', f'jsonpath={POD_FIELDS}'],
            'usage': ['get', '--raw', '/apis/metrics.k8s.io/v1beta1/nodes'],
        }[kind]
        # A request-timeout override prevents kubectl's default-config check from
        # selecting the mounted service account. Bound the whole process instead.
        result = subprocess.run([*self.command, *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8, check=False, text=True)
        if result.returncode or len(result.stdout.encode()) > 1024 * 1024:
            raise ValueError('Kubernetes summary query failed')
        return json.loads(result.stdout) if kind == 'usage' else [line.split('\t') for line in result.stdout.splitlines() if line]

class KubernetesSampler:
    def __init__(self, reader, metrics, clock):
        self.reader, self.metrics, self.clock = reader, metrics, clock

    def sample(self):
        values = {key: None for key in self.metrics}
        failed = False
        nodes = None
        if set(self.metrics) - {'podsUnhealthy'}:
            try:
                rows = self.reader.read('nodes')
                if any(len(row) != 4 or not row[0] for row in rows): raise ValueError('Invalid node summary')
                nodes = {row[0]: row for row in rows}
                if len(nodes) != len(rows): raise ValueError('Duplicate node summary')
                if 'nodesReady' in values: values['nodesReady'] = sum(row[3] == 'True' for row in rows)
                if 'nodesTotal' in values: values['nodesTotal'] = len(rows)
            except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
                failed = True
        usage_keys = [key for key in ('cpuPercent', 'memoryPercent') if key in values]
        if usage_keys and nodes:
            try:
                response = self.reader.read('usage')
                entries = response['items']
                usage = {entry['metadata']['name']: entry for entry in entries}
                if len(usage) != len(entries) or not set(nodes).issubset(usage): raise ValueError('Incomplete node usage')
                for name in nodes:
                    observed = datetime.fromisoformat(usage[name]['timestamp'].replace('Z', '+00:00')).timestamp()
                    if not -30 <= self.clock() - observed <= 120: raise ValueError('Stale node usage')
                for metric in usage_keys:
                    field, column = ('cpu', 1) if metric == 'cpuPercent' else ('memory', 2)
                    try:
                        capacity = sum(quantity(row[column]) for row in nodes.values())
                        used = sum(quantity(usage[name]['usage'][field]) for name in nodes)
                        percent = 100 * used / capacity
                        if not 0 <= percent <= 100: raise ValueError('Invalid node utilization')
                        values[metric] = percent
                    except (KeyError, TypeError, ValueError, ZeroDivisionError): failed = True
            except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
                failed = True
        if 'podsUnhealthy' in values:
            try:
                rows = self.reader.read('pods')
                if any(len(row) != 2 or row[0] not in {'Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'} for row in rows): raise ValueError('Invalid pod summary')
                values['podsUnhealthy'] = sum(phase in {'Pending', 'Failed', 'Unknown'} or (phase == 'Running' and ready != 'True') for phase, ready in rows)
            except (OSError, ValueError, TypeError, subprocess.TimeoutExpired): failed = True
        missing = any(value is None for value in values.values())
        unhealthy = (values.get('podsUnhealthy') or 0) > 0 or (values.get('nodesReady') is not None and values.get('nodesTotal') is not None and values['nodesReady'] < values['nodesTotal'])
        return Sample(values, 'error' if failed else 'unknown' if missing else 'warning' if unhealthy else 'ok')
