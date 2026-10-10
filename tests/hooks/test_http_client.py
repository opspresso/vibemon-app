"""Exercise redirect boundaries with actual HTTP sockets and fixture credentials."""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request
from unittest.mock import patch

import pytest

from http_client import open_credential_request


def test_redirect_cannot_forward_bearer_credentials(monkeypatch):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append(self.path)
            self.send_response(307)
            self.send_header('Location', '/unexpected-destination')
            self.end_headers()

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('VIBEMON_ALLOW_HTTP_LOCAL', '1')
    try:
        request = Request(f'http://127.0.0.1:{server.server_port}/api/status', data=b'{}', headers={'Authorization': 'Bearer fixture-only'})
        with pytest.raises(HTTPError) as error:
            open_credential_request(request, timeout=2)
        assert error.value.code == 307
        assert requests == ['/api/status']
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize('url', ['http://web.example/api/status', 'https://user:password@web.example/api/status', 'https://web.example/api/status?token=fixture', 'https://web.example/api/status#fragment'])
def test_invalid_credential_destinations_never_open_network(url):
    with patch('http_client.build_opener') as network, pytest.raises(URLError):
        open_credential_request(Request(url, headers={'Authorization': 'Bearer fixture-only'}), timeout=2)
    network.assert_not_called()


def test_loopback_http_requires_explicit_test_opt_in(monkeypatch):
    monkeypatch.delenv('VIBEMON_ALLOW_HTTP_LOCAL', raising=False)
    with patch('http_client.build_opener') as network, pytest.raises(URLError):
        open_credential_request(Request('http://127.0.0.1:3000/api/status'), timeout=2)
    network.assert_not_called()
