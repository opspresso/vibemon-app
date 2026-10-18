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

    def test_invalid_reset_time_keeps_the_other_statusline_segments_and_cache(self):
        for reset in [float('nan'), float('inf'), 10 ** 400]:
            with self.subTest(reset=reset):
                cache = {'claude': {'updated_at': 2000, 'session': {'pct': 0, 'resets_at': reset}}}
                output = io.StringIO()
                with (
                    patch.object(statusline, 'load_usage_cache', return_value=cache),
                    patch.object(statusline, 'save_cache_background') as save,
                    patch.object(statusline.time, 'time', return_value=2000),
                    patch.object(statusline, 'SHOW_MODEL', True),
                    patch.object(statusline, 'SHOW_MEMORY', True),
                    patch.object(statusline, 'SHOW_USAGE', True),
                    patch.object(statusline, 'SHOW_USAGE_RESET', True),
                    patch.object(statusline, 'SHOW_STATUSLINE', True),
                    patch.object(sys, 'stdout', output),
                ):
                    statusline.render_statusline({'model': {'display_name': 'Claude Fable'}, 'context_window': {'used_percentage': 23}})
                self.assertIn('Fable', output.getvalue())
                self.assertIn('23%', output.getvalue())
                self.assertIn('0%', output.getvalue())
                self.assertNotIn('⏳', output.getvalue())
                self.assertEqual(save.call_args.args[2], 23)

    def test_parse_json_non_object_yields_empty_dict(self):
        self.assertEqual(statusline.parse_json("[]"), {})
        self.assertEqual(statusline.parse_json('{"a": 1}'), {"a": 1})


class ReadInputTest(unittest.TestCase):
    def test_reads_payload_decoded_as_utf8(self):
        stdin = io.StringIO('{"model": {"display_name": "Claude 한국"}}')
        with patch.object(sys, "stdin", stdin):
            content = statusline.read_input()

        self.assertIn('"display_name": "Claude 한국"', content)


class StatuslineFieldsTest(unittest.TestCase):
    def test_only_removed_lines_are_visible(self):
        with patch.object(statusline, 'SHOW_LINES', True):
            line = statusline.build_statusline('Claude', '', '', '', 0, 0, 0, 0, 0, 7)
        self.assertIn('-7', line)
        self.assertNotIn('+0', line)

    def test_output_tokens_remain_visible_with_zero_or_unknown_input(self):
        for input_tokens, expected in [(0, '0'), (None, '—'), ('invalid', '—')]:
            with self.subTest(input_tokens=input_tokens), patch.object(statusline, 'SHOW_TOKENS', True):
                line = statusline.build_statusline('Claude', '', '', '', input_tokens, 2000, 0, 0, 0, 0)
                self.assertIn(f'📥 {expected} 📤 2.0K', line)

    def test_invalid_quantities_are_unknown_instead_of_measured_zero(self):
        for value in [None, 'null', 'invalid', True, -1, float('nan'), float('inf'), 10 ** 400]:
            with self.subTest(value=value):
                self.assertEqual(statusline.format_number(value), '—')
                self.assertEqual(statusline.format_duration(value), '—')
                self.assertEqual(statusline.format_cost(value), '—')
        self.assertEqual(statusline.format_number(0), '0')
        self.assertEqual(statusline.format_duration(0), '0s')
        self.assertEqual(statusline.format_cost(0), '$0.00')

    def test_partial_measurements_do_not_erase_valid_model_context_and_output_tokens(self):
        output = io.StringIO()
        with (
            patch.multiple(statusline, SHOW_TOKENS=True, SHOW_COST=True, SHOW_DURATION=True,
                           SHOW_MODEL=True, SHOW_MEMORY=True, SHOW_STATUSLINE=True),
            patch.object(statusline, 'load_usage_cache', return_value=None),
            patch.object(statusline, 'save_cache_background') as save,
            patch.object(sys, 'stdout', output),
        ):
            statusline.render_statusline({
                'model': {'display_name': 'Claude Fable'},
                'context_window': {'used_percentage': 23, 'total_input_tokens': 10 ** 400, 'total_output_tokens': 2000},
                'cost': {'total_cost_usd': float('inf'), 'total_duration_ms': float('inf')},
            })
        self.assertIn('Fable', output.getvalue())
        self.assertIn('23%', output.getvalue())
        self.assertIn('📥 — 📤 2.0K', output.getvalue())
        self.assertIn('💰 —', output.getvalue())
        self.assertIn('⏱️ —', output.getvalue())
        self.assertEqual(save.call_args.args[2], 23)

    def test_malformed_optional_model_and_directory_do_not_erase_the_context(self):
        output = io.StringIO()
        with (
            patch.multiple(statusline, SHOW_MODEL=True, SHOW_MEMORY=True, SHOW_STATUSLINE=True),
            patch.object(statusline, 'load_usage_cache', return_value=None),
            patch.object(statusline, 'save_cache_background'),
            patch.object(sys, 'stdout', output),
        ):
            statusline.render_statusline({'model': {'display_name': None}, 'workspace': {'current_dir': ['invalid']},
                                         'context_window': {'used_percentage': 23}})
        self.assertIn('Claude', output.getvalue())
        self.assertIn('23%', output.getvalue())


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


class BarColorTest(unittest.TestCase):
    def test_tone_thresholds_are_inclusive_like_the_app(self):
        for percent, color in ((49, statusline.C_GREEN), (50, statusline.C_YELLOW), (70, statusline.C_ORANGE), (90, statusline.C_RED)):
            self.assertTrue(statusline.build_progress_bar(percent).startswith(color), percent)

