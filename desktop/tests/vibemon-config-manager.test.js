/**
 * Tests for vibemon-config-manager.cjs
 */

jest.mock('fs');
jest.mock('../shared/config.cjs', () => ({
  HTTP_PORT: 19280
}));

const fs = require('fs');
const { VibemonConfigManager, VIBEMON_CONFIG_DEFAULTS } = require('../modules/vibemon-config-manager.cjs');

describe('VibemonConfigManager', () => {
  let manager;

  beforeEach(() => {
    fs.existsSync.mockReset().mockReturnValue(false);
    fs.readFileSync.mockReset();
    fs.writeFileSync.mockReset();
    fs.mkdirSync.mockReset();
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

    test('treats invalid JSON as existing but unconfigured', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{not json');

      expect(manager.getStatus()).toEqual({ exists: true, hasDesktopUrl: false });
    });
  });

  describe('read', () => {
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

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.vibemon'), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.vibemon'),
        expect.stringContaining('"debug": true')
      );
    });

    test('restricts the config directory and file to owner-only permissions', () => {
      manager.write({ debug: true });

      expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('.vibemon'), 0o700);
      expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('config.json'), 0o600);
    });

    test('does not throw when chmodSync is unsupported (e.g. non-Unix platforms)', () => {
      fs.chmodSync.mockImplementation(() => { throw new Error('not supported'); });

      expect(() => manager.write({ debug: true })).not.toThrow();
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

      expect(manager.ensureDesktopUrl('tok')).toBe(false);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('creates a new config with defaults when missing', () => {
      expect(manager.ensureDesktopUrl('my_token')).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.vibemon'), { recursive: true });

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.http_urls).toEqual(['http://127.0.0.1:19280']);
      expect(written.vibemon_token).toBe('my_token');
      expect(written.vibemon_url).toBe('https://vibemon.io');
    });

    test('preserves existing fields and only appends the desktop URL', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        http_urls: ['http://192.168.1.50:8080'],
        vibemon_token: 'existing_token',
        debug: true
      }));

      expect(manager.ensureDesktopUrl('new_token')).toBe(true);

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.http_urls).toEqual(['http://192.168.1.50:8080', 'http://127.0.0.1:19280']);
      expect(written.vibemon_token).toBe('existing_token');
      expect(written.debug).toBe(true);
    });

    test('backs up and recreates when the existing file has invalid JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{not json');

      expect(manager.ensureDesktopUrl(null)).toBe(true);

      expect(fs.copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.vibemon'),
        expect.stringContaining('.bak')
      );
      expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('.bak'), 0o600);
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.http_urls).toEqual(['http://127.0.0.1:19280']);
    });

    test('leaves vibemon_token empty when no token is available', () => {
      manager.ensureDesktopUrl(null);

      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.vibemon_token).toBe('');
    });
  });
});
