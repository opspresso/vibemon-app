// The host owns visibility and accessibility preferences; engines own rendering.
export function observeAnimation(engine, page = document, motion = window.matchMedia('(prefers-reduced-motion: reduce)')) {
  const update = () => {
    engine.setReducedMotion(motion.matches);
    if (page.hidden || motion.matches) engine.stopAnimation();
    else engine.startAnimation();
    if (!page.hidden) engine.render();
  };
  page.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  update();
  return () => {
    page.removeEventListener('visibilitychange', update);
    motion.removeEventListener('change', update);
    engine.stopAnimation();
  };
}
