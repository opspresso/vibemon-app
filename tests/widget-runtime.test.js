const { prepareWidgetRuntime } = require('../src/widgets/runtime.cjs');
const { WIDGET_RESTART_TIMEOUT_MS } = require('../src/shared/constants.cjs');

const bundlePath = '/Applications/VibeMon.app';
const executable = `${bundlePath}/Contents/PlugIns/VibeMonWidgets.appex/Contents/MacOS/VibeMonWidgets`;

// The executable was installed 10 minutes before the process list was read.
const LISTED_AT = Date.parse('2026-10-18T09:00:00Z');
const INSTALLED_AT = LISTED_AT - 600000;
// Started before the install: an upgrade left this worker running the old bundle.
const BEFORE_UPGRADE = '15:00';

function setup(entries = [[42, executable]], elapsed = BEFORE_UPGRADE) {
  const active = new Map(entries);
  const events = [];
  let time = 0;
  const ports = {
    bundlePath,
    registerApplication: jest.fn(() => events.push('register')),
    readProcesses: jest.fn(async () => entries.map(([pid, file]) => `  ${pid} ${elapsed} ${file}`).join('\n')),
    readPath: jest.fn(async pid => active.get(pid) ?? null),
    installedAt: jest.fn(async () => INSTALLED_AT),
    wallNow: () => LISTED_AT,
    terminate: jest.fn(pid => { events.push(`stop:${pid}`); active.delete(pid); }),
    delay: jest.fn(async ms => { time += ms; }),
    now: () => time
  };
  return { ports, events, active };
}

test('refreshes this App and stops only its widget worker, preserving Simulator and development instances', async () => {
  const { ports, events, active } = setup([
    [42, executable],
    [43, '/Users/me/Library/Developer/CoreSimulator/Devices/test/VibeMon.app/PlugIns/VibeMonWidgets.appex/VibeMonWidgets'],
    [44, '/workspace/dist/VibeMon.app/Contents/PlugIns/VibeMonWidgets.appex/Contents/MacOS/VibeMonWidgets'],
    [45, '/Applications/VibeMon.app/Contents/MacOS/VibeMon']
  ]);
  await prepareWidgetRuntime(ports);
  expect(events).toEqual(['register', 'stop:42']);
  expect([...active.keys()]).toEqual([43, 44, 45]);
});

test('waits for the old worker to exit before the caller can reload widgets', async () => {
  const { ports, active, events } = setup();
  ports.terminate.mockImplementation(() => events.push('signal'));
  ports.delay.mockImplementation(async () => { events.push('exit'); active.delete(42); });
  await prepareWidgetRuntime(ports);
  events.push('ready-to-reload');
  expect(events).toEqual(['register', 'signal', 'exit', 'ready-to-reload']);
});

test('does not terminate a PID that changed identity after enumeration', async () => {
  const { ports, active } = setup();
  active.set(42, '/usr/bin/another-process');
  await prepareWidgetRuntime(ports);
  expect(ports.terminate).not.toHaveBeenCalled();
});

test('accepts a worker that exits before the termination signal', async () => {
  const { ports, active } = setup();
  ports.terminate.mockImplementation(() => { active.delete(42); throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  await expect(prepareWidgetRuntime(ports)).resolves.toBeUndefined();
});

test('reports denied termination and never claims readiness', async () => {
  const { ports } = setup();
  ports.terminate.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  await expect(prepareWidgetRuntime(ports)).rejects.toThrow('denied');
});

test('bounds the wait when a worker does not exit', async () => {
  const { ports } = setup();
  ports.terminate.mockImplementation(() => {});
  await expect(prepareWidgetRuntime(ports)).rejects.toThrow('did not stop');
  expect(ports.now()).toBeGreaterThanOrEqual(WIDGET_RESTART_TIMEOUT_MS);
});

test('leaves processes untouched if registration fails', async () => {
  const { ports } = setup();
  ports.registerApplication.mockImplementation(() => { throw new Error('registration failed'); });
  await expect(prepareWidgetRuntime(ports)).rejects.toThrow('registration failed');
  expect(ports.readProcesses).not.toHaveBeenCalled();
});

test.each([
  ['started after the install', '09:59', false],
  ['started more than a day ago', '2-03:04:05', true],
  ['started within a second after the install', '10:00', true],
  ['with an unreadable elapsed time', 'later', true]
])('a worker %s: stopped is %s', async (_case, elapsed, stopped) => {
  const { ports } = setup([[42, executable]], elapsed);
  await prepareWidgetRuntime(ports);
  expect(ports.terminate).toHaveBeenCalledTimes(stopped ? 1 : 0);
  expect(ports.installedAt).toHaveBeenCalledWith(executable);
});

test('registers normally when no widget worker exists', async () => {
  const { ports } = setup([]);
  await prepareWidgetRuntime(ports);
  expect(ports.registerApplication).toHaveBeenCalledTimes(1);
  expect(ports.terminate).not.toHaveBeenCalled();
  expect(ports.installedAt).not.toHaveBeenCalled();
});
