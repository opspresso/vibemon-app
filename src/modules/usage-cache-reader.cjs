/**
 * Reads the shared plan-usage cache (~/.vibemon/cache/usage.json) that
 * ~/.vibemon/usage.py and the AI-tool hooks/statuslines refresh under the
 * "claude"/"codex" keys. This mirrors usage_cache.py's get_fresh_provider()
 * staleness rules in JS, so the workspace can show Claude and Codex usage
 * together — independent of which project (if any) is currently focused,
 * and without a stale % lingering once its window has expired.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAccountProfiles, readLocalJson } = require('./account-profiles.cjs');
const { expandHome } = require('../shared/home-path.cjs');
const { USAGE_CACHE_STALE_SECONDS } = require('../shared/config.cjs');

const VIBEMON_CONFIG_PATH = path.join(os.homedir(), '.vibemon', 'config.json');
const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.vibemon', 'cache', 'projects.json');

/**
 * Resolve ~/.vibemon/cache/usage.json, honoring config.json's cache_path
 * (same directory-sibling logic as usage.py's get_usage_cache_path()).
 * @returns {string}
 */
function getUsageCachePath() {
  if (process.env.VIBEMON_CACHE_PATH?.trim()) return path.join(path.dirname(expandHome(process.env.VIBEMON_CACHE_PATH.trim())), 'usage.json');
  let projectsCachePath = DEFAULT_CACHE_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(VIBEMON_CONFIG_PATH, 'utf8'));
    if (raw && typeof raw.cache_path === 'string' && raw.cache_path) {
      projectsCachePath = expandHome(raw.cache_path);
    }
  } catch {
    // Missing/invalid config: fall back to the default cache path.
  }
  return path.join(path.dirname(projectsCachePath), 'usage.json');
}

/**
 * @returns {object|null} parsed cache, or null if missing/unreadable
 */
function readUsageCache(nowMs) {
  const paths = new Set([getUsageCachePath(), ...getAccountProfiles().flatMap(profile => profile.cachePath ? [path.join(path.dirname(profile.cachePath), 'usage.json')] : [])]);
  const merged = {};
  for (const filename of paths) {
    const data = readLocalJson(filename);
    for (const [key, value] of Object.entries(data || {})) {
      if (!/^(claude|codex)(:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})?$/.test(key) || !value || typeof value !== 'object') continue;
      const at = Number(value.updated_at ?? data.ts ?? 0);
      if (!Number.isFinite(at) || at <= 0 || at * 1000 > nowMs + 30000) continue;
      const previous = merged[key] || {};
      const next = at >= (previous.updated_at || 0) ? { ...previous, account: value.account || previous.account, updated_at: at } : { ...previous };
      for (const [name, bucket] of Object.entries(value)) {
        if (!bucket || typeof bucket !== 'object' || !(name === 'session' || name.startsWith('week_'))) continue;
        const observed = Number(bucket.updated_at ?? at);
        if (!Number.isFinite(observed) || observed <= 0 || observed * 1000 > nowMs + 30000) continue;
        if (!next[name] || observed >= next[name].updated_at) next[name] = { ...bucket, updated_at: observed };
      }
      merged[key] = next;
    }
  }
  return merged;
}

/**
 * Freshness-filtered {pct, resetsAt} for one provider's bucket, or null if
 * the provider/bucket is missing, its updated_at is older than
 * USAGE_CACHE_STALE_SECONDS, or its reset window has already passed.
 * @param {object|null} cache
 * @param {string} provider - 'claude' | 'codex'
 * @param {string} bucketKey - 'session' | 'week_all'
 * @param {number} nowMs
 * @returns {{pct: number, resetsAt: number|null}|null}
 */
