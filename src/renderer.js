// VibeMon engine instance (2D pixel-art or 3D pet, chosen by the persisted
// render mode — see init())
let vibeMonEngine = null;

// IPC cleanup function
let cleanupStateListener = null;

// Interaction override: while the character is held (pointer down) or
// dragged, it shows the 'done' expression (happy eyes), restoring the last
// reported state on release. The display area is deliberately not an
// app-region drag surface — that would swallow pointerdown, and the
// expression must react the moment the mouse goes down — so dragging is
// done manually: pointerdown anchors the drag and pointermove asks the
// main process to move the window along with the cursor.
let interactionActive = false;
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
  // registry-cache.cjs in the main process), fetched via preload.js, and
  // the persisted render mode selecting which engine to boot.
  const [{ characters, default: defaultCharacter, staticBaseUrl }, { states }, renderMode] = await Promise.all([
    window.electronAPI.getCharacterRegistry(),
    window.electronAPI.getStateRegistry(),
    window.electronAPI.getRenderMode()
  ]);

  if (renderMode === '3d') {
    // 3D pet engine: renders procedurally — characters map to color themes,
    // no images are loaded.
    const { createVibeMonEngine } = await import('./engine/vibemon-engine-3d.js');
    vibeMonEngine = createVibeMonEngine(container, {
      characters,
      defaultCharacter,
      states
    });
  } else {
    // 2D pixel-art engine: character images are remote-first
    // (static.vibemon.io), with the bundled asset as offline fallback —
    // each entry carries its candidate URLs in order.
    const { createVibeMonEngine } = await import('./engine/vibemon-engine.js');
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
  }
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
  }

  // Manual window drag + interaction expression. pointerdown shows the
  // 'done' expression and anchors the drag in the main process, pointermove
  // moves the window along with the cursor, pointerup restores the
  // expression. The window follows the cursor, so the pointer stays inside
  // it and keeps receiving events for the whole drag.
  const DRAG_CLICK_SUPPRESS_PX = 4;
  let pointerDragging = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartY = 0;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerDragging = true;
    dragMoved = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    setInteractionActive(true);
    window.electronAPI?.beginWindowDrag?.();
  });

  document.addEventListener('pointermove', (e) => {
    if (!pointerDragging || (e.buttons & 1) === 0) return;
    if (Math.abs(e.screenX - dragStartX) > DRAG_CLICK_SUPPRESS_PX ||
        Math.abs(e.screenY - dragStartY) > DRAG_CLICK_SUPPRESS_PX) {
      dragMoved = true;
    }
    window.electronAPI?.moveWindowDrag?.();
  });

  const endPointerDrag = () => {
    pointerDragging = false;
    setInteractionActive(false);
  };
  document.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    endPointerDrag();
  });
  document.addEventListener('pointercancel', endPointerDrag);

  // Right-click context menu (works on all platforms)
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (window.electronAPI?.showContextMenu) {
      window.electronAPI.showContextMenu();
    }
  });

  // Click to focus terminal (iTerm2/Ghostty on macOS)
  document.addEventListener('click', (e) => {
    // Ignore right-click and clicks that dragged the window
    if (e.button !== 0 || dragMoved) return;
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
}

// Initialize on load
window.onload = init;
window.onbeforeunload = cleanup;
window.onunload = cleanup;
