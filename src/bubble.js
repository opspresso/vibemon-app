// Speech-bubble window: installs input hit-testing and the content entry point
// the main process calls through webContents.executeJavaScript().
import { renderBubble } from './shared/bubble/vibemon-bubble.js';
import { installWindowInteraction, hitTestBubble } from './shared/window-interaction.js';
const cleanupInteraction = installWindowInteraction({
  hitTest: (x, y) => hitTestBubble(document.getElementById('bubble'), x, y)
});
window.addEventListener('unload', cleanupInteraction);

// Called from the main process via webContents.executeJavaScript(). See
// shared/bubble/vibemon-bubble.js's renderBubble() for the `fields` shape.
// tailSide is the bubble edge the tail sits on ('bottom'/'top' when the
// bubble is above/below the character, 'left'/'right' when it's beside
// it); tailOffset is the tail's offset in px along that edge (left
// offset for top/bottom, top offset for left/right) — both computed by
// the main process from the bubble's final position relative to the
// character (see modules/bubble-window-manager.cjs). bgColor is the
// current state's hex color.
window.__setBubbleContent = function (fields, tailOffset, tailSide, bgColor, scale) {
  if (typeof scale === 'number') document.body.style.transform = `scale(${scale})`;
  const bubble = document.getElementById('bubble');
  // An opaque state color keeps text contrast independent of the desktop behind it.
  renderBubble(bubble, fields, tailSide, bgColor, { opaque: true });

  const tail = document.getElementById('bubble-tail');
  if (typeof tailOffset === 'number') {
    if (tailSide === 'left' || tailSide === 'right') {
      tail.style.top = tailOffset + 'px';
      tail.style.left = '';
    } else {
      tail.style.left = tailOffset + 'px';
      tail.style.top = '';
    }
  }

  // body is a block element, so its width always reports the current
  // viewport (window) width, not its shrink-wrapped content — measure
  // width from #bubble (inline-flex, sized to content) plus the 6px
  // left/right tail padding. Height doesn't have that problem (block
  // height auto-sizes to content), and comes from body to include the
  // 6px top/bottom tail padding.
  return { width: bubble.offsetWidth + 12, height: document.body.offsetHeight };
};
