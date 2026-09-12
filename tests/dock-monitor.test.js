jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const { execFile } = require('node:child_process');
const { DockMonitor } = require('../src/modules/dock-monitor.cjs');
const { DOCK_REFRESH_MS, DOCK_QUERY_TIMEOUT_MS } = require('../src/shared/constants.cjs');
const platform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  jest.useFakeTimers();
  execFile.mockReset();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
});

test('coalesces concurrent queries and validates native rectangles', async () => {
  const monitor = new DockMonitor();
  monitor.onChange = jest.fn();
  const pending = monitor.refresh();
  expect(monitor.refresh()).toBe(pending);
  expect(execFile).toHaveBeenCalledTimes(1);
  const [command, args, options, callback] = execFile.mock.calls[0];
  expect(command).toBe('/usr/bin/osascript');
  expect(args.slice(0, 2)).toEqual(['-l', 'JavaScript']);
  expect(args[2]).toBe('-e');
  expect(args[3]).toContain('CGWindowListCopyWindowInfo');
  expect(options.timeout).toBe(DOCK_QUERY_TIMEOUT_MS);
  const bounds = { x: -1040, y: -56, width: 640, height: 52 };
  callback(null, JSON.stringify([bounds, null, { x: 0 }, { ...bounds, width: -1 }]));
  await pending;
  expect(monitor.bounds).toEqual([bounds]);
  expect(monitor.onChange).toHaveBeenCalledTimes(1);
  execFile.mockImplementation((_command, _args, _options, done) => done(null, JSON.stringify([bounds])));
  await monitor.refresh();
  expect(monitor.onChange).toHaveBeenCalledTimes(1);
});

test.each([[new Error('timeout'), ''], [null, 'invalid json'], [null, '{}']])('clears stale geometry when detection fails', async (error, output) => {
  const monitor = new DockMonitor();
  monitor.bounds = [{ x: 400, y: 844, width: 640, height: 52 }];
  execFile.mockImplementation((_command, _args, _options, done) => done(error, output));
  await monitor.refresh();
  expect(monitor.bounds).toEqual([]);
});

test('only polls while an overlay needs Dock geometry and stops on cleanup', async () => {
  const monitor = new DockMonitor();
  const shouldRefresh = jest.fn(() => false);
  execFile.mockImplementation((_command, _args, _options, done) => done(null, '[]'));
  monitor.start(shouldRefresh);
  jest.advanceTimersByTime(DOCK_REFRESH_MS);
  expect(execFile).not.toHaveBeenCalled();
  shouldRefresh.mockReturnValue(true);
  jest.advanceTimersByTime(DOCK_REFRESH_MS);
  await monitor.pending;
  expect(execFile).toHaveBeenCalledTimes(1);
  monitor.cleanup();
  jest.advanceTimersByTime(DOCK_REFRESH_MS);
  expect(execFile).toHaveBeenCalledTimes(1);
});

test('late queries cannot notify or restore geometry after cleanup', async () => {
  const monitor = new DockMonitor();
  const onChange = jest.fn();
  monitor.onChange = onChange;
  const pending = monitor.refresh();
  monitor.cleanup();
  execFile.mock.calls[0][3](null, '[{"x":400,"y":844,"width":640,"height":52}]');
  await pending;
  expect(monitor.bounds).toEqual([]);
  expect(onChange).not.toHaveBeenCalled();
});

test.each(['win32', 'linux'])('does not query macOS APIs on %s', async value => {
  Object.defineProperty(process, 'platform', { value });
  const monitor = new DockMonitor();
  monitor.start(() => true);
  await monitor.refresh();
  jest.advanceTimersByTime(DOCK_REFRESH_MS);
  expect(execFile).not.toHaveBeenCalled();
});
