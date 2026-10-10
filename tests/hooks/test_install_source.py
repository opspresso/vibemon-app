import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[2] / "public" / "install"))
import install


class InstallerSourceTests(unittest.TestCase):
    def test_url_boundaries(self):
        with mock.patch.dict(os.environ, {"VIBEMON_ALLOW_HTTP_LOCAL": "0"}):
            for value in ["http://remote.example/install", "http://127.0.0.1/install", "file:///tmp/install", "https://user:secret@example/install", "https://example/install?key=secret", "https://example/#fragment", "https://example/\ninstall"]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    install.checked_download_url(value)
        with mock.patch.dict(os.environ, {"VIBEMON_ALLOW_HTTP_LOCAL": "1"}):
            self.assertEqual(install.checked_download_url("http://127.0.0.1:3030/install/"), "http://127.0.0.1:3030/install")

    def test_remote_manifest_files_redirects_and_size_limit(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                requests.append(self.path)
                prefix = self.path.split('/')[1]
                content = f'print("{prefix}")\n'.encode()
                if self.path.endswith('/redirect.py'):
                    self.send_response(302); self.send_header('Location', '/redirected.py'); self.end_headers(); return
                if self.path.endswith('/manifest.json'):
                    content = json.dumps({'files': {'fixture.py': hashlib.sha256(content).hexdigest()}}).encode()
                elif self.path.endswith('/large.py'):
                    content = b'x' * (install.MAX_DOWNLOAD_BYTES + 1)
                self.send_response(200); self.end_headers(); self.wfile.write(content)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with mock.patch.object(install, '_MANIFEST_LOADED', False), mock.patch.dict(os.environ, {'VIBEMON_ALLOW_HTTP_LOCAL': '1'}):
                for prefix in ['one', 'two']:
                    base = f'http://127.0.0.1:{server.server_port}/{prefix}'
                    with mock.patch.dict(os.environ, {'VIBEMON_DOCS_URL': base}):
                        self.assertEqual(install.FileSource().get_file('fixture.py'), f'print("{prefix}")\n')
                with self.assertRaises(RuntimeError): install.download_file(base + '/redirect.py')
                with self.assertRaisesRegex(RuntimeError, '1 MiB'): install.download_file(base + '/large.py')
            self.assertEqual(requests[:4], ['/one/manifest.json', '/one/fixture.py', '/two/manifest.json', '/two/fixture.py'])
            self.assertNotIn('/redirected.py', requests)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_persists_explicit_api_origin_without_logging_the_write_token(self):
        token = 'vm_' + 'b' * 60
        source = mock.Mock(get_file=lambda _: json.dumps({'vibemon_url': 'https://vibemon.io', 'vibemon_token': ''}))
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(Path, 'home', return_value=Path(directory)), mock.patch.dict(install.VIBEMON_CONFIG_CACHE, {}, clear=True), mock.patch.dict(os.environ, {'VIBEMON_URL': 'https://custom.example/', 'VIBEMON_WRITE_TOKEN': token}), mock.patch('sys.stdout', new_callable=io.StringIO) as output:
            install.configure_vibemon_config(source)
            config = json.loads((Path(directory) / '.vibemon/config.json').read_text())
            self.assertEqual(config['vibemon_url'], 'https://custom.example')
            self.assertEqual(config['vibemon_token'], token)
            self.assertNotIn(token, output.getvalue())

    def test_cannot_reuse_an_old_token_when_switching_web_origins(self):
        source = mock.Mock(get_file=lambda _: '{}')
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(Path, 'home', return_value=Path(directory)), mock.patch.dict(install.VIBEMON_CONFIG_CACHE, {}, clear=True), mock.patch.dict(os.environ, {'VIBEMON_URL': 'https://different.example', 'VIBEMON_WRITE_TOKEN': ''}):
            path = Path(directory) / '.vibemon/config.json'; path.parent.mkdir()
            original = json.dumps({'vibemon_url': 'https://original.example', 'vibemon_token': 'vm_' + 'a' * 60})
            path.write_text(original)
            with self.assertRaisesRegex(ValueError, 'matching VIBEMON_WRITE_TOKEN'): install.configure_vibemon_config(source)
            self.assertEqual(path.read_text(), original)
