"""Five instant aggregate queries; pod/node series stay inside Prometheus."""
import math
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from .domain import Sample, cluster_health

QUERIES = {
    "cpuPercent": '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[2m])))',
    "memoryPercent": '100 * (1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))',
    "nodesReady": 'sum(max by (node) (kube_node_status_condition{condition="Ready",status="true"}))',
    "nodesTotal": 'count(max by (node) (kube_node_info))',
    # Matches the Metrics API backend: Unknown pods, and Pending or Running pods
    # that are at least 120 seconds old and were not ready for the last 2 minutes.
    # Finished and terminating pods are not counted.
    "podsUnhealthy": 'sum((max by (namespace,pod) (kube_pod_status_phase{phase="Unknown"}) + on(namespace,pod) (max by (namespace,pod) (kube_pod_status_phase{phase=~"Pending|Running"}) * on(namespace,pod) (1 - max by (namespace,pod) (max_over_time(kube_pod_status_ready{condition="true"}[2m]))) * on(namespace,pod) (max by (namespace,pod) (time() - kube_pod_created) >= bool 120))) unless on(namespace,pod) kube_pod_deletion_timestamp)',
}


def scalar_summary(response, now):
    if not isinstance(response, dict) or response.get("status") != "success":
        raise ValueError("Prometheus query failed")
    data = response.get("data", {})
    if not isinstance(data, dict) or data.get("resultType") != "vector":
        raise ValueError("Expected an aggregate instant vector")
    rows = data.get("result", [])
    if not isinstance(rows, list):
        raise ValueError("Invalid aggregate result")
    if not rows:
        return None
    if len(rows) != 1 or not isinstance(rows[0], dict) or rows[0].get("metric") != {}:
        raise ValueError("Query must return a single unlabelled summary")
    observed_at, raw = rows[0]["value"]
    timestamp = float(observed_at)
    if not math.isfinite(timestamp) or abs(now - timestamp) > 120:
        return None
    value = float(raw)
    return value if math.isfinite(value) and value >= 0 else None


class PrometheusSampler:
    def __init__(self, url, client, metrics, clock):
        self.url, self.client, self.metrics, self.clock = url, client, metrics, clock

    def sample(self):
        values = {}
        failed = False
        now = self.clock()
        def query(key):
            try:
                response = self.client.request(f"{self.url}/api/v1/query?{urlencode({'query': QUERIES[key], 'time': now})}")
                value = scalar_summary(response, now)
                if value is not None and key.endswith("Percent") and value > 100:
                    raise ValueError("Percentage out of range")
                return key, value, False
            except (OSError, ValueError, KeyError, TypeError):
                return key, None, True
        # Query latency is bounded by one request timeout, not five serial waits.
        with ThreadPoolExecutor(max_workers=len(self.metrics)) as executor:
            for key, value, error in executor.map(query, self.metrics):
                values[key] = value
                failed |= error
        return Sample(values, cluster_health(values, failed))
