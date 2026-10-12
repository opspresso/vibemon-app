"""Exercise the image's real kubectl against a TLS service-account API fixture."""
import json
import os
import ssl
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from vibemon_collector.kubernetes import KubectlReader
from vibemon_collector.kubelet import KubeletReader


class MetricsAPI(BaseHTTPRequestHandler):
    requests = []

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
        self.wfile.write(body)

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
    print('Verified kubectl TLS and mounted service-account authentication.')
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
