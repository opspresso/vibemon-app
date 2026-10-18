"""Exercise real socket reads; a per-read timeout cannot satisfy these bounds."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor
from urllib.error import URLError

import pytest
import vibemon_core
from vibemon_collector.transport import JsonClient
from vibemon_collector.http_deadline import DeadlineOpener


def slow_response(mode):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            body = b'{"value":"' + b'x' * 15 + b'"}'
            try:
                if mode == 'headers':
                    self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Slow: ')
                    for _ in range(15):
                        self.wfile.write(b'x'); self.wfile.flush(); time.sleep(0.03)
                    self.wfile.write(b'\r\nContent-Length: 2\r\n\r\n{}')
                    return
                self.send_response(200)
                self.send_header('Transfer-Encoding' if mode == 'chunked' else 'Content-Length',
                                 'chunked' if mode == 'chunked' else str(len(body)))
                self.end_headers()
                if mode == 'chunked':
                    self.wfile.write(f'{len(body):x}\r\n'.encode())
                for byte in body:
                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.03)
                if mode == 'chunked':
                    self.wfile.write(b'\r\n0\r\n\r\n')
            except OSError:
                pass  # The client must disconnect at its deadline.
        do_POST = do_GET
    return Handler


@pytest.mark.parametrize('mode', ['headers', 'body', 'chunked'])
def test_local_hook_rejects_a_response_that_trickles_past_its_budget(serve, mode):
    server = serve(slow_response(mode))
    started = time.monotonic()
    assert vibemon_core.send_http_get(f'http://127.0.0.1:{server.server_port}', '/health', timeout=0.15) == (False, None)
    assert time.monotonic() - started < 0.6


@pytest.mark.parametrize('mode', ['headers', 'body', 'chunked'])
def test_collector_request_budget_includes_headers_and_body(serve, mode):
    server = serve(slow_response(mode))
    client = JsonClient(timeout=0.15)
    started = time.monotonic()
    with pytest.raises((TimeoutError, URLError)):
        client.request(f'http://127.0.0.1:{server.server_port}/summary')
    assert time.monotonic() - started < 0.6


def test_local_hook_bounds_response_bytes_even_when_the_server_sends_them_quickly(serve):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers()
            try:
                self.wfile.write(b'x' * (1024 * 1024 + 1))
            except OSError:
                pass
    server = serve(Handler)
    assert vibemon_core.send_http_get(f'http://127.0.0.1:{server.server_port}', '/status') == (False, None)


def test_fast_collector_responses_still_preserve_json_and_leave_no_worker_threads(serve):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers()
            self.wfile.write(b'{"zero":0,"missing":null}')
    server = serve(Handler)
    before = set(threading.enumerate())
    for _ in range(5):
        assert JsonClient().request(f'http://127.0.0.1:{server.server_port}/summary') == json.loads('{"zero":0,"missing":null}')
    # Only fixture request handlers may still be returning from their final write.
    assert all(thread in before or thread.name.startswith('Thread-') and 'process_request_thread' in thread.name
               for thread in threading.enumerate())


def test_redirects_consume_the_same_request_budget(serve):
    paths = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            time.sleep(0.08)
            try:
                self.send_response(302)
                self.send_header('Location', '/' + str(len(paths)))
                self.end_headers()
            except OSError:
                pass
    server = serve(Handler)
    started = time.monotonic()
    with pytest.raises((TimeoutError, URLError)):
        DeadlineOpener().open(f'http://127.0.0.1:{server.server_port}/start', timeout=0.15)
    assert time.monotonic() - started < 0.6
    assert len(paths) == 2


def test_one_opener_keeps_concurrent_and_later_request_budgets_separate(serve):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header('Content-Length', '3'); self.end_headers()
            try:
                for byte in b'yes':
                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.1)
            except OSError:
                pass
    server = serve(Handler)
    opener = DeadlineOpener()
    url = f'http://127.0.0.1:{server.server_port}/status'
    def read(timeout):
        with opener.open(url, timeout=timeout) as response:
            return response.read()
    with ThreadPoolExecutor(max_workers=2) as pool:
        short, long = pool.submit(read, 0.15), pool.submit(read, 0.6)
        with pytest.raises(TimeoutError):
            short.result(timeout=1)
        assert long.result(timeout=1) == b'yes'
    assert read(0.6) == b'yes'
