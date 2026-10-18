"""Exercise the image's real kubectl against a TLS service-account API fixture."""
import json
import os
import ssl
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError

from vibemon_collector.kubernetes import KubectlReader
from vibemon_collector.kubelet import KubeletReader
from vibemon_collector.http_deadline import DeadlineOpener


class MetricsAPI(BaseHTTPRequestHandler):
    requests = []
    slow = False

    def do_GET(self):
        self.requests.append(self.path)
        if self.path not in ('/apis/metrics.k8s.io/v1beta1/nodes', '/stats/summary'):
            self.send_error(404)
            return
        if self.headers.get('Authorization') != 'Bearer in-cluster-test-token':
            self.send_error(403)
            return
        body = json.dumps({'items': []} if self.path.startswith('/apis/') else {'node': {'nodeName': 'fixture'}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            if self.slow:
                for byte in body:
                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.03)
            else:
                self.wfile.write(body)
        except OSError:
            pass  # A timed-out test request closes its socket.

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), MetricsAPI)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/tmp/fixture/serviceaccount/ca.crt', '/tmp/fixture/tls.key')
server.socket = context.wrap_socket(server.socket, server_side=True)
os.environ['KUBERNETES_SERVICE_HOST'] = '127.0.0.1'
os.environ['KUBERNETES_SERVICE_PORT'] = str(server.server_port)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    assert KubectlReader(['kubectl', '--cache-dir=/tmp/kubectl']).read('usage') == {'items': []}
    assert MetricsAPI.requests == ['/apis/metrics.k8s.io/v1beta1/nodes']
    assert KubeletReader(Path('/tmp/fixture/serviceaccount')).read('127.0.0.1', server.server_port) == {'node': {'nodeName': 'fixture'}}
    assert MetricsAPI.requests[-1] == '/stats/summary'
    MetricsAPI.slow = True
    started = time.monotonic()
    try:
        KubeletReader(Path('/tmp/fixture/serviceaccount'), timeout=0.15).read('127.0.0.1', server.server_port)
        raise AssertionError('A trickled TLS body exceeded the request budget')
    except TimeoutError:
        assert time.monotonic() - started < 0.6
    finally:
        MetricsAPI.slow = False
    assert KubeletReader(Path('/tmp/fixture/serviceaccount')).read('127.0.0.1', server.server_port) == {'node': {'nodeName': 'fixture'}}
    try:
        DeadlineOpener().open(f'https://127.0.0.1:{server.server_port}/stats/summary', timeout=1)
        raise AssertionError('The fixture CA must not be globally trusted')
    except URLError as error:
        assert isinstance(error.reason, ssl.SSLCertVerificationError)
    print('Verified kubectl TLS, service-account authentication, bounded TLS bodies and certificate verification.')
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
