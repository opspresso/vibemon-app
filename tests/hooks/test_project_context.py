import pytest

import project_context
import statusline
import vibemon_core


@pytest.mark.parametrize("cwd", ["/work/vibemon", "/work/vibemon/"])
def test_hooks_and_statusline_name_a_project_alike(monkeypatch, cwd):
    # The statusline writes the model cache under this name; the hooks read it back.
    monkeypatch.setattr(project_context, "get_git_root", lambda _: None)
    assert statusline.get_project_name(cwd) == vibemon_core.get_project_name(cwd, "") == "vibemon"


def test_the_git_root_names_a_subdirectory_session(monkeypatch):
    monkeypatch.setattr(project_context, "get_git_root", lambda _: "/work/vibemon")
    assert project_context.get_project_name("/work/vibemon/terraform") == "vibemon"


def test_a_session_without_a_directory_falls_back_to_its_transcript(monkeypatch):
    monkeypatch.setattr(project_context, "get_git_root", lambda _: None)
    assert project_context.get_project_name("", "/home/u/.claude/projects/app/session.jsonl") == "app"
