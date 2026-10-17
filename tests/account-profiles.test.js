const os = require('os');
const path = require('path');
jest.mock('fs');
const fs = require('fs');
const { getAccountProfiles, readLocalJson, REGISTRY_PATH } = require('../src/modules/account-profiles.cjs');

beforeEach(() => { fs.statSync.mockReset(); fs.readFileSync.mockReset(); });

test('the profile DTO validates records and never exposes credentials or session metadata', () => {
  const key = 'a'.repeat(64);
  const profile = { provider: 'codex', root: os.homedir(), instance: 'desktop', account: {
    provider: 'codex', id: 'auto:fixture', displayName: 'Work', kind: 'account', token: 'private'
  }, token: 'private', cachePath: path.join(os.homedir(), 'cache/projects.json') };
  fs.readFileSync.mockReturnValue(JSON.stringify({ version: 1, profiles: {
    [key]: profile, ['b'.repeat(64)]: { ...profile, root: '../relative' }, ['c'.repeat(64)]: { ...profile, account: { ...profile.account, provider: 'claude' } }
  }, refreshAttempts: { [key]: { at: 100, ok: false } }, sessions: { private: {} } }));
  const result = getAccountProfiles();
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ key, account: { displayName: 'Work', kind: 'account' }, usageRefreshFailed: true });
  expect(JSON.stringify(result)).not.toContain('private');
});

test('unchanged files are read once and an atomic replacement invalidates the snapshot', () => {
  fs.statSync.mockReturnValue({ mtimeMs: 100, size: 10 });
  fs.readFileSync.mockReturnValue('{"v":1}');
  expect(readLocalJson('/fixture/cache.json')).toEqual({ v: 1 });
  expect(readLocalJson('/fixture/cache.json')).toEqual({ v: 1 });
  expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  fs.statSync.mockReturnValue({ mtimeMs: 101, size: 10 });
  fs.readFileSync.mockReturnValue('{"v":2}');
  expect(readLocalJson('/fixture/cache.json')).toEqual({ v: 2 });
});

test('oversized or malformed registries do not enter the renderer', () => {
  fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 });
  expect(getAccountProfiles()).toEqual([]);
  expect(fs.readFileSync).not.toHaveBeenCalled();
  fs.statSync.mockReturnValue(undefined);
  fs.readFileSync.mockReturnValue('[]');
  expect(readLocalJson(REGISTRY_PATH)).toBeNull();
});
