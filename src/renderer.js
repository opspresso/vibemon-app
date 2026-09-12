import { installWindowInteraction, createCharacterHitTest } from './shared/window-interaction.js';
import { install3DFraming } from './shared/3d-framing.js';

// VibeMon engine instance (2D pixel-art or 3D pet, chosen by the persisted
// render mode — see init())
let vibeMonEngine = null;

// IPC cleanup functions
let cleanupInteraction = null;
let cleanupStateListener = null;
let cleanupDisplayOptionsListener = null;
let cleanupFraming = null;

// Interaction override: while the character is held (pointer down) or
// dragged, it shows the 'start' greeting expression, restoring the last
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
  vibeMonEngine.setState({ state: active ? 'start' : (lastReportedState || 'start') });
  vibeMonEngine.render();
}

// Apply the persisted display settings to the character area: the Character
// Size scale (styles.css scales .vibemon-display by --vibemon-scale; the
// window itself is resized to match by the main process) and the dev-mode
// tint that makes that area's bounds visible.
function applyDisplayOptions(container, options) {
  if (!options) return;
  container.style.setProperty('--vibemon-scale', String((options.characterScale || 100) / 100));
  container.classList.toggle('dev-mode', !!options.devMode);
}

// Initialize
async function init() {
  const container = document.getElementById('vibemon-display');

  // Character/state registries (canonical: vibemon-static, resolved by
  // registry-cache.cjs in the main process), fetched via preload.js, the
  // persisted render mode selecting which engine to boot, and the display
  // options the character area is drawn with.
  const [{ characters, default: defaultCharacter, staticBaseUrl, imageFetchTimeoutMs }, { states }, renderMode, displayOptions] = await Promise.all([
    window.electronAPI.getCharacterRegistry(),
    window.electronAPI.getStateRegistry(),
    window.electronAPI.getRenderMode(),
    window.electronAPI.getDisplayOptions()
  ]);

  applyDisplayOptions(container, displayOptions);

  if (renderMode === '3d') {
    // 3D pet engine: renders procedurally — characters map to the registry's
    // `theme` palette, no images are loaded. The engine is vendored from
    // vibemon-static, which ships no dependencies, so it takes three.js from
    // here (local file: the CSP forbids runtime CDN imports).
    const [{ createVibeMonEngine }, THREE] = await Promise.all([
      import('./engine/vibemon-engine-3d.js'),
      import('./vendor/three.module.min.js')
    ]);
    vibeMonEngine = createVibeMonEngine(container, {
      THREE,
      characters,
      defaultCharacter,
      states
    });
    await vibeMonEngine.init();
    vibeMonEngine.renderer.setPixelRatio((window.devicePixelRatio || 1) * displayOptions.renderScale3d);
    cleanupFraming = install3DFraming(vibeMonEngine, container, THREE, displayOptions.renderPadding3d);
  } else {
    // 2D pixel-art engine: character images are remote-first
    // (static.vibemon.io), with the bundled asset as offline fallback —
    // fetch into origin-clean blobs so alpha hit testing can read the canvas.
    const { createVibeMonEngine } = await import('./engine/vibemon-engine.js');
    const imageUrls = await Promise.all(Object.entries(characters).map(async ([name, config]) => {
      const localUrl = `assets/characters/${config.image}`;
      try {
        const response = await window.fetch(`${staticBaseUrl}/characters/${config.image}`, {
          signal: window.AbortSignal.timeout(imageFetchTimeoutMs)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return [name, [URL.createObjectURL(await response.blob()), localUrl]];
      } catch (error) {
        console.warn(`Using bundled character ${name}:`, error.message);
        return [name, [localUrl]];
      }
    }));
    vibeMonEngine = createVibeMonEngine(container, {
      characters,
      defaultCharacter,
      characterImageUrls: Object.fromEntries(imageUrls),
      states
    });
    try {
      await vibeMonEngine.init();
    } finally {
      for (const [, urls] of imageUrls) {
        if (urls[0].startsWith('blob:')) URL.revokeObjectURL(urls[0]);
      }
    }
  }

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
      if (interactionActive) vibeMonEngine.setState({ state: 'start' });
      vibeMonEngine.render();
    });

    // Size/dev-mode changes made in Settings apply live — no window reload.
    cleanupDisplayOptionsListener = window.electronAPI.onDisplayOptions((options) => {
      applyDisplayOptions(container, options);
    });
  }

  cleanupInteraction = installWindowInteraction({
    hitTest: createCharacterHitTest(vibeMonEngine),
    onInteraction: setInteractionActive
  });
}

// Cleanup on unload
function cleanup() {
  cleanupFraming?.();
  cleanupFraming = null;
  cleanupInteraction?.();
  cleanupInteraction = null;
  if (vibeMonEngine) {
    vibeMonEngine.cleanup();
    vibeMonEngine = null;
  }
  if (cleanupStateListener) {
    cleanupStateListener();
    cleanupStateListener = null;
  }
  if (cleanupDisplayOptionsListener) {
    cleanupDisplayOptionsListener();
    cleanupDisplayOptionsListener = null;
  }
}

// Initialize on load
window.onload = init;
window.onbeforeunload = cleanup;
window.onunload = cleanup;
