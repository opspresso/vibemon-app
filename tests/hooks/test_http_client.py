"""Exercise redirect boundaries with actual HTTP sockets and fixture credentials."""
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.request import Request
from unittest.mock import patch

import pytest

from http_client import open_credential_request
import vibemon_core


def test_redirect_cannot_forward_bearer_credentials(monkeypatch, serve):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append(self.path)
            self.send_response(307)
            self.send_header('Location', '/unexpected-destination')
            self.end_headers()

    server = serve(Handler)
    monkeypatch.setenv('VIBEMON_ALLOW_HTTP_LOCAL', '1')
    request = Request(f'http://127.0.0.1:{server.server_port}/api/status', data=b'{}', headers={'Authorization': 'Bearer fixture-only'})
    with pytest.raises(HTTPError) as error:
        open_credential_request(request, timeout=2)
    assert error.value.code == 307
    assert requests == ['/api/status']


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


def test_local_delivery_joins_a_trailing_slash_like_the_javascript_plugin(serve):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            # Closing with unread request bytes can reset the TCP response.
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
            target = self.requestline.split()[1]
            requests.append(target)
            self.send_response(200 if target in ['/status', '/prefix/status'] else 404)
            self.end_headers()
            self.wfile.write(b'{}')
        do_POST = do_GET
    server = serve(Handler)
    for prefix in ['', '/prefix']:
        origin = f'http://127.0.0.1:{server.server_port}{prefix}/'
        assert vibemon_core.send_http_post(origin, '/status', '{}')[0]
        assert vibemon_core.send_http_get(origin, '/status')[0]
    assert requests == ['/status', '/status', '/prefix/status', '/prefix/status']
