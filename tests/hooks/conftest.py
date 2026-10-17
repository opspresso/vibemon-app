import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
# Tests import the installer, shared hook modules, Claude status line and
# manifest generator by module name, the way the installed copies run.
for directory in ("scripts", "public/install", "public/install/claude", "public/install/vibemon"):
    sys.path.insert(0, str(ROOT / directory))

import session_activity
import account_context


def pytest_configure(config):
    config.addinivalue_line("markers", "process_tree: use the real agent-process lookup")


@pytest.fixture(autouse=True)
def isolated_account_context(tmp_path, monkeypatch):
    """Hook fixtures never probe real credentials or register profiles on this machine.

    Existing transport/usage fixtures explicitly represent the legacy default
    account. Identity integration tests remove this override to exercise detection.
    Provider adapter tests construct their own injected source.
    """
    monkeypatch.setenv('VIBEMON_ACCOUNT_ID', 'default')
    monkeypatch.setattr(account_context, 'registry_path', lambda: str(tmp_path / 'accounts.json'))
    monkeypatch.setattr(account_context._source, 'resolve', lambda target, *_: target.unidentified())


@pytest.fixture(autouse=True)
def no_real_watcher(request, monkeypatch):
    """Hook tests run inside a real agent; never attach a watcher to it."""
    if hasattr(session_activity.agent_process, 'cache_clear'):
        session_activity.agent_process.cache_clear()
    monkeypatch.setattr(session_activity, "start_watcher", lambda *_: False)
    if not request.node.get_closest_marker("process_tree"):
        monkeypatch.setattr(session_activity, "agent_process", lambda: None)


@pytest.fixture
def serve():
    """Start loopback HTTP servers for `handler` classes; stop them after the test."""
    running = []

    def start(handler):
        handler.log_message = lambda *_: None
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        running.append((server, thread))
        return server

    yield start
    for server, thread in running:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
