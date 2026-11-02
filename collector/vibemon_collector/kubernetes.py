"""Read-only Metrics API adapter for clusters without Prometheus."""
import json
import logging
import math
import re
import subprocess
from concurrent.futures import CancelledError, ThreadPoolExecutor, wait
from datetime import datetime
from decimal import Decimal, InvalidOperation
from threading import Event
from .domain import Sample, cluster_health
from .disk import CLUSTER_DEFINITIONS, DISK_METRICS, disk_values
from .kubelet import filesystem

DISK_QUERY_TIMEOUT = 5
# Pod lists and kubelet summaries are the expensive reads. Reuse a successful
# result for one 30-second summary window instead of repeating it every tick.
SLOW_READ_REUSE_SECONDS = 30
# Rollouts briefly leave new pods Pending or not ready. Count a pod only after
# it has stayed not ready this long.
UNREADY_GRACE_SECONDS = 120
# A new kubelet needs time to publish the first pair of usage observations.
# This window starts at node creation, not collector startup or each failure.
NODE_METRICS_GRACE_SECONDS = 120

# Output only capacity/readiness fields; pod specs, environment and logs are not read into Python.
NODE_FIELDS = '{range .items[*]}{.metadata.name}{"\\t"}{.status.capacity.cpu}{"\\t"}{.status.capacity.memory}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.metadata.deletionTimestamp}{"\\n"}{end}'
POD_FIELDS = '{range .items[*]}{.status.phase}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\t"}{.status.conditions[?(@.type=="Ready")].lastTransitionTime}{"\\t"}{.metadata.creationTimestamp}{"\\t"}{.metadata.deletionTimestamp}{"\\n"}{end}'
ENDPOINT_FIELDS = '{range .items[*]}{.metadata.name}{"\\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\\t"}{.status.daemonEndpoints.kubeletEndpoint.Port}{"\\n"}{end}'
SCALES = {'n': 1e-9, 'u': 1e-6, 'm': 1e-3, '': 1, **{unit: 1000 ** (index + 1) for index, unit in enumerate('kMGTPE')}, **{unit + 'i': 1024 ** (index + 1) for index, unit in enumerate('KMGTPE')}}
SCALES['K'] = 1000

def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None: raise ValueError('Missing timestamp timezone')
    return parsed.timestamp()

class CollectionIssue(ValueError):
    """Only collector-owned reason codes and validated node names enter logs."""
    def __init__(self, reason, nodes=(), pending=False):
        super().__init__(reason)
        self.reason, self.nodes, self.pending = reason, tuple(sorted(nodes)), pending

