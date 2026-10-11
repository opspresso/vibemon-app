const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const fixtures = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibemon-registry-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  cpSync('scripts/check-registry.mjs', join(root, 'scripts/check-registry.mjs'));
  for (const directory of ['src/shared/data', 'src/assets/characters']) {
    mkdirSync(join(root, directory), { recursive: true });
    cpSync(directory, join(root, directory), { recursive: true });
  }
  return root;
}
function validate(root) { return spawnSync(process.execPath, [join(root, 'scripts/check-registry.mjs')]).status; }
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('accepts the complete published registry and image set', () => { expect(validate(fixture())).toBe(0); });
test('rejects empty state definitions', () => {
  const root = fixture();
  writeFileSync(join(root, 'src/shared/data/states.json'), '{"states":{}}');
  expect(validate(root)).toBe(1);
});
test('rejects a missing character map or inherited default', () => {
  const root = fixture(); const path = join(root, 'src/shared/data/characters.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...original, default: 'constructor' }));
  expect(validate(root)).toBe(1);
  writeFileSync(path, '{"default":"vibemon"}');
  expect(validate(root)).toBe(1);
});
test('rejects an invalid character image instead of publishing an unusable asset', () => {
  const root = fixture();
  const registry = JSON.parse(readFileSync(join(root, 'src/shared/data/characters.json'), 'utf8'));
  writeFileSync(join(root, 'src/assets/characters', registry.characters.vibemon.image), 'invalid image');
  expect(validate(root)).toBe(1);
});
