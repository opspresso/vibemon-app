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
    { id: 'z', focused: true, project: 'Zeta', state: 'working', character: 'codex' },
    { id: 'a', focused: false, project: 'Alpha', state: 'idle', model: 'test model' }
  ]);
  expect(localActivity(states, null).map(item => item.id)).toEqual(['a', 'z']);
});

test('observation order changes do not move unfocused rows', () => {
  const states = { b: { project: 'Beta' }, a: { project: 'Alpha' } };
  const reverse = Object.fromEntries(Object.entries(states).reverse());
  expect(localActivity(states, null)).toEqual(localActivity(reverse, null));
  expect(states.b).not.toHaveProperty('focused');
});
