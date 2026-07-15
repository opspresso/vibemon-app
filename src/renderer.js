import { createVibeMonEngine } from './engine/vibemon-engine.js';

// VibeMon engine instance
let vibeMonEngine = null;

// IPC cleanup function
let cleanupStateListener = null;

// Initialize
async function init() {
  const container = document.getElementById('vibemon-display');

  // Character/state registries (single sources: src/shared/data/
  // characters.json and states.json), fetched via preload.js — image URLs
  // are derived from each character entry.
  const [{ characters, default: defaultCharacter }, { states }] = await Promise.all([
    window.electronAPI.getCharacterRegistry(),
    window.electronAPI.getStateRegistry()
  ]);

  vibeMonEngine = createVibeMonEngine(container, {
    characters,
    defaultCharacter,
    characterImageUrls: Object.fromEntries(
      Object.entries(characters).map(([name, config]) => [name, `assets/characters/${config.image}`])
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
      vibeMonEngine.setState(data);
      vibeMonEngine.render();
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
