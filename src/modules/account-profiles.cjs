/** Read-only view of the Python-owned identity registry. Provider credentials never enter IPC. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validAccountId } = require('../monitoring/domain.cjs');
const { providers } = require('../shared/data/monitoring.json');

const REGISTRY_PATH = path.join(os.homedir(), '.vibemon', 'accounts.json');
const PROVIDERS = new Set(providers.map(provider => provider.id));
const KINDS = new Set(['account', 'credential', 'profile', 'manual']);
const snapshots = new Map();
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function readLocalJson(filename, maximum = 4 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filename);
    if (stat && stat.size > maximum) return null;
    const signature = stat && Number.isFinite(stat.mtimeMs) && Number.isFinite(stat.size) ? `${stat.mtimeMs}:${stat.size}` : null;
    if (signature && snapshots.get(filename)?.signature === signature) return snapshots.get(filename).value;
    const raw = fs.readFileSync(filename, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > maximum) return null;
    const value = JSON.parse(raw);
    if (!plain(value)) return null;
    if (signature) {
      if (snapshots.size >= 128 && !snapshots.has(filename)) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(filename, { signature, value });
    }
    return value;
  } catch {
    snapshots.delete(filename);
    return null;
  }
}

function getAccountProfiles() {
  const data = readLocalJson(REGISTRY_PATH);
  if (data?.version !== 1 || !plain(data.profiles)) return [];
  return Object.entries(data.profiles).flatMap(([key, entry]) => {
    const account = entry?.account;
    if (!/^[a-f0-9]{64}$/.test(key) || !plain(entry) || !PROVIDERS.has(entry.provider) ||
        !text(entry.root, 32768) || !path.isAbsolute(entry.root) || !text(entry.instance, 512) ||
        !plain(account) || account.provider !== entry.provider || !validAccountId(`${account.provider}:${account.id}`) ||
        !text(account.displayName, 128) || !KINDS.has(account.kind)) return [];
    const attempt = data.refreshAttempts?.[key];
    return [{ key, provider: entry.provider, root: entry.root, instance: entry.instance,
      context: text(entry.context, 256) ? entry.context : '',
      account: { id: account.id, provider: account.provider, displayName: account.displayName, kind: account.kind },
      checkedAt: Number.isFinite(entry.checkedAt) ? entry.checkedAt : null,
      usageCheckedAt: Number.isFinite(attempt?.at) ? attempt.at : null,
      usageRefreshFailed: attempt?.ok === false,
      cachePath: text(entry.cachePath, 32768) && path.isAbsolute(entry.cachePath) ? entry.cachePath : null
    }];
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.account.displayName.localeCompare(b.account.displayName));
}

module.exports = { getAccountProfiles, readLocalJson, REGISTRY_PATH };
