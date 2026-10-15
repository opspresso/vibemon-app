"""Pure summary and transmission rules; no network or operating-system access."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import math

HOST_METRICS = ("cpuPercent", "memoryPercent", "gpuPercent", "gpuTemperatureC")
CLUSTER_METRICS = ("cpuPercent", "memoryPercent", "nodesReady", "nodesTotal", "podsUnhealthy")


@dataclass
class Sample:
    metrics: dict[str, float | None]
    health: str = "ok"
    memory_type: str | None = None
    metric_definitions: dict | None = None


def summarize(samples: list[Sample], source_id: str, kind: str, name: str, observed_at: float) -> dict:
    metrics, maximums = {}, {}
    for key in samples[-1].metrics:
        # A failing final observation must not be hidden by earlier successes.
        values = [sample.metrics.get(key) for sample in samples]
        if samples[-1].metrics.get(key) is None:
            metrics[key] = maximums[key] = None
            continue
        values = [value for value in values if value is not None and math.isfinite(value)]
        maximums[key] = max(values) if values else None
        # Floating-point addition can put even three identical readings above
        # their maximum. Keep the mean inside the observed range on the wire.
        metrics[key] = min(maximums[key], max(min(values), math.fsum(values) / len(values))) if values else None
    payload = {
        "sourceId": source_id, "kind": kind, "displayName": name,
        "observedAt": datetime.fromtimestamp(observed_at, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "health": samples[-1].health, "memoryType": samples[-1].memory_type,
        "heartbeat": False, "metrics": metrics, "maximums": maximums,
    }
    if samples[-1].metric_definitions is not None:
        resource_type = 'Kubernetes' if kind == 'cluster' else 'DGX Spark' if samples[-1].memory_type == 'unified' else 'Server'
        payload.update(resourceType=resource_type, metricDefinitions=samples[-1].metric_definitions, metricOrder=list(samples[-1].metric_definitions))
    return payload


def cluster_health(values: dict[str, float | None], failed: bool) -> str:
    """A cluster is in error when a query failed, unknown when a value is
    missing, and needs attention when a pod is unhealthy or a node is not ready."""
    if failed:
        return "error"
    if any(value is None for value in values.values()):
        return "unknown"
    ready, total = values.get("nodesReady"), values.get("nodesTotal")
    unhealthy = (values.get("podsUnhealthy") or 0) > 0 or (ready is not None and total is not None and ready < total)
    return "warning" if unhealthy else "ok"


@dataclass
class TransmissionPolicy:
    last_sent: dict | None = None
    sent_at: float = float("-inf")
    retry_at: float = 0
    failures: int = 0
    pending: dict | None = None
    samples: list[Sample] = field(default_factory=list)

    def observe(self, sample: Sample, source_id: str, kind: str, name: str, wall_time: float):
        self.samples.append(sample)
        if len(self.samples) == 3:
            self.pending = summarize(self.samples, source_id, kind, name, wall_time)
            self.samples.clear()

    def next_payload(self, now: float) -> dict | None:
        if self.pending is None or now < self.retry_at:
            return None
        changed = self.last_sent is None or self.pending["health"] != self.last_sent["health"]
        if self.last_sent:
            changed |= self.pending["memoryType"] != self.last_sent["memoryType"]
            for key, value in self.pending["metrics"].items():
                old = self.last_sent["metrics"].get(key)
                if value is None or old is None:
                    changed |= value != old
                else:
                    threshold = 2 if key.endswith("Percent") or key == "gpuTemperatureC" else 0
                    changed |= abs(value - old) >= threshold if threshold else value != old
        if changed or now - self.sent_at >= 60:
            return {**self.pending, "heartbeat": not changed}
        return None

    def succeeded(self, payload: dict, now: float):
        self.last_sent = payload
        self.sent_at = now
        self.pending = None
        self.failures = 0
        self.retry_at = 0

    def failed(self, now: float, retry_after: float = 0):
        self.failures += 1
        self.retry_at = now + min(60, max(retry_after, 2 ** min(self.failures, 6)))
        # Never retry an old window. The next three observations replace it.
        self.pending = None
