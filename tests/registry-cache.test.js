/**
 * Tests for src/shared/registry-cache.cjs — remote registry validation/
 * sanitization and the cache → bundled fallback resolution.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const bundledStates = require('../src/shared/data/states.json');
const bundledCharacters = require('../src/shared/data/characters.json');

const {
  sanitizeStatesRegistry,
  sanitizeCharactersRegistry
} = require('../src/shared/registry-cache.cjs');

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

describe('sanitizeStatesRegistry', () => {
  test('accepts the bundled registry unchanged', () => {
    expect(sanitizeStatesRegistry(clone(bundledStates))).toEqual(bundledStates);
  });

  test('rejects non-object payloads', () => {
    expect(sanitizeStatesRegistry(null)).toBeNull();
    expect(sanitizeStatesRegistry('states')).toBeNull();
    expect(sanitizeStatesRegistry({})).toBeNull();
  });

  test('rejects a payload missing a bundled state (superset rule)', () => {
    const json = clone(bundledStates);
    delete json.states.idle;
    expect(sanitizeStatesRegistry(json)).toBeNull();
  });

  test('rejects a payload corrupting a bundled state', () => {
    const json = clone(bundledStates);
    json.states.alert.color = 'red';
    expect(sanitizeStatesRegistry(json)).toBeNull();
  });

  test('clamps unknown eyeType/effect to engine-safe values', () => {
    const json = clone(bundledStates);
    json.states.extra = {
      color: '#123456', text: 'Extra', active: true, loading: false,
      eyeType: 'laser', effect: 'fireworks'
    };
    const result = sanitizeStatesRegistry(json);
    expect(result.states.extra.eyeType).toBe('normal');
    expect(result.states.extra.effect).toBe('none');
  });

  test('drops invalid extra states but keeps the rest', () => {
    const json = clone(bundledStates);
    json.states['bad name!'] = bundledStates.states.idle;
    json.states.extra = { color: 'nope' };
    const result = sanitizeStatesRegistry(json);
    expect(result).not.toBeNull();
    expect(result.states['bad name!']).toBeUndefined();
    expect(result.states.extra).toBeUndefined();
    expect(Object.keys(result.states)).toEqual(Object.keys(bundledStates.states));
  });
});

describe('sanitizeCharactersRegistry', () => {
  test('accepts the bundled registry unchanged', () => {
    expect(sanitizeCharactersRegistry(clone(bundledCharacters))).toEqual(bundledCharacters);
  });

  test('rejects a payload whose default is missing or invalid', () => {
    const json = clone(bundledCharacters);
    json.default = 'ghost';
    expect(sanitizeCharactersRegistry(json)).toBeNull();

    const json2 = clone(bundledCharacters);
    delete json2.default;
    expect(sanitizeCharactersRegistry(json2)).toBeNull();
  });

  test('drops entries with unsafe names or image filenames', () => {
    const json = clone(bundledCharacters);
    json.characters['Bad Name'] = clone(bundledCharacters.characters.vibemon);
    json.characters.evil = {
      ...clone(bundledCharacters.characters.vibemon),
      image: 'https://evil.example/x.png'
    };
    const result = sanitizeCharactersRegistry(json);
    expect(result.characters['Bad Name']).toBeUndefined();
    expect(result.characters.evil).toBeUndefined();
    expect(Object.keys(result.characters)).toEqual(Object.keys(bundledCharacters.characters));
  });

  test('allows removing a non-default character (no superset rule)', () => {
    const json = clone(bundledCharacters);
    delete json.characters.daangni;
    const result = sanitizeCharactersRegistry(json);
    expect(result).not.toBeNull();
    expect(result.characters.daangni).toBeUndefined();
  });

  test('passes valid optional eyeColor/glassesColor through and drops invalid ones', () => {
    const json = clone(bundledCharacters);
    json.characters.vibemon.eyeColor = '#ECF8FC';
    json.characters.vibemon.glassesColor = '#ECF8FC';
    json.characters.clawd.eyeColor = 'white';
    json.characters.clawd.glassesColor = 'silver';
    const result = sanitizeCharactersRegistry(json);
    expect(result.characters.vibemon.eyeColor).toBe('#ECF8FC');
    expect(result.characters.vibemon.glassesColor).toBe('#ECF8FC');
    expect(result.characters.clawd.eyeColor).toBeUndefined();
    expect(result.characters.clawd.glassesColor).toBeUndefined();
  });

  test('drops entries with out-of-range eye/effect anchors', () => {
    const json = clone(bundledCharacters);
    json.characters.offcanvas = {
      ...clone(bundledCharacters.characters.vibemon),
      eyes: { left: { x: 999, y: 52 }, right: { x: 76, y: 52 }, w: 8, h: 12 }
    };
    const result = sanitizeCharactersRegistry(json);
    expect(result.characters.offcanvas).toBeUndefined();
  });
});

describe('loadRegistries (cache → bundled fallback)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-registry-'));
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.VIBEMON_REGISTRY_CACHE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  });

  function loadWithCacheDir(dir) {
    process.env.VIBEMON_REGISTRY_CACHE_DIR = dir;
    return require('../src/shared/registry-cache.cjs');
  }

  test('uses a valid cached registry over the bundled one', () => {
    const cached = clone(bundledStates);
    cached.states.idle.text = 'Standby';
    fs.writeFileSync(path.join(tmpDir, 'states.json'), JSON.stringify(cached));

    const registryCache = loadWithCacheDir(tmpDir);
    expect(registryCache.statesRegistry.states.idle.text).toBe('Standby');
    // No cached characters file -> bundled fallback
    expect(registryCache.charactersRegistry).toEqual(bundledCharacters);
  });

  test('falls back to bundled data when the cached copy is invalid', () => {
    fs.writeFileSync(path.join(tmpDir, 'states.json'), '{"states":{}}');
    fs.writeFileSync(path.join(tmpDir, 'characters.json'), 'not json');

    const registryCache = loadWithCacheDir(tmpDir);
    expect(registryCache.statesRegistry).toEqual(bundledStates);
    expect(registryCache.charactersRegistry).toEqual(bundledCharacters);
  });
});
