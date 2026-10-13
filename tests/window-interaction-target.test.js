const { interactionTarget } = require('../src/modules/window-interaction-target.cjs');
function fixture(projectId = null) {
  const character = { webContents: {}, isDestroyed: jest.fn(() => false) };
  const bubble = { webContents: {}, isDestroyed: jest.fn(() => false) };
  const characters = { getActiveWindow: () => character, getWindow: id => id === projectId ? character : null, getProjectIdByWebContents: () => projectId };
  const bubbles = { bubbleWindows: new Map([[projectId, bubble]]) };
  return { character, bubble, characters, bubbles };
}
test.each([null, 'local:agent:work'])('allows the actual companion and bubble with project %s', projectId => {
  const { character, bubble, characters, bubbles } = fixture(projectId);
  expect(interactionTarget(character.webContents, characters, bubbles)).toEqual({ window: character, projectId });
  expect(interactionTarget(bubble.webContents, characters, bubbles)).toEqual({ window: bubble, projectId });
  expect(interactionTarget({}, characters, bubbles)).toBeNull();
});
test('rejects destroyed windows and a bubble belonging to a previous project', () => {
  const { character, bubble, characters, bubbles } = fixture('current');
  bubbles.bubbleWindows = new Map([['old', bubble]]);
  expect(interactionTarget(bubble.webContents, characters, bubbles)).toBeNull();
  character.isDestroyed.mockReturnValue(true);
  expect(interactionTarget(character.webContents, characters, bubbles)).toBeNull();
});
