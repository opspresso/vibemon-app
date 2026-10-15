import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
# Tests import the installer, shared hook modules, Claude status line and
# manifest generator by module name, the way the installed copies run.
for directory in ("scripts", "public/install", "public/install/claude", "public/install/vibemon"):
    sys.path.insert(0, str(ROOT / directory))

import session_activity


def pytest_configure(config):
    config.addinivalue_line("markers", "process_tree: use the real agent-process lookup")


@pytest.fixture(autouse=True)
def no_real_watcher(request, monkeypatch):
    """Hook tests run inside a real agent; never attach a watcher to it."""
    monkeypatch.setattr(session_activity, "start_watcher", lambda *_: False)
    if not request.node.get_closest_marker("process_tree"):
        monkeypatch.setattr(session_activity, "agent_process", lambda: None)
