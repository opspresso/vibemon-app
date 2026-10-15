const { loadBrowserModule } = require('./helpers/browser-module.cjs');
const { Event, EventTarget } = globalThis;

const { observeAnimation } = loadBrowserModule('src/engine/animation-policy.js', ['observeAnimation']);

test('visibility and reduced motion stop animation, state renders remain possible, and cleanup detaches listeners', () => {
  const page = new EventTarget(); page.hidden = false;
  const motion = new EventTarget(); motion.matches = false;
  const engine = { setReducedMotion: jest.fn(), startAnimation: jest.fn(), stopAnimation: jest.fn(), render: jest.fn() };
  const cleanup = observeAnimation(engine, page, motion);
  expect(engine.startAnimation).toHaveBeenCalledTimes(1);
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  expect(engine.stopAnimation).toHaveBeenCalledTimes(1);
  expect(engine.render).toHaveBeenCalledTimes(1);
  motion.matches = true; motion.dispatchEvent(new Event('change'));
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  expect(engine.setReducedMotion).toHaveBeenLastCalledWith(true);
  expect(engine.startAnimation).toHaveBeenCalledTimes(1);
  expect(engine.render).toHaveBeenCalledTimes(2);
  motion.matches = false; motion.dispatchEvent(new Event('change'));
  expect(engine.startAnimation).toHaveBeenCalledTimes(2);
  cleanup();
  const renders = engine.render.mock.calls.length;
  motion.dispatchEvent(new Event('change')); page.dispatchEvent(new Event('visibilitychange'));
  expect(engine.render).toHaveBeenCalledTimes(renders);
  expect(engine.startAnimation).toHaveBeenCalledTimes(2);
});
