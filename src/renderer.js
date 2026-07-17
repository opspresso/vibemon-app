import { createVibeMonEngine } from './engine/vibemon-engine.js';

// VibeMon engine instance
let vibeMonEngine = null;

// IPC cleanup functions
let cleanupStateListener = null;
let cleanupDragListener = null;

// Interaction override: while the character is clicked (mouse held down) or
// dragged, it shows the 'done' expression (happy eyes). A drag is signaled
// by the main process via 'window-drag' — mouse move/up events don't reach
// the page while the OS handles the app-region drag — and is considered
// over once move events stop for DRAG_SETTLE_MS.
const DRAG_SETTLE_MS = 250;
let interactionActive = false;
let dragSettleTimer = null;
let lastReportedState = null;

function setInteractionActive(active) {
  if (interactionActive === active || !vibeMonEngine) return;
  interactionActive = active;
  vibeMonEngine.setState({ state: active ? 'done' : (lastReportedState || 'start') });
  vibeMonEngine.render();
}

// Initialize
async function init() {
  const container = document.getElementById('vibemon-display');

  // Character/state registries (canonical: vibemon-static, resolved by
  // registry-cache.cjs in the main process), fetched via preload.js.
  // Character images are remote-first (static.vibemon.io), with the bundled
  // asset as offline fallback — each entry carries its candidate URLs in
  // order.
  const [{ characters, default: defaultCharacter, staticBaseUrl }, { states }] = await Promise.all([
    window.electronAPI.getCharacterRegistry(),
    window.electronAPI.getStateRegistry()
  ]);

  vibeMonEngine = createVibeMonEngine(container, {
    characters,
    defaultCharacter,
    characterImageUrls: Object.fromEntries(
      Object.entries(characters).map(([name, config]) => [name, [
        `${staticBaseUrl}/characters/${config.image}`,
        `assets/characters/${config.image}`
      ]])
    ),
    states
  });
  await vibeMonEngine.init();

  // Initial render and start animation
  vibeMonEngine.render();
  vibeMonEngine.startAnimation();

  // Listen for state updates from main process
  if (window.electronAPI) {
    cleanupStateListener = window.electronAPI.onStateUpdate((data) => {
      // Validate incoming data
      if (!data || typeof data !== 'object') return;

      // Update state in VibeMon engine
      if (typeof data.state === 'string') lastReportedState = data.state;
      vibeMonEngine.setState(data);
      // Keep the interaction expression on top of updates that arrive
      // mid-click/drag; the real state is restored when it ends.
      if (interactionActive) vibeMonEngine.setState({ state: 'done' });
      vibeMonEngine.render();
    });

    if (window.electronAPI.onWindowDrag) {
      cleanupDragListener = window.electronAPI.onWindowDrag(() => {
        setInteractionActive(true);
        if (dragSettleTimer) clearTimeout(dragSettleTimer);
        dragSettleTimer = setTimeout(() => {
          dragSettleTimer = null;
          setInteractionActive(false);
        }, DRAG_SETTLE_MS);
      });
    }
  }

  // Interaction expression while the mouse is held down on the character.
  // A drag swallows mouseup — the window-drag settle timer clears instead.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    setInteractionActive(true);
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    setInteractionActive(false);
  });

  // Right-click context menu (works on all platforms)
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (window.electronAPI?.showContextMenu) {
      window.electronAPI.showContextMenu();
    }
  });

  // Click to focus terminal (iTerm2/Ghostty on macOS)
  document.addEventListener('click', (e) => {
    // Ignore right-click
    if (e.button !== 0) return;
    if (window.electronAPI?.focusTerminal) {
      window.electronAPI.focusTerminal()
        .then((result) => {
          if (result && !result.success) {
            console.warn('Focus terminal failed:', result.reason);
          }
        })
        .catch((err) => console.warn('Focus terminal failed:', err));
    }
  });
}

// Cleanup on unload
function cleanup() {
  if (vibeMonEngine) {
    vibeMonEngine.cleanup();
    vibeMonEngine = null;
  }
  if (cleanupStateListener) {
    cleanupStateListener();
    cleanupStateListener = null;
  }
  if (cleanupDragListener) {
    cleanupDragListener();
    cleanupDragListener = null;
  }
  if (dragSettleTimer) {
    clearTimeout(dragSettleTimer);
    dragSettleTimer = null;
  }
}

// Initialize on load
window.onload = init;
window.onbeforeunload = cleanup;
window.onunload = cleanup;
