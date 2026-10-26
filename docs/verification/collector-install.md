# Collector installation performance

The installer fetches the 12 collector modules with at most four concurrent requests. It loads the integrity manifest first, verifies every module, and publishes the cached batch only when all downloads succeed. Installation still creates and checks a separate runtime before stopping the existing service.

Kubernetes installation changes the pod template's `vibemon.io/install-id` on each apply. This also replaces a pod after a token-only change. The installer no longer issues a separate rollout restart after applying the Deployment. Readiness still requires VibeMon to accept a real summary.

## Reproduce the download comparison

Run from the App repository. The benchmark uses the same payloads and a loopback HTTP server with an 80 ms delay per request. It opens no external connection and installs no service.

```sh
git show a00a9461b5b1fd44f145b1fd7858165c3a1effac:public/install/install.py > /tmp/vibemon-installer-before.py
python3 scripts/benchmark-installer-downloads.py --installer /tmp/vibemon-installer-before.py
python3 scripts/benchmark-installer-downloads.py
```

Five runs per version on 2026-10-27:

| Environment | Sequential median | Concurrent median | Reduction |
| --- | ---: | ---: | ---: |
| macOS, Python 3.14 | 1.1363 s | 0.3593 s | 68.4% |
| Linux ARM64 container, network disabled except loopback | 1.1624 s | 0.3520 s | 69.7% |

These results measure download preparation, including manifest and payload validation. They do not measure total installation, package-index latency, browser approval, image pulling, or first-summary collection. The Linux container is not a DGX Spark hardware benchmark. The installer still waits for service health and accepted data; it does not report completion early.

Regression tests cover concurrent verified reads, cache reuse, rejection of a tampered batch, one Kubernetes apply without a second restart, and a changed pod template for token-only updates. Kubernetes timing requires a real cluster and is not represented by the download benchmark.

## First accepted observation

The first summary contains the first real 10-second observation. Later windows contain three fresh observations. Startup samples are not reused, retry delays remain enforced, and readiness is written only after an accepted ingest response. The Kubernetes probe starts at 10 seconds and checks every 5 seconds; a failed or duplicate acknowledgement cannot make it ready.

`python3 scripts/benchmark-collector-startup.py` runs the host sampler with real CPU and memory readings, a real clock, a loopback ingest API, and a temporary readiness file. The API validates measured values and acknowledges the observation before the file becomes ready. `--collector-dir` selects an extracted baseline package for comparison.

On the same Linux ARM64 container with external networking disabled, one baseline run at `76797cb` became ready in **30.0156 seconds**; one changed run became ready in **10.0113 seconds**. This removes 20 seconds of initial aggregation delay. It measures collector startup through accepted ingest, not package installation or browser approval, and is not a DGX Spark hardware or live Kubernetes timing result.
