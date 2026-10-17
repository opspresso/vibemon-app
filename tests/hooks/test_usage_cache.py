import json
import tempfile
import unittest
from pathlib import Path

from usage_cache import (
    get_fresh_provider,
    reverse_jsonl,
    save_usage_cache,
    usage_from_rate_limits,
    week_bucket_key,
)


def cache_after(*writes, replace_last=False):
    """Apply each (updates, now) write to a new cache file and return its JSON."""
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "usage.json")
        for index, (updates, now) in enumerate(writes):
            save_usage_cache(path, updates, now=now, replace=replace_last and index == len(writes) - 1)
        return json.loads(Path(path).read_text())


class UsageCacheTest(unittest.TestCase):
    def test_invalid_or_future_provider_timestamps_cannot_keep_usage_fresh(self):
        for observed_at in [float('nan'), float('inf'), 'NaN', 'Infinity', None, 'invalid', 131]:
            with self.subTest(observed_at=observed_at):
                cache = {'claude': {'updated_at': observed_at, 'session': {'pct': 42}}}
                self.assertIsNone(get_fresh_provider(cache, 'claude', 1800, now=100))

    def test_invalid_or_future_bucket_timestamps_do_not_hide_a_fresh_bucket(self):
        for observed_at in [float('nan'), float('inf'), 'NaN', 'Infinity', None, 'invalid', 131]:
            with self.subTest(observed_at=observed_at):
                cache = {'claude': {
                    'updated_at': 100,
                    'session': {'pct': 42, 'updated_at': observed_at},
                    'week_all': {'pct': 20, 'updated_at': 100},
                }}
                fresh = get_fresh_provider(cache, 'claude', 1800, now=100)
                self.assertNotIn('session', fresh)
                self.assertEqual(fresh['week_all']['pct'], 20)

    def test_large_session_history_is_read_from_a_bounded_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'session.jsonl'
            path.write_text(json.dumps({'old': 'x' * (2 * 1024 * 1024)}) + '\n' + json.dumps({'recent': True}) + '\n')
            self.assertEqual(list(reverse_jsonl(str(path))), [{'recent': True}])

    def test_invalid_rates_are_unknown_and_valid_zero_keeps_reset(self):
        usage = usage_from_rate_limits({
            "rate_limits": {
                "five_hour": {"used_percentage": 140, "resets_at": 2000},
                "seven_day": {"used_percentage": 0, "resets_at": "1970-01-01T01:00:00Z"},
            }
        })

        self.assertNotIn("session", usage)
        self.assertEqual(usage["week_all"], {"pct": 0, "resets_at": 3600.0})

    def test_week_bucket_key_slugs_labels(self):
        self.assertEqual(week_bucket_key("Fable"), "week_fable")
        self.assertEqual(week_bucket_key("Sonnet only"), "week_sonnet")
        self.assertIsNone(week_bucket_key("all models"))
        self.assertIsNone(week_bucket_key(""))
        self.assertIsNone(week_bucket_key(None))

    def test_model_scoped_bucket_freshness_tracked_like_other_buckets(self):
        cache = cache_after(
            ({"claude": {"session": {"pct": 10, "resets_at": 1000}, "week_fable": {"pct": 12, "resets_at": 2000, "label": "Fable"}}}, 100),
            ({"claude": {"session": {"pct": 30, "resets_at": 1100}}}, 200),
        )

        self.assertEqual(cache["claude"]["week_fable"]["updated_at"], 100)
        self.assertEqual(cache["claude"]["week_fable"]["label"], "Fable")
        fresh = get_fresh_provider(cache, "claude", 150, now=225)
        self.assertEqual(fresh["week_fable"]["pct"], 12)
        stale = get_fresh_provider(cache, "claude", 50, now=225)
        self.assertNotIn("week_fable", stale)

    def test_republishing_a_session_snapshot_preserves_observation_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'usage.json')
            self.assertTrue(save_usage_cache(path, {'codex': {'updated_at': 100, 'session': {'pct': 42}}}, now=1800))
            cache = json.loads(Path(path).read_text())
            self.assertEqual(cache['codex']['session']['updated_at'], 100)
            self.assertIsNone(get_fresh_provider(cache, 'codex', 1800, now=1901))

    def test_provider_timestamps_are_independent(self):
        cache = cache_after(
            ({"claude": {"session": {"pct": 10}}}, 100),
            ({"codex": {"session": {"pct": 20}}}, 200),
        )

        self.assertEqual(cache["claude"]["updated_at"], 100)
        self.assertEqual(cache["codex"]["updated_at"], 200)
        self.assertIsNone(get_fresh_provider(cache, "claude", 50, now=200))
        self.assertEqual(
            get_fresh_provider(cache, "codex", 50, now=200)["session"]["pct"],
            20,
        )

    def test_legacy_global_timestamp_remains_readable(self):
        cache = {"ts": 100, "claude": {"session": {"pct": 10}}}

        self.assertIsNotNone(get_fresh_provider(cache, "claude", 10, now=105))
        self.assertIsNone(get_fresh_provider(cache, "claude", 10, now=111))

    def test_partial_provider_updates_preserve_bucket_freshness(self):
        cache = cache_after(
            ({"claude": {"session": {"pct": 10, "resets_at": 1000}, "week_all": {"pct": 20, "resets_at": 2000}}}, 100),
            ({"claude": {"session": {"pct": 30, "resets_at": 1100}}}, 200),
        )

        self.assertEqual(cache["claude"]["session"]["updated_at"], 200)
        self.assertEqual(cache["claude"]["week_all"]["updated_at"], 100)
        fresh = get_fresh_provider(cache, "claude", 50, now=225)
        self.assertEqual(fresh["session"]["pct"], 30)
        self.assertNotIn("week_all", fresh)

    def test_bucket_expires_at_its_reset_time(self):
        cache = {
            "claude": {
                "updated_at": 100,
                "session": {"pct": 95, "resets_at": 110, "updated_at": 100},
                "week_all": {"pct": 20, "resets_at": 1000, "updated_at": 100},
            }
        }

        before = get_fresh_provider(cache, "claude", 50, now=109)
        after = get_fresh_provider(cache, "claude", 50, now=110)

        self.assertIn("session", before)
        self.assertNotIn("session", after)
        self.assertIn("week_all", after)

    def test_replace_mode_drops_buckets_missing_from_the_update(self):
        # A full-view refresh that no longer reports week_fable must remove
        # it — otherwise it lingers stale and forces a refresh on every run.
        cache = cache_after(
            ({"claude": {"session": {"pct": 10, "resets_at": 10000}, "week_fable": {"pct": 12, "resets_at": 20000, "label": "Fable"}}}, 100),
            ({"claude": {"session": {"pct": 30, "resets_at": 11000}, "week_all": {"pct": 7, "resets_at": 20000}}}, 200),
            replace_last=True,
        )

        self.assertNotIn("week_fable", cache["claude"])
        self.assertEqual(cache["claude"]["session"]["pct"], 30)
        self.assertEqual(cache["claude"]["week_all"]["pct"], 7)

    def test_replace_mode_only_touches_updated_providers(self):
        cache = cache_after(
            ({"codex": {"week_all": {"pct": 42, "resets_at": 20000}}}, 100),
            ({"claude": {"session": {"pct": 10, "resets_at": 11000}}}, 200),
            replace_last=True,
        )

        self.assertEqual(cache["codex"]["week_all"]["pct"], 42)

    def test_expired_buckets_are_pruned_on_save(self):
        # Merge-mode writers (statusline) never mention week_fable, but an
        # expired bucket is dead weight the read path ignores — prune it so
        # the stale check can't force a refresh forever.
        cache = cache_after(
            ({"claude": {"session": {"pct": 10, "resets_at": 10000}, "week_fable": {"pct": 12, "resets_at": 2000, "label": "Fable"}}}, 100),
            ({"claude": {"session": {"pct": 30, "resets_at": 10000}}}, 2500),
        )

        self.assertNotIn("week_fable", cache["claude"])
        self.assertEqual(cache["claude"]["session"]["pct"], 30)
