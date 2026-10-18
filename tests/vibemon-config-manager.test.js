/**
 * Tests for vibemon-config-manager.cjs
 */

jest.mock('fs');
jest.mock('../src/shared/config.cjs', () => ({
  HTTP_PORT: 19280
}));

const fs = require('fs');
const { VibemonConfigManager, VIBEMON_CONFIG_DEFAULTS } = require('../src/modules/vibemon-config-manager.cjs');

describe('VibemonConfigManager', () => {
  let manager;

  beforeEach(() => {
    fs.existsSync.mockReset().mockReturnValue(false);
    fs.readFileSync.mockReset();
    fs.writeFileSync.mockReset();
    fs.mkdirSync.mockReset();
    fs.mkdtempSync.mockReset().mockImplementation(prefix => `${prefix}fixture`);
    fs.rmSync.mockReset();
    fs.copyFileSync.mockReset();
    fs.chmodSync.mockReset();
    manager = new VibemonConfigManager();
  });

  describe('getStatus', () => {
    test('reports missing when the file does not exist', () => {
      expect(manager.getStatus()).toEqual({ exists: false, hasDesktopUrl: false });
    });

    test('reports hasDesktopUrl true when http_urls includes this app', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://127.0.0.1:19280'] }));

      expect(manager.getStatus()).toEqual({ exists: true, hasDesktopUrl: true });
    });

    test('reports hasDesktopUrl false when http_urls is empty', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: [] }));

      expect(manager.getStatus().hasDesktopUrl).toBe(false);
    });

    test('reports malformed JSON separately from a missing configuration', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{not json');

      expect(manager.getStatus()).toEqual({ exists: true, hasDesktopUrl: false, error: 'Fix ~/.vibemon/config.json: expected a valid JSON object.' });
    });
  });

  test.each(['null', '[]', '42', '{invalid'])('preserves malformed configuration instead of overwriting it: %s', body => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(body);
    expect(manager.getStatus()).toEqual({ exists: true, hasDesktopUrl: false, error: 'Fix ~/.vibemon/config.json: expected a valid JSON object.' });
    expect(() => manager.write({ debug: true })).toThrow('expected a valid JSON object');
    expect(manager.ensureDesktopUrl()).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  describe('read', () => {
    test('repairing a malformed destination list preserves its valid addresses', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://existing:19280', null] }));
      expect(manager.getStatus().error).toContain('http_urls');
      expect(manager.addHttpUrl('http://new:19280').http_urls).toEqual(['http://existing:19280', 'http://new:19280']);
    });
    test('invalid field types stay on disk but cannot break the settings renderer', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: null, debug: 'false', vibemon_token: 'preserved-secret', custom: 'preserved' }));
      expect(manager.read()).toEqual({ ...VIBEMON_CONFIG_DEFAULTS, vibemon_token: 'preserved-secret', custom: 'preserved' });
      expect(manager.getStatus().error).toContain('debug, http_urls');
      expect(manager.getStatus().error).not.toContain('preserved-secret');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      const corrected = manager.addHttpUrl('http://localhost:19280');
      expect(corrected.http_urls).toEqual(['http://localhost:19280']);
      expect(corrected.vibemon_token).toBe('preserved-secret');
      expect(corrected.custom).toBe('preserved');
    });
    test('returns defaults when the file does not exist', () => {
      expect(manager.read()).toEqual(VIBEMON_CONFIG_DEFAULTS);
    });

    test('merges file contents over defaults', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ debug: true, vibemon_token: 'tok' }));

      expect(manager.read()).toEqual({ ...VIBEMON_CONFIG_DEFAULTS, debug: true, vibemon_token: 'tok' });
    });

    test('falls back to defaults when the file has invalid JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{not json');

      expect(manager.read()).toEqual(VIBEMON_CONFIG_DEFAULTS);
    });
  });

  describe('write', () => {
    test('ignores unknown keys', () => {
      const result = manager.write({ not_a_real_field: 'x' });

      expect(result).toEqual(VIBEMON_CONFIG_DEFAULTS);
      expect(JSON.parse(fs.writeFileSync.mock.calls[0][1])).not.toHaveProperty('not_a_real_field');
    });

    test('coerces boolean fields', () => {
      const result = manager.write({ debug: 1, auto_launch: 0 });

      expect(result.debug).toBe(true);
      expect(result.auto_launch).toBe(false);
    });

    test('trims string fields', () => {
      const result = manager.write({ vibemon_url: ' https://x ', vibemon_token: ' tok ' });

      expect(result.vibemon_url).toBe('https://x');
      expect(result.vibemon_token).toBe('tok');
    });

    test('a cloud origin change cannot forward an existing token implicitly', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ vibemon_url: 'https://vibemon.io', vibemon_token: 'saved-token' }));
      expect(() => manager.write({ vibemon_url: 'https://other.example' })).toThrow('new write token');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(manager.write({ vibemon_url: 'https://other.example/', vibemon_token: 'replacement' }).vibemon_url).toBe('https://other.example');
    });

    test('converts an empty serial_port to null', () => {
      expect(manager.write({ serial_port: '/dev/cu.usbmodem1' }).serial_port).toBe('/dev/cu.usbmodem1');
      expect(manager.write({ serial_port: '   ' }).serial_port).toBeNull();
    });

    test('normalizes http_urls: trims, drops empties, dedupes', () => {
      const result = manager.write({ http_urls: [' http://a ', 'http://a', '', 'http://b'] });

      expect(result.http_urls).toEqual(['http://a', 'http://b']);
    });

    test('preserves existing fields not included in the partial update', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ debug: true, vibemon_token: 'existing' }));

      const result = manager.write({ auto_launch: true });

      expect(result.debug).toBe(true);
      expect(result.vibemon_token).toBe('existing');
      expect(result.auto_launch).toBe(true);
    });

    test('persists to ~/.vibemon/config.json', () => {
      manager.write({ debug: true });

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.vibemon'), { recursive: true, mode: 0o700 });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.config\.json-fixture[/\\]data$/),
        expect.stringContaining('"debug": true'),
        { mode: 0o600, flag: 'wx' }
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.config\.json-fixture[/\\]data$/),
        expect.stringMatching(/config\.json$/)
      );
    });

    test('restricts the config directory and file to owner-only permissions', () => {
      manager.write({ debug: true });

      if (process.platform !== 'win32') expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('.vibemon'), 0o700);
      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), { mode: 0o600, flag: 'wx' });
    });

    (process.platform === 'win32' ? test.skip : test)('reports a save failure when POSIX permissions cannot be restricted', () => {
      const log = jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.chmodSync.mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
      try {
        expect(() => manager.write({ debug: true })).toThrow('Unable to save ~/.vibemon/config.json');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      } finally { log.mockRestore(); }
    });
  });

  describe('addHttpUrl / removeHttpUrl', () => {
    test('addHttpUrl appends to the current on-disk list, not a stale snapshot', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://a'] }));

      const result = manager.addHttpUrl('http://b');

      expect(result.http_urls).toEqual(['http://a', 'http://b']);
    });

    test('addHttpUrl normalizes like write() (trims, dedupes)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://a'] }));

      expect(manager.addHttpUrl(' http://a ').http_urls).toEqual(['http://a']);
    });

    test('removeHttpUrl removes only the given URL from the current on-disk list', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://a', 'http://b'] }));

      const result = manager.removeHttpUrl('http://a');

      expect(result.http_urls).toEqual(['http://b']);
    });

    test('removeHttpUrl is a no-op when the URL is not present', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://a'] }));

      expect(manager.removeHttpUrl('http://missing').http_urls).toEqual(['http://a']);
    });
  });

  describe('ensureDesktopUrl', () => {
    test('does nothing when already configured', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ http_urls: ['http://127.0.0.1:19280'] }));

      expect(manager.ensureDesktopUrl()).toBe(false);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('creates a new config with defaults when missing', () => {
      expect(manager.ensureDesktopUrl()).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.vibemon'), { recursive: true, mode: 0o700 });

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.http_urls).toEqual(['http://127.0.0.1:19280']);
      expect(written.vibemon_token).toBe('');
      expect(written.vibemon_url).toBe('https://vibemon.io');
    });

    test('preserves existing fields and only appends the desktop URL', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        http_urls: ['http://192.168.1.50:8080'],
        vibemon_token: 'existing_token',
        debug: true
      }));

      expect(manager.ensureDesktopUrl()).toBe(true);

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.http_urls).toEqual(['http://192.168.1.50:8080', 'http://127.0.0.1:19280']);
      expect(written.vibemon_token).toBe('existing_token');
      expect(written.debug).toBe(true);
    });

    test('leaves the file untouched when it has invalid JSON', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{not json');

      expect(manager.ensureDesktopUrl()).toBe(false);

      expect(fs.copyFileSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });

  });

  describe('persist', () => {
    let consoleError;

    beforeEach(() => {
      fs.renameSync.mockReset();
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    test('returns true on a successful write', () => {
      expect(manager.persist({ debug: false })).toBe(true);
    });

    test('does not throw and returns false when the write fails', () => {
      fs.renameSync.mockImplementation(() => { throw new Error('EACCES'); });

      expect(() => manager.persist({ debug: false })).not.toThrow();
      expect(manager.persist({ debug: false })).toBe(false);
      expect(consoleError).toHaveBeenCalled();
    });

    test('write() reports failure when the underlying write fails', () => {
      fs.renameSync.mockImplementation(() => { throw new Error('EACCES'); });

      expect(() => manager.write({ debug: true })).toThrow('Unable to save');
      expect(manager.ensureDesktopUrl()).toBe(false);
    });
  });
});
