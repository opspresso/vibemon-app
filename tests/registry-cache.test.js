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
  test.each([-1, 1.5, '1', null])('rejects invalid artwork revision %p', revision => {
    expect(sanitizeCharactersRegistry({ ...clone(bundledCharacters), revision })).toBeNull();
  });
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

  test('preserves the 3D theme so a refreshed cache keeps its palette', () => {
    const result = sanitizeCharactersRegistry(clone(bundledCharacters));
    for (const [name, entry] of Object.entries(bundledCharacters.characters)) {
      expect(result.characters[name].theme).toEqual(entry.theme);
    }
  });

  test('drops an incomplete or malformed theme but keeps the entry', () => {
    const json = clone(bundledCharacters);
    delete json.characters.vibemon.theme.flame;
    json.characters.clawd.theme.body = 'orange';
    json.characters.kiro.theme = 'white';
    const result = sanitizeCharactersRegistry(json);
    for (const name of ['vibemon', 'clawd', 'kiro']) {
      expect(result.characters[name]).toBeDefined();
      expect(result.characters[name].theme).toBeUndefined();
    }
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

  test('an upgrade replaces unversioned cached eye anchors with bundled artwork metadata', () => {
    const old = clone(bundledCharacters);
    delete old.revision;
    old.characters.vibemon.image = 'vibemon.png';
    old.characters.vibemon.eyes = { left: { x: 44, y: 52 }, right: { x: 76, y: 52 }, w: 8, h: 12 };
    fs.writeFileSync(path.join(tmpDir, 'characters.json'), JSON.stringify(old));
    const registry = loadWithCacheDir(tmpDir).charactersRegistry;
    expect(registry.characters.vibemon.image).toBe('vibemon-v2.png');
    expect(registry.characters.vibemon.eyes.left).toEqual({ x: 39, y: 60 });
  });

  test('retains a newer valid cached registry', () => {
    const next = clone(bundledCharacters);
    next.revision += 1;
    next.characters.vibemon.displayName = 'Updated companion';
    fs.writeFileSync(path.join(tmpDir, 'characters.json'), JSON.stringify(next));
    expect(loadWithCacheDir(tmpDir).charactersRegistry).toEqual(next);
  });

  test.each([[2, 0], [2, 1], [null, 0]])('refresh updates states while preserving artwork at revision %s against %s', async (cachedRevision, revision) => {
    const current = clone(bundledCharacters);
    if (cachedRevision !== null) current.revision = cachedRevision;
    const file = path.join(tmpDir, 'characters.json');
    if (cachedRevision !== null) fs.writeFileSync(file, JSON.stringify(current));
    const states = clone(bundledStates);
    states.states.idle.text = 'Standby';
    const originalFetch = global.fetch;
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      global.fetch = jest.fn(async url => new global.Response(JSON.stringify(url.endsWith('/states.json') ? states : { ...bundledCharacters, revision })));
      expect(await loadWithCacheDir(tmpDir).refresh()).toBe(true);
      jest.resetModules();
      const refreshed = loadWithCacheDir(tmpDir);
      expect(refreshed.statesRegistry.states.idle.text).toBe('Standby');
      expect(refreshed.charactersRegistry).toEqual(current);
      if (cachedRevision === null) expect(fs.existsSync(file)).toBe(false);
      else expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(current);
    } finally { global.fetch = originalFetch; warning.mockRestore(); }
  });

  test('falls back to bundled data when the cached copy is invalid', () => {
    fs.writeFileSync(path.join(tmpDir, 'states.json'), '{"states":{}}');
    fs.writeFileSync(path.join(tmpDir, 'characters.json'), 'not json');

    const registryCache = loadWithCacheDir(tmpDir);
    expect(registryCache.statesRegistry).toEqual(bundledStates);
    expect(registryCache.charactersRegistry).toEqual(bundledCharacters);
  });
});


test.each(['constructor', '__proto__'])('requires an own default character entry: %s', name => {
  expect(sanitizeCharactersRegistry({ default: name, characters: {} })).toBeNull();
});


test('keeps cached registries when a remote payload exceeds the size limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-registry-size-'));
  const originalFetch = global.fetch;
  const originalDir = process.env.VIBEMON_REGISTRY_CACHE_DIR;
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    process.env.VIBEMON_REGISTRY_CACHE_DIR = dir;
    const file = path.join(dir, 'states.json');
    fs.writeFileSync(file, JSON.stringify(bundledStates));
    const original = fs.readFileSync(file, 'utf8');
    global.fetch = jest.fn().mockImplementation(async () => new global.Response(JSON.stringify({
      ...bundledStates, padding: 'x'.repeat(65536)
    })));
    expect(await require('../src/shared/registry-cache.cjs').refresh()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  } finally {
    global.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.VIBEMON_REGISTRY_CACHE_DIR;
    else process.env.VIBEMON_REGISTRY_CACHE_DIR = originalDir;
    warning.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
