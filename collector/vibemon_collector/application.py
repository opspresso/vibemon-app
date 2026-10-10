"""Application loop depends only on sampler, sender, clock, and wait ports."""
import logging
from .domain import Sample, TransmissionPolicy


def run(sampler, sender, source_id, kind, name, metrics, wall_clock, monotonic, wait, once=False):
    policy = TransmissionPolicy()
    deadline = monotonic()
    while True:
        deadline += 10
        wait(max(0, deadline - monotonic()))
        try:
            sample = sampler.sample()
        except Exception as error:
            logging.warning("Collection failed: %s", type(error).__name__)
            sample = Sample({key: None for key in metrics}, "error")
        policy.observe(sample, source_id, kind, name, wall_clock())
        # Use the scheduled observation tick, not variable sampler completion time.
        payload = policy.next_payload(deadline)
        if payload:
            try:
                result = sender(payload)
                if not isinstance(result, dict) or not isinstance(result.get("accepted"), bool):
                    raise ValueError("Invalid ingest acknowledgement")
            except Exception as error:
                logging.warning("Transmission failed: %s", type(error).__name__)
                policy.failed(monotonic())
            else:
                finished = monotonic()
                # An overrun restarts the cadence; normal latency and jitter do not.
                policy.succeeded(payload, finished if finished >= deadline + 10 else deadline)
                if once:
                    return payload
        # A slow adapter must not cause a burst of backdated catch-up samples.
        if monotonic() >= deadline + 10:
            deadline = monotonic()
