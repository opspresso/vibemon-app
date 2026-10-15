"""A collector clock that advances only when the collector waits."""
from vibemon_collector.application import run


class FakeClock:
    def __init__(self, now=0):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def run_host(sampler, sender, clock, wait=None, **options):
    """Run the collector loop for a CPU-only host source on `clock`."""
    return run(sampler, sender, 'host', 'host', 'Host', ['cpuPercent'], clock, clock, wait or clock.sleep, **options)
