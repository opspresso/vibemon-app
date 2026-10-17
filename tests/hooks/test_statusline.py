import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import statusline


class StatuslineCacheTest(unittest.TestCase):
    def test_non_object_configuration_does_not_disable_statusline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.vibemon').mkdir()
            for filename in ['config.json', 'statusline.json']:
                for value in [[], None, 'invalid', 42, True]:
                    with self.subTest(filename=filename, value=value):
                        config = root / '.vibemon' / filename
                        config.write_text(json.dumps(value))
                        with patch.object(statusline.Path, 'home', return_value=root), patch.dict(os.environ, {}, clear=True):
                            statusline.load_config()
                        config.unlink()

    def test_rendered_usage_obeys_cache_age_and_reset_time(self):
        for observed_at, resets_at, visible in [(100, 3000, False), (2000, 3000, True), (2000, 1999, False)]:
            with self.subTest(observed_at=observed_at, resets_at=resets_at):
                cache = {'claude': {'updated_at': observed_at, 'session': {'pct': 0, 'resets_at': resets_at}}}
                output = io.StringIO()
                with (
                    patch.dict(os.environ, {'VIBEMON_ACCOUNT_ID': 'default', 'HOME': str(Path.home()), 'USERPROFILE': str(Path.home())}, clear=True),
                    patch.object(statusline, 'read_input', return_value='{}'),
                    patch.object(statusline, 'load_usage_cache', return_value=cache),
                    patch.object(statusline, 'save_cache_background'),
                    patch.object(statusline.time, 'time', return_value=2000),
                    patch.object(statusline, 'SHOW_USAGE', True),
                    patch.object(statusline, 'SHOW_STATUSLINE', True),
                    patch.object(sys, 'stdout', output),
                ):
                    statusline.main()
                self.assertEqual('📊' in output.getvalue(), visible)
                self.assertIn('Claude', output.getvalue())

    def test_save_to_cache_writes_project_memory_over_any_previous_content(self):
        for previous in [None, "[]"]:
            with self.subTest(previous=previous), tempfile.TemporaryDirectory() as directory:
                cache_path = Path(directory) / "projects.json"
                if previous is not None:
                    cache_path.write_text(previous)
                with patch.dict(os.environ, {"VIBEMON_CACHE_PATH": str(cache_path)}):
                    statusline.save_to_cache("my-project", "Fable 5", 42)
                entry = json.loads(cache_path.read_text())[statusline.project_cache_key("my-project")]
                self.assertEqual(entry["model"], "Fable 5")
                self.assertEqual(entry["memory"], 42)
                self.assertIn("ts", entry)

    def test_parse_json_non_object_yields_empty_dict(self):
        self.assertEqual(statusline.parse_json("[]"), {})
        self.assertEqual(statusline.parse_json('{"a": 1}'), {"a": 1})


class ReadInputTest(unittest.TestCase):
    def test_reads_payload_decoded_as_utf8(self):
        stdin = io.StringIO('{"model": {"display_name": "Claude 한국"}}')
        with patch.object(sys, "stdin", stdin):
            content = statusline.read_input()

        self.assertIn('"display_name": "Claude 한국"', content)


class UsageSegmentTest(unittest.TestCase):
    def test_usage_segment_includes_model_scoped_week_bar(self):
        segment = statusline.build_usage_segment({
            "session": {"pct": 5},
            "week_all": {"pct": 7},
            "week_fable": {"pct": 12, "label": "Fable"},
        })

        self.assertIn("S ", segment)
        self.assertIn("W ", segment)
        self.assertIn("F ", segment)

    def test_usage_segment_without_model_week_has_no_extra_bar(self):
        segment = statusline.build_usage_segment({
            "session": {"pct": 5},
            "week_all": {"pct": 7},
        })

        self.assertIn("S ", segment)
        self.assertIn("W ", segment)
        self.assertNotIn("F ", segment)
