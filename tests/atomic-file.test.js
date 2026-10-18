const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../src/shared/atomic-file.cjs');

describe('atomic file replacement', () => {
  let directory;
  let file;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-atomic-'));
    file = path.join(directory, 'config.json');
    fs.writeFileSync(file, 'previous content');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('replaces the destination without reusing an existing temporary hard link', () => {
    const unrelated = path.join(directory, 'unrelated.json');
    const oldTemporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(unrelated, 'unrelated content');
    fs.linkSync(unrelated, oldTemporary);
    writeFileAtomic(file, 'replacement', { mode: 0o600, directoryMode: 0o700 });
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated content');
    expect(fs.readFileSync(oldTemporary, 'utf8')).toBe('unrelated content');
    expect(fs.readdirSync(directory).sort()).toEqual(['config.json', path.basename(oldTemporary), 'unrelated.json'].sort());
  });

  (process.platform === 'win32' ? test.skip : test)('restricts permissions before replacement and keeps the file private', () => {
    fs.chmodSync(directory, 0o755);
    fs.chmodSync(file, 0o644);
    const write = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((target, ...args) => {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
      return write(target, ...args);
    });
    writeFileAtomic(file, 'replacement', { mode: 0o600, directoryMode: 0o700 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['config.json']);
  });

  (process.platform === 'win32' ? test.skip : test)('preserves existing content when directory permissions cannot be restricted', () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    jest.spyOn(fs, 'chmodSync').mockImplementation(() => { throw failure; });
    expect(() => writeFileAtomic(file, 'replacement', { mode: 0o600, directoryMode: 0o700 })).toThrow(failure);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous content');
    expect(fs.readdirSync(directory)).toEqual(['config.json']);
  });

  test('preserves existing content and removes a partial temporary write', () => {
    const write = fs.writeFileSync;
    const failure = Object.assign(new Error('storage full'), { code: 'ENOSPC' });
    jest.spyOn(fs, 'writeFileSync').mockImplementation((target, _text, options) => {
      write(target, 'partial', options);
      throw failure;
    });
    expect(() => writeFileAtomic(file, 'replacement')).toThrow(failure);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous content');
    expect(fs.readdirSync(directory)).toEqual(['config.json']);
  });

  test('preserves existing content and cleans up after a failed rename', () => {
    const failure = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure; });
    expect(() => writeFileAtomic(file, 'replacement')).toThrow(failure);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous content');
    expect(fs.readdirSync(directory)).toEqual(['config.json']);
  });

  test('uses Windows filesystem permissions without attempting POSIX chmod', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const chmod = jest.spyOn(fs, 'chmodSync').mockImplementation(() => { throw new Error('unsupported'); });
    try {
      writeFileAtomic(file, 'replacement', { mode: 0o600, directoryMode: 0o700 });
      expect(chmod).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
      expect(fs.readdirSync(directory)).toEqual(['config.json']);
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
