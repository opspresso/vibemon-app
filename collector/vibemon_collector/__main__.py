import argparse
import logging
import os
import re
import shlex
import time
from .application import DeliveryFailure, run
from .domain import HOST_METRICS, CLUSTER_METRICS
from .prometheus import PrometheusSampler
from .kubernetes import KubectlReader, KubernetesSampler
from .transport import JsonClient, checked_url


def main():
    parser = argparse.ArgumentParser(description="Send bounded VibeMon infrastructure summaries")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--kind", choices=["host", "cluster"], default="host")
    parser.add_argument("--url", required=True, help="Web origin; ingest path is appended")
    parser.add_argument("--metrics", help="Comma-separated metric names; default depends on kind")
    parser.add_argument("--memory-type", choices=["auto", "ram", "unified"], default="auto")
    parser.add_argument("--prometheus-url")
    parser.add_argument("--cluster-backend", choices=["prometheus", "metrics-api"], default="prometheus")
    parser.add_argument("--kubectl-command", default="kubectl", help="Read-only kubectl command prefix for metrics-api collection")
    parser.add_argument("--allow-local-http", action="store_true", help="Allow loopback HTTP for isolated development only")
    parser.add_argument("--once", action="store_true", help="Exit after one successful 30-second summary")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", args.source_id) or not 1 <= len(args.name.strip()) <= 128:
        parser.error("Invalid source ID or display name")
    token = os.environ.get("VIBEMON_WRITE_TOKEN", "")
    if not re.fullmatch(r"vm_[a-f0-9]{60}", token):
        parser.error("Set VIBEMON_WRITE_TOKEN to a generated write token")
    allowed = HOST_METRICS if args.kind == "host" else CLUSTER_METRICS
    metrics = list(dict.fromkeys(args.metrics.split(","))) if args.metrics else list(allowed)
    if not metrics or any(key not in allowed for key in metrics):
        parser.error("Unknown or unsupported metric selection")
    try:
        url = checked_url(args.url, args.allow_local_http, origin_only=True)
        if args.kind == "cluster" and args.cluster_backend == "metrics-api":
            sampler = KubernetesSampler(KubectlReader(shlex.split(args.kubectl_command)), metrics, time.time)
        elif args.kind == "cluster":
            if not args.prometheus_url:
                parser.error("--prometheus-url is required for clusters")
            prometheus_url = checked_url(args.prometheus_url, args.allow_local_http)
            sampler = PrometheusSampler(prometheus_url, JsonClient(os.environ.get("PROMETHEUS_TOKEN")), metrics, time.time)
        else:
            from .host import HostSampler
            sampler = HostSampler(metrics, args.memory_type)
    except ValueError as error:
        parser.error(str(error))
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    client = JsonClient(token)
    try:
        run(sampler, lambda payload: client.request(f"{url}/api/v1/ingest", payload), args.source_id, args.kind, args.name, metrics, time.time, time.monotonic, time.sleep, args.once)
    except KeyboardInterrupt:
        pass
    except DeliveryFailure as error:
        logging.error("%s", error)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
