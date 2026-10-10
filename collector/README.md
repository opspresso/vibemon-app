# VibeMon collector

A headless collector sends display summaries from Linux servers, DGX Spark, macOS hosts, or an existing Prometheus service. It does not send logs or per-pod/per-GPU series.

## Install and run

Use Python 3.10+ and the public [VibeMon App repository](https://github.com/opspresso/vibemon-app). The collector is included in that repository and is not published as a standalone Python package. From the App repository root:

```sh
python3 -m venv .venv
.venv/bin/pip install ./collector
# Supply the generated write token through your secret manager or environment.
# VIBEMON_WRITE_TOKEN must be set; do not put the value in command-line arguments.
.venv/bin/vibemon-collector --source-id host-1 --name 'My server' --url https://vibemon.io
```

Generate the token at [Account](https://vibemon.io/account) and select **Show token** to copy it. A read-only token cannot collect. A token can be rotated by restarting the collector with its replacement. For a supervised service, keep the environment file readable only by the service account and never commit it.

| Option | Purpose |
| --- | --- |
| `--source-id` | Owner-local stable ID; required |
| `--name` | Display name; required |
| `--url` | Web HTTPS origin; required |
| `--kind host` | Read local CPU, RAM, and available NVIDIA GPU metrics (default) |
| `--kind cluster --prometheus-url URL` | Read five aggregate Prometheus queries (default cluster backend) |
| `--kind cluster --cluster-backend metrics-api` | Read existing Kubernetes Metrics API, node capacity/readiness, and pod health |
| `--kubectl-command "sudo -n k3s kubectl"` | Command prefix for a local k3s administrator; defaults to `kubectl` |
| `--metrics cpuPercent,memoryPercent` | Collect only the selected metrics |
| `--memory-type auto` | Detect Spark/GB10 unified memory; `ram` and `unified` explicitly override |
| `--once` | Exit after one successfully acknowledged 30-second summary |
| `--allow-local-http` | Permit HTTP on loopback addresses only for isolated development |

`VIBEMON_WRITE_TOKEN` supplies the Web token. `PROMETHEUS_TOKEN`, if set, supplies a separate read credential for Prometheus. TLS certificate verification is always enabled. Redirects are rejected to avoid forwarding credentials to another host.

## Observation and retry rules

The collector observes every 10 seconds and summarizes three observations. It sends a new summary when a window mean differs by at least 2 percentage points or 2 °C from the last successful transmission, a node/pod count changes, measurement availability changes, or health changes. Unchanged state sends a heartbeat every 60 seconds.

Only the current three samples and the newest pending summary remain in memory. Transmission failures discard the old pending window; the next window replaces it. Exponential backoff caps at 60 seconds. Recovery sends current state without replaying old samples. A slow adapter never triggers a burst of catch-up observations. Collection and transmission failures are logged by exception type without credentials or response bodies.

Window maxima accompany means so the Web minute aggregate retains peaks. Missing, unsupported, nonfinite, or failed measurements remain `null`. If a metric fails on the last observation of a window, that metric is `null` for the entire transmitted window; earlier success cannot hide a current failure.

## DGX Spark

System RAM is the unified CPU/GPU memory pool. The collector uses system memory usage, rather than adding GPU memory to RAM. `nvidia-smi` reports available GPU utilization and temperature; unsupported values such as `[N/A]` become `null`. `--memory-type unified` is available when model detection is not exposed. For a host with several GPUs, the displayed utilization is the busiest GPU and the displayed temperature is the hottest GPU.

GPU capabilities depend on the installed driver and hardware. Verify locally with:

```sh
nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.total --format=csv,noheader,nounits
```

## Kubernetes prerequisites

Prometheus must scrape node-exporter CPU/memory and kube-state-metrics node conditions, node info, pod phases, and pod readiness. The queries target one cluster per Prometheus endpoint. A multi-cluster endpoint requires a dedicated scoped view before using this collector.

CPU averages idle rates across cores. Memory is capacity-weighted across hosts. Node and pod metrics deduplicate kube-state-metrics replicas. Unhealthy pods include Pending, Failed, Unknown, and running-but-not-ready pods; completed Jobs are excluded. Absent exporter data produces `null`, never an invented healthy zero. These expressions expect kube-state-metrics v2's zero-valued phase/condition series; sparse-series schemas require updated fixtures and queries.

Queries return exactly one unlabelled instant value each. The adapter rejects raw labelled series, stale timestamps, invalid values, and oversized responses. Only the resulting summary is sent to VibeMon.

### Clusters without Prometheus

Select `--cluster-backend metrics-api` when the cluster already has metrics-server. The collector uses read-only `kubectl` requests for `nodes.metrics.k8s.io`, node capacity/readiness, and pod phase/readiness. Its identity needs `list` on core nodes/pods and `get`/`list` on Metrics API nodes. It does not create workloads or change cluster configuration.

```sh
vibemon-collector --kind cluster --cluster-backend metrics-api \
  --kubectl-command "sudo -n k3s kubectl" \
  --source-id k3s-ec2 --name "EC2 k3s" --url https://vibemon.io
```

CPU is total measured cores divided by total node CPU capacity. Memory is total working-set bytes divided by total node memory capacity, weighted by capacity. The [Kubernetes Metrics API](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/) supplies these measurements; its working-set memory differs from the Prometheus node-exporter available-memory expression. If any node's usage is missing or older than 120 seconds, utilization is unavailable rather than a partial cluster total. Node/pod status remains independently available. Completed pods are excluded from unhealthy counts.

The CLI reads only the selected summary fields from node/pod objects. Pod specs, credentials and logs are not part of the Python result or Web payload. Python 3.10+ is still required; this backend does not import the host-only `psutil` adapter.

## Tests

```sh
python3 -m unittest discover -s collector/tests
# Run from a virtual environment with the collector installed.
python3 collector/tests/promql_fixture.py > /tmp/vibemon-promql.json
docker run --rm --entrypoint /bin/promtool \
  -v /tmp/vibemon-promql.json:/fixture.json:ro \
  prom/prometheus:v3.7.3 test rules /fixture.json
```

The PromQL fixture covers unequal host memory, idle rates, duplicate kube-state-metrics replicas, running unready pods, completed Jobs, and missing exporters. This proves expression behavior against synthetic series; it does not prove a particular cluster's scrape configuration or permissions.
