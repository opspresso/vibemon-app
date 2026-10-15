const { localActivity } = require('../src/workspace/activity.cjs');

test('only named local projects appear and the followed project stays first', () => {
  const states = {
    z: { project: 'Zeta', state: 'working', character: 'codex', terminalId: 'private terminal', extra: 'private' },
    a: { project: 'Alpha', state: 'idle', model: 'test model' },
    'cloud:provider:account': { project: 'Cloud project', state: 'thinking' },
    null: { project: null, state: 'idle' },
    empty: { project: '', state: 'idle' }
  };
  expect(localActivity(states, 'z')).toEqual([
    { id: 'z', focused: true, running: true, project: 'Zeta', state: 'working', character: 'codex' },
    { id: 'a', focused: false, running: false, project: 'Alpha', state: 'idle', model: 'test model' }
  ]);
  expect(localActivity(states, null).map(item => item.id)).toEqual(['a', 'z']);
});

test('observation order changes do not move unfocused rows', () => {
  const states = { b: { project: 'Beta' }, a: { project: 'Alpha' } };
  const reverse = Object.fromEntries(Object.entries(states).reverse());
  expect(localActivity(states, null)).toEqual(localActivity(reverse, null));
  expect(states.b).not.toHaveProperty('focused');
});

test('same-named local projects expose account labels without terminal metadata', () => {
  const account = { id: 'work', provider: 'codex', displayName: 'Work' };
  const rows = localActivity({
    'local:first': { project: 'same', account, terminalId: 'private' },
    'local:second': { project: 'same', account: { ...account, id: 'personal', displayName: 'Personal' } }
  }, null);
  expect(rows.map(row => row.id)).toEqual(['local:first', 'local:second']);
  expect(rows.map(row => row.account.displayName)).toEqual(['Work', 'Personal']);
  expect(rows.every(row => !Object.hasOwn(row, 'terminalId'))).toBe(true);
});

test('running follows the state registry, not a waiting or finished state', () => {
  const rows = localActivity({
    plan: { project: 'plan', state: 'planning' },
    pack: { project: 'pack', state: 'packing' },
    ask: { project: 'ask', state: 'notification' },
    done: { project: 'done', state: 'done' }
  }, null);
  expect(Object.fromEntries(rows.map(row => [row.id, row.running]))).toEqual({ plan: true, pack: true, ask: false, done: false });
});
