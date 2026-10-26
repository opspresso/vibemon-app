#!/usr/bin/env python3
"""Measure first accepted host observation using the real clock and a loopback API."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import time

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--collector-dir', type=Path, default=root / 'collector')
args = parser.parse_args()
sys.path.insert(0, str(args.collector_dir))
from vibemon_collector.application import run
from vibemon_collector.host import HostSampler
from vibemon_collector.health import DeliveryHealth
from vibemon_collector.transport import JsonClient

received = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert payload['kind'] == 'host'
        assert 0 <= payload['metrics']['cpuPercent'] <= 100
        assert 0 <= payload['metrics']['memoryPercent'] <= 100
        received.append(time.monotonic())
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"accepted":true}')


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='vibemon-startup-') as directory:
        health = DeliveryHealth(Path(directory) / 'health')
        client = JsonClient('nonfunctional-benchmark-credential')
        metrics = ['cpuPercent', 'memoryPercent']
        started = time.monotonic()
        sampler = HostSampler(metrics)
        run(sampler, lambda payload: client.request(f'http://127.0.0.1:{server.server_port}/api/v1/ingest', payload),
            'benchmark-host', 'host', 'Benchmark host', metrics, time.time, time.monotonic, time.sleep,
            once=True, on_delivery=health.record)
        finished = time.monotonic()
        assert len(received) == 1 and health.ready(time.time())
        print(json.dumps({'first_accepted_seconds': round(received[0] - started, 4),
                          'ready_seconds': round(finished - started, 4), 'accepted_observations': len(received)}))
finally:
    server.shutdown()
    server.server_close()
    thread.join()