def unhealthy_pod(row, now):
    """Count pods that should be serving but are not. Completed and failed pods
    are finished attempts, and terminating pods are being removed on purpose."""
    phase, ready, ready_since, created, deleting = row
    if deleting or phase in {'Succeeded', 'Failed'}:
        return False
    if phase == 'Unknown':
        return True
    return ready != 'True' and now - timestamp(ready_since or created) >= UNREADY_GRACE_SECONDS

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
            'endpoints': ['get', 'nodes', '-o', f'jsonpath={ENDPOINT_FIELDS}'],
        }[kind]
        # A request-timeout override prevents kubectl's default-config check from
        # selecting the mounted service account. Bound the whole process instead.
        result = subprocess.run([*self.command, *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8, check=False, text=True)
        if result.returncode or len(result.stdout.encode()) > 1024 * 1024:
            raise ValueError('Kubernetes summary query failed')
        return json.loads(result.stdout) if kind == 'usage' else [line.split('\t') for line in result.stdout.splitlines() if line]

class KubernetesSampler:
    def __init__(self, reader, metrics, clock, disk_reader=None):
        self.reader, self.metrics, self.clock = reader, metrics, clock
        self.disk_reader = disk_reader
        self.metric_definitions = CLUSTER_DEFINITIONS if set(metrics).intersection(DISK_METRICS) else None
        self.disk_executor = None
        self.disk_futures = []
        self.reused = {}
        self.node_identity = None
        self.diagnostics = {}

    def report(self, stage, issue=None):
        previous = self.diagnostics.get(stage)
        if issue is None:
            if previous:
                logging.info('Kubernetes collection recovered: stage=%s duration_seconds=%.0f', stage, max(0, self.clock() - previous[1]))
                del self.diagnostics[stage]
            return
        reason = issue.reason if isinstance(issue, CollectionIssue) else type(issue).__name__
        nodes = issue.nodes if isinstance(issue, CollectionIssue) else ()
        signature = (reason, nodes)
        if previous and previous[0] == signature: return
        since = previous[1] if previous else self.clock()
        self.diagnostics[stage] = (signature, since)
        level = logging.INFO if isinstance(issue, CollectionIssue) and issue.pending else logging.WARNING
        logging.log(level, 'Kubernetes collection unavailable: stage=%s reason=%s nodes=%s node_count=%d duration_seconds=%.0f',
                    stage, reason, ','.join(nodes[:8]) or '-', len(nodes), max(0, self.clock() - since))

    def read_nodes(self):
        rows = self.reader.read('nodes')
        if any(len(row) != 6 or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,252}', row[0]) or row[3] not in {'True', 'False', 'Unknown', ''} for row in rows):
            raise CollectionIssue('invalid_node_summary')
        nodes = {row[0]: row for row in rows}
        if len(nodes) != len(rows): raise CollectionIssue('duplicate_node_summary')
        for row in rows:
            timestamp(row[4])
            if row[5]: timestamp(row[5])
        return {name: row for name, row in nodes.items() if not row[5]}

    def reuse(self, name):
        cached = self.reused.get(name)
        if cached and 0 <= self.clock() - cached[0] < SLOW_READ_REUSE_SECONDS:
            return cached[1]
        return None

    def remember(self, name, values):
        self.reused[name] = (self.clock(), values)

    def sample(self):
        values = {key: None for key in self.metrics}
        failed = False
        nodes = None
        if set(self.metrics) - {'podsUnhealthy'}:
            try:
                nodes = self.read_nodes()
                self.report('nodes')
            except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired) as error:
                failed = True
                self.report('nodes', error)
        usage_keys = [key for key in ('cpuPercent', 'memoryPercent') if key in values]
        if usage_keys and nodes:
            try:
                response = self.reader.read('usage')
                entries = response['items']
                usage = {entry['metadata']['name']: entry for entry in entries}
                if len(usage) != len(entries): raise CollectionIssue('duplicate_node_usage')
                if set(nodes) - usage.keys():
                    # Reconcile independently read API snapshots once. A removed
                    # node must not fail collection; newly added nodes still count.
                    nodes = self.read_nodes()
                missing = set(nodes) - usage.keys()
                for name in nodes.keys() & usage.keys():
                    observed = timestamp(usage[name]['timestamp'])
                    if not -30 <= self.clock() - observed <= 120: raise CollectionIssue('stale_node_usage', [name])
                if missing:
                    pending = all(0 <= self.clock() - timestamp(nodes[name][4]) < NODE_METRICS_GRACE_SECONDS for name in missing)
                    raise CollectionIssue('node_metrics_warming' if pending else 'missing_node_usage', missing, pending)
                self.report('usage')
                for metric in usage_keys if nodes else []:
                    field, column = ('cpu', 1) if metric == 'cpuPercent' else ('memory', 2)
                    try:
                        capacity = sum(quantity(row[column]) for row in nodes.values())
                        used = sum(quantity(usage[name]['usage'][field]) for name in nodes)
                        percent = 100 * used / capacity
                        if not 0 <= percent <= 100: raise ValueError('Invalid node utilization')
                        values[metric] = percent
                        self.report(metric)
                    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
                        failed = True
                        self.report(metric, error)
            except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired) as error:
                failed |= not (isinstance(error, CollectionIssue) and error.pending)
                self.report('usage', error)
        if nodes is not None:
            if 'nodesReady' in values: values['nodesReady'] = sum(row[3] == 'True' for row in nodes.values())
            if 'nodesTotal' in values: values['nodesTotal'] = len(nodes)
        identity = tuple(sorted((name, row[4]) for name, row in nodes.items())) if nodes is not None else None
        if identity != self.node_identity:
            self.reused.pop('disk', None)
            self.node_identity = identity
        disk_keys = set(values).intersection(DISK_METRICS)
        reused_disk = self.reuse('disk') if disk_keys and nodes else None
        if reused_disk is not None:
            values.update({key: reused_disk[key] for key in disk_keys})
        elif disk_keys and nodes:
            try:
                # Cancelling a queued Future does not remove its executor work item.
                # Keep one batch until its work items drain, including after the deadline.
                if any(not future.done() for future in self.disk_futures):
                    raise ValueError('Previous kubelet summary requests are still running')
                rows = self.reader.read('endpoints')
                if any(len(row) != 3 for row in rows): raise ValueError('Invalid kubelet endpoints')
                endpoints = {row[0]: row for row in rows}
                if len(endpoints) != len(rows) or not set(nodes).issubset(endpoints): raise ValueError('Incomplete kubelet endpoints')
                stopped = Event()
                def disk(name):
                    if stopped.is_set(): raise CancelledError()
                    _, addresses, port = endpoints[name]
                    # Dual-stack nodes may advertise both IPv4 and IPv6.
                    return filesystem(self.disk_reader.read(addresses.split()[0], port), name, self.clock())
                # Reuse a bounded pool: timed-out requests must not create more
                # workers on the next tick, or wait for queued node batches.
                if self.disk_executor is None:
                    self.disk_executor = ThreadPoolExecutor(max_workers=8)
                futures = []
                self.disk_futures = futures
                try:
                    for name in nodes:
                        futures.append(self.disk_executor.submit(disk, name))
                    _, pending = wait(futures, timeout=DISK_QUERY_TIMEOUT)
                    if pending: raise ValueError('Kubelet summary deadline exceeded')
                    disks = [future.result() for future in futures]
                finally:
                    # Queued calls exit without reading; their Futures stay pending until drained.
                    stopped.set()
                available = sum(item[0] for item in disks)
                capacity = sum(item[1] for item in disks)
                measured = disk_values(available, capacity)
                values.update({key: value for key, value in measured.items() if key in values})
                if all(measured[key] is not None for key in disk_keys):
                    self.remember('disk', measured)
                    self.report('disk')
            except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, subprocess.TimeoutExpired) as error:
                # Disk is optional: an unreachable kubelet leaves the disk values
                # unavailable without making the cluster a collection error.
                self.report('disk', error)
        reused_pods = self.reuse('pods') if 'podsUnhealthy' in values else None
        if reused_pods is not None:
            values['podsUnhealthy'] = reused_pods
        elif 'podsUnhealthy' in values:
            try:
                rows = self.reader.read('pods')
                if any(len(row) != 5 or row[0] not in {'Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'} or not row[3] for row in rows): raise ValueError('Invalid pod summary')
                values['podsUnhealthy'] = sum(unhealthy_pod(row, self.clock()) for row in rows)
                self.remember('pods', values['podsUnhealthy'])
                self.report('pods')
            except (OSError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
                failed = True
                self.report('pods', error)
        core = {key: value for key, value in values.items() if key not in DISK_METRICS}
        return Sample(values, cluster_health(core, failed), metric_definitions=self.metric_definitions)
