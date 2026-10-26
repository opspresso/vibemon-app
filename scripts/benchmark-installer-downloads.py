#!/usr/bin/env python3
"""Measure collector download preparation against a repeatable loopback fixture."""
import argparse
from contextlib import redirect_stdout
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import statistics
import threading
import time

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--installer', type=Path, default=root / 'public/install/install.py')
parser.add_argument('--latency-ms', type=float, default=80)
parser.add_argument('--runs', type=int, default=5)
args = parser.parse_args()
if args.latency_ms < 0 or args.runs < 1:
    parser.error('latency must be nonnegative and runs must be positive')
spec = importlib.util.spec_from_file_location('installer_benchmark', args.installer)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
files = {path: (root / path).read_bytes() for path in installer.COLLECTOR_FILES}
manifest = json.dumps({'files': {path: hashlib.sha256(data).hexdigest() for path, data in files.items()}}).encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        time.sleep(args.latency_ms / 1000)
        data = manifest if self.path == '/manifest.json' else files.get(self.path.lstrip('/'))
        if data is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
os.environ.update(VIBEMON_ALLOW_HTTP_LOCAL='1', VIBEMON_DOCS_URL=f'http://127.0.0.1:{server.server_port}')
os.environ.pop('VIBEMON_MANIFEST_SHA256', None)
results = []
try:
    for _ in range(args.runs):
        installer._MANIFEST_LOADED = False
        source = installer.FileSource()
        started = time.monotonic()
        with redirect_stdout(io.StringIO()):
            if hasattr(source, 'prefetch'):
                source.prefetch(installer.COLLECTOR_FILES)
            for path in installer.COLLECTOR_FILES:
                assert source.get_file(path).encode() == files[path]
        results.append(round(time.monotonic() - started, 4))
finally:
    server.shutdown()
    server.server_close()
    thread.join()
print(json.dumps({'files': len(files), 'latency_ms': args.latency_ms, 'seconds': results, 'median_seconds': statistics.median(results)}))
