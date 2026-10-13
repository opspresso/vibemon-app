"""Readiness reflects newly accepted observations, without storing credentials or metrics."""
import argparse
import math
import os
from pathlib import Path
import tempfile
import time
from .application import DeliveryFailure


class DeliveryHealth:
    def __init__(self, filename):
        self.path = Path(filename)

    def reset(self):
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            raise DeliveryFailure("Cannot reset delivery readiness file", retryable=False) from None

    def record(self, timestamp):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as output:
                temporary = output.name
                output.write(f"{timestamp}\n")
            os.replace(temporary, self.path)
        except OSError:
            raise DeliveryFailure("Cannot update delivery readiness file", retryable=False) from None
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)

    def ready(self, now, max_age=120):
        try:
            timestamp = float(self.path.read_text())
            return math.isfinite(timestamp) and 0 <= now - timestamp < max_age
        except (OSError, ValueError):
            return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("filename")
    parser.add_argument("--max-age", type=float, default=120)
    args = parser.parse_args()
    raise SystemExit(0 if DeliveryHealth(args.filename).ready(time.time(), args.max_age) else 1)
