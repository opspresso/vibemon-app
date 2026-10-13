"""Application loop depends only on sampler, sender, clock, and wait ports."""
import logging
from .domain import Sample, TransmissionPolicy


class DeliveryFailure(RuntimeError):
    """A sender's sanitized failure with an explicit recovery policy."""
    def __init__(self, message, retryable, retry_after=0):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after


def run(sampler, sender, source_id, kind, name, metrics, wall_clock, monotonic, wait, once=False, on_delivery=None):
    policy = TransmissionPolicy()
    deadline = monotonic()
    while True:
        deadline += 10
        wait(max(0, deadline - monotonic()))
        try:
            sample = sampler.sample()
        except Exception as error:
            logging.warning("Collection failed: %s", type(error).__name__)
            sample = Sample({key: None for key in metrics}, "error", memory_type=getattr(sampler, 'memory_type', None), metric_definitions=getattr(sampler, 'metric_definitions', None))
        policy.observe(sample, source_id, kind, name, wall_clock())
        # Use the scheduled observation tick, not variable sampler completion time.
        payload = policy.next_payload(deadline)
        if payload:
            try:
                result = sender(payload)
                if not isinstance(result, dict) or not isinstance(result.get("accepted"), bool):
                    raise DeliveryFailure("Web returned an invalid ingest acknowledgement; check the API origin", retryable=False)
            except Exception as error:
                if isinstance(error, DeliveryFailure) and not error.retryable:
                    raise
                logging.warning("Transmission failed: %s", str(error) if isinstance(error, DeliveryFailure) else type(error).__name__)
                policy.failed(monotonic(), error.retry_after if isinstance(error, DeliveryFailure) else 0)
            else:
                finished = monotonic()
                # An overrun restarts the cadence; normal latency and jitter do not.
                policy.succeeded(payload, finished if finished >= deadline + 10 else deadline)
                # Duplicate/older acknowledgements clear the obsolete window,
                # but they do not refresh the server's source receipt time.
                if result['accepted'] and on_delivery is not None:
                    on_delivery(wall_clock())
                if once:
                    return payload
        # A slow adapter must not cause a burst of backdated catch-up samples.
        if monotonic() >= deadline + 10:
            deadline = monotonic()
