"""Local identity registry adapter. Stores public metadata and profile paths, never credentials."""
from __future__ import annotations

import json
from pathlib import Path
from account_sources import read_json
from cache_io import update_json_cache


def normalize(value) -> dict:
    if not isinstance(value, dict) or value.get('version') != 1:
        return {'version': 1, 'profiles': {}, 'sessions': {}}
    return {'version': 1, **{key: value[key] if isinstance(value.get(key), dict) else {} for key in ['profiles', 'sessions']}}


class JsonAccountStore:
    def __init__(self, path: str):
        self.path = path

    def read(self) -> dict:
        value = read_json(Path(self.path), maximum=4 * 1024 * 1024)
        return normalize(value)

    def update(self, change) -> None:
        def apply(value):
            current = normalize(value)
            result = change(current)
            if len(json.dumps(result, allow_nan=False).encode()) > 4 * 1024 * 1024:
                raise ValueError('Local account registry is full')
            return result
        if not update_json_cache(self.path, apply):
            raise OSError('Could not save the local account identity')