function getFreshBucket(cache, provider, bucketKey, nowMs) {
  if (!cache || typeof cache !== 'object') return null;
  const providerData = cache[provider];
  if (!providerData || typeof providerData !== 'object') return null;

  const providerUpdatedAt = Number(providerData.updated_at ?? cache.ts ?? 0);
  if (!Number.isFinite(providerUpdatedAt) || providerUpdatedAt <= 0 || providerUpdatedAt * 1000 > nowMs + 30000 || nowMs - providerUpdatedAt * 1000 > USAGE_CACHE_STALE_SECONDS * 1000) {
    return null;
  }

  const bucket = providerData[bucketKey];
  if (!bucket || typeof bucket !== 'object' || !Number.isFinite(bucket.pct) || bucket.pct < 0 || bucket.pct > 100) return null;

  const bucketUpdatedAt = Number(bucket.updated_at ?? providerUpdatedAt);
  if (!Number.isFinite(bucketUpdatedAt) || bucketUpdatedAt <= 0 || bucketUpdatedAt * 1000 > nowMs + 30000 || nowMs - bucketUpdatedAt * 1000 > USAGE_CACHE_STALE_SECONDS * 1000) {
    return null;
  }

  const resetsAt = Number.isFinite(bucket.resets_at) ? bucket.resets_at : null;
  if (resetsAt !== null && resetsAt * 1000 <= nowMs) {
    return null;
  }

  return { pct: bucket.pct, resetsAt };
}

/**
 * Freshness-filtered model-scoped weekly bucket (any "week_*" key other than
 * "week_all", e.g. "week_fable") for one provider — the one with the highest
 * pct when several exist, since that's the binding limit. Mirrors
 * usage_cache.py's model_week_bucket().
 * @param {object|null} cache
 * @param {string} provider - 'claude' | 'codex'
 * @param {number} nowMs
 * @returns {{pct: number, resetsAt: number|null, label: string}|null}
 */
function getFreshModelWeekBucket(cache, provider, nowMs) {
  const providerData = cache && typeof cache === 'object' ? cache[provider] : null;
  if (!providerData || typeof providerData !== 'object') return null;

  let best = null;
  for (const key of Object.keys(providerData)) {
    if (!key.startsWith('week_') || key === 'week_all') continue;
    const fresh = getFreshBucket(cache, provider, key, nowMs);
    if (!fresh) continue;
    if (!best || fresh.pct > best.pct) {
      const rawLabel = providerData[key] && providerData[key].label;
      const label = typeof rawLabel === 'string' && rawLabel
        ? rawLabel
        : key.slice('week_'.length).replace(/^./, (c) => c.toUpperCase());
      best = { ...fresh, label };
    }
  }
  return best;
}

/**
 * @param {number} [nowMs]
 * @returns {{
 *   claude: {session: {pct, resetsAt}|null, week: {pct, resetsAt}|null,
 *            modelWeek: {pct, resetsAt, label}|null},
 *   codex:  {session: {pct, resetsAt}|null, week: {pct, resetsAt}|null,
 *            modelWeek: {pct, resetsAt, label}|null}
 * }}
 */
function getUsageSnapshot(nowMs = Date.now()) {
  const cache = readUsageCache(nowMs);
  const keys = new Set(['claude', 'codex', ...Object.keys(cache || {}).filter(key => /^(claude|codex):[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(key))]);
  return Object.fromEntries([...keys].map(key => {
    const account = cache?.[key]?.account;
    const buckets = {
      session: getFreshBucket(cache, key, 'session', nowMs),
      week: getFreshBucket(cache, key, 'week_all', nowMs),
      modelWeek: getFreshModelWeekBucket(cache, key, nowMs)
    };
    if (account && `${account.provider}:${account.id}` === key && typeof account.displayName === 'string' &&
        account.displayName.trim() && account.displayName.length <= 128) {
      buckets.account = { provider: account.provider, id: account.id, displayName: account.displayName };
    }
    return [key, buckets];
  }));
}

module.exports = { getUsageCachePath, getUsageSnapshot };
