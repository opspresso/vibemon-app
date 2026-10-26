#!/usr/bin/env python3
"""Real macOS LaunchAgent lifecycle against an isolated, synthetic ingest API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import plistlib
import sys
import tempfile
import threading
import time
from unittest import mock
import uuid

if platform.system() != 'Darwin' or os.geteuid() == 0:
    raise SystemExit('Run as a logged-in macOS user, without sudo')
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'public/install'))
import install

accepted = []
rejected = 'vm_' + 'b' * 60


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.headers.get('Authorization') == 'Bearer ' + rejected:
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{}')
            return
        assert payload['displayName'] == 'Fixture Mac'
        assert payload['metrics']['cpuPercent'] is not None
        assert payload['metrics']['memoryPercent'] is not None
        accepted.append(time.time())
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"accepted":true}')


def until(check, message, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.2)
    raise AssertionError(message)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='vibemon-mac-collector-') as directory:
        folder = Path(directory).resolve()
        paths = install.MacCollectorPaths()
        paths.base = folder / 'Collector With Spaces'
        paths.unit = folder / 'LaunchAgents' / 'collector.plist'
        paths.env_file = paths.base / 'collector.env'
        paths.state = paths.base
        paths.label = 'io.vibemon.collector.test.' + uuid.uuid4().hex
        paths.target = paths.domain + '/' + paths.label
        source = install.FileSource(root / 'public/install')
        original_arguments = install.collector_arguments
        def arguments(*args, **kwargs):
            return original_arguments(*args, **kwargs) + ['--allow-local-http']
        with mock.patch.object(install, 'MacCollectorPaths', return_value=paths), \
                mock.patch.object(install, 'SOURCE_NAME', 'Fixture Mac'), \
                mock.patch.object(install, 'web_origin', return_value=f'http://127.0.0.1:{server.server_port}'), \
                mock.patch.object(install, 'collector_arguments', side_effect=arguments):
            try:
                install.install_collector(source, 'vm_' + 'a' * 60)
                original = paths.unit.read_bytes()
                runtime = install.mac_owned_runtime(paths, original)
                assert b'vm_' not in original
                assert (runtime / 'collector.env').stat().st_mode & 0o777 == 0o600
                assert paths.unit.stat().st_mode & 0o777 == 0o600
                assert (runtime / 'health').exists() and accepted
                unrelated = paths.base / 'keep.txt'
                unrelated.write_text('User-owned file')
                try:
                    install.install_collector(source, rejected)
                    raise AssertionError('Rejected credentials must fail installation')
                except RuntimeError as error:
                    assert 'stopped before VibeMon accepted' in str(error), str(error)
                assert paths.unit.read_bytes() == original
                restored_at = time.time()
                until(lambda: accepted[-1] > restored_at, 'Restored collector must deliver a new observation')
                assert unrelated.read_text() == 'User-owned file'
                install.install_collector(source, 'vm_' + 'c' * 60)
                updated = install.mac_owned_runtime(paths, paths.unit.read_bytes())
                assert updated != runtime and not runtime.exists()
                assert 'vm_' not in paths.unit.read_text()
                assert plistlib.loads(paths.unit.read_bytes())['ProgramArguments'][1] == '-I'
                install.uninstall_collector()
                assert not paths.unit.exists() and install.mac_collector_state(paths) is None
                assert not updated.exists() and unrelated.read_text() == 'User-owned file'
                print('PASS native macOS collector: startup, private credentials, rejected upgrade rollback, update, removal, unrelated-file preservation')
            finally:
                # Only this randomly named test job can be stopped here.
                install.mac_stop_collector(paths)
finally:
    server.shutdown()
    server.server_close()
    thread.join()
