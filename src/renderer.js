// Static server base URL
const STATIC_BASE = 'https://static.vibemon.io';

// A static top-level import would throw and abort this entire module (no
// window.onload registration, blank window with no error shown) if the CDN
// is unreachable. A top-level await on a dynamic import is just as bad: it
// suspends module evaluation past the window 'load' event whenever the CDN
// fetch is slower than the local page load, so the `window.onload = init`
// assignment below lands too late and init() never runs. Load the engine
// inside init() instead — module evaluation stays synchronous, the onload
// registration is guaranteed to happen before 'load' fires, and a fetch
// failure can still be handled.
let createVibeMonEngine = null;

async function loadEngine() {
  try {
    ({ createVibeMonEngine } = await import(`${STATIC_BASE}/js/vibemon-engine-standalone.js`));
  } catch (error) {
    console.error('Failed to load the VibeMon rendering engine:', error);
  }
}

// VibeMon engine instance
let vibeMonEngine = null;

// IPC cleanup functions
let cleanupStateListener = null;
let cleanupDisplayModeListener = null;

let characterOnlyMode = false;

/**
 * The rendering engine (loaded from static.vibemon.io, not part of this repo)
 * paints its full-canvas state-color background directly as canvas pixels
 * (ctx.fillRect(0, 0, 128, 128)) before drawing the character sprite on top,
 * with no option to disable it. In character-only mode we want that backdrop
 * fully transparent, so intercept that specific full-canvas fill on the
 * character canvas and clear it instead of painting it. Small fillRect calls
 * (eyes, effects, icon canvases) are left untouched. This relies on the
 * engine's current internal implementation and may need updating if the
 * remote engine's rendering changes.
 */
function patchCharacterCanvasBackground() {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = originalGetContext.call(this, type, ...args);
    if (type === '2d' && this.classList?.contains('vibemon-canvas') && !ctx.__vibemonBgPatched) {
      const canvas = this;
      const originalFillRect = ctx.fillRect.bind(ctx);
      ctx.fillRect = (x, y, w, h) => {
        if (characterOnlyMode && x === 0 && y === 0 && w === canvas.width && h === canvas.height) {
          ctx.clearRect(0, 0, w, h);
          return;
        }
        originalFillRect(x, y, w, h);
      };
      ctx.__vibemonBgPatched = true;
    }
    return ctx;
  };
}

/**
 * Apply a display-mode payload (character-only mode) from either the push
 * ('display-mode-update') or the pull (getDisplayMode). The speech bubble
 * itself is rendered in its own window by the main process
 * (modules/bubble-window-manager.cjs); this only toggles the CSS class that
 * hides this window's own title bar/device frame/engine info panel.
 */
function applyDisplayMode(data) {
  if (!data || typeof data !== 'object') return;

  characterOnlyMode = !!data.characterOnlyMode;
  document.body.classList.toggle('character-only-mode', characterOnlyMode);
}

// Initialize
async function init() {
  const container = document.getElementById('vibemon-display');

  await loadEngine();

  if (!createVibeMonEngine) {
    if (container) {
      container.textContent = 'Failed to load VibeMon — check your internet connection.';
    }
    return;
  }

  patchCharacterCanvasBackground();

  // Get platform info for emoji detection
  let useEmoji = false;
  if (window.electronAPI?.getPlatform) {
    const platform = window.electronAPI.getPlatform();
    useEmoji = platform === 'darwin';
  }

  // Create and initialize VibeMon engine with static server images
  vibeMonEngine = createVibeMonEngine(container, {
    useEmoji,
    characterImageUrls: {
      clawd: `${STATIC_BASE}/characters/clawd.png`,
      kiro: `${STATIC_BASE}/characters/kiro.png`,
      claw: `${STATIC_BASE}/characters/claw.png`,
      codex: `${STATIC_BASE}/characters/codex.png`,
      daangni: `${STATIC_BASE}/characters/daangni.png`
    }
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
      vibeMonEngine.setState(data);
      vibeMonEngine.render();
    });
  }

  // Listen for display-mode updates (character-only mode)
  if (window.electronAPI?.onDisplayModeUpdate) {
    cleanupDisplayModeListener = window.electronAPI.onDisplayModeUpdate(applyDisplayMode);
  }

  // The main process also pushes display-mode once at window creation, but
  // that push can race ahead of this async init() (engine/image loading) and
  // get dropped before the listener above is registered. Pull the current
  // settings directly once we're actually ready, so it's correct regardless.
  if (window.electronAPI?.getDisplayMode) {
    window.electronAPI.getDisplayMode().then(applyDisplayMode).catch((error) => {
      console.error('Failed to fetch display mode:', error);
    });
  }

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
      window.electronAPI.focusTerminal();
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
  if (cleanupDisplayModeListener) {
    cleanupDisplayModeListener();
    cleanupDisplayModeListener = null;
  }
}

// Initialize on load
window.onload = init;
window.onbeforeunload = cleanup;
window.onunload = cleanup;
