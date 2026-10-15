#!/usr/bin/env python3
"""
Regenerate public/install/manifest.json — the sha256 manifest of every file install.py
downloads before copying or merging, plus the sha256 of install.py
itself (the "installer" key). The VibeMon Desktop app fetches this manifest
periodically and compares the hashes against the installed local files to
detect out-of-date scripts, and verifies the downloaded install.py against
the installer hash before running it.

Merged configuration templates are verified before merging. App drift checks
compare only verbatim-installed files, not user-owned merged configuration.

Usage:
  python3 scripts/generate_manifest.py
"""

import hashlib
import json
from pathlib import Path

DOCS_DIR = Path(__file__).parents[1] / "public" / "install"
MANIFEST_PATH = DOCS_DIR / "manifest.json"

# Keep in sync with the write_file_with_diff() calls in public/install/install.py.
MANIFEST_FILES = [
    "claude/settings.json",
    "codex/hooks.json",
    "vibemon/config.example.json",
    "vibemon/statusline.example.json",
    "vibemon/usage.py",
    "vibemon/usage_cache.py",
    "vibemon/account_context.py",
    "vibemon/cache_io.py",
    "vibemon/http_client.py",
    "vibemon/project_context.py",
    "vibemon/session_activity.py",
    "vibemon/vibemon_core.py",
    "claude/statusline.py",
    "claude/hooks/vibemon.py",
    "codex/hooks/vibemon.py",
    "kiro/hooks/vibemon.py",
    "kiro/hooks/vibemon.json",
    "openclaw/extensions/index.mjs",
    "openclaw/extensions/openclaw.plugin.json",
    "opencode/plugin/vibemon.js",
    "opencode/hooks/vibemon.py",
]


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_manifest() -> dict:
    return {
        "installer": file_sha256(DOCS_DIR / "install.py"),
        "files": {rel: file_sha256(DOCS_DIR / rel) for rel in MANIFEST_FILES},
    }


def main():
    manifest = build_manifest()
    # newline="": a CRLF manifest would not match the LF one CI publishes, so
    # regenerating on Windows must produce the same bytes as on Linux.
    with open(MANIFEST_PATH, "w", encoding="utf-8", newline="") as f:
        f.write(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {MANIFEST_PATH} ({len(manifest['files'])} files)")


if __name__ == "__main__":
    main()
