const $ = (id) => document.getElementById(id);
let snapshot = null;

function showError(error) {
  const output = $('settings-error');
  output.textContent = String(error?.message || 'Settings request failed');
  output.hidden = false;
}
function withErrors(handler) {
  return async (...args) => {
    $('settings-error').hidden = true;
    try { await handler(...args); } catch (error) { showError(error); }
  };
}

// How long the "Failed" label stays on a hook install button before
// reverting to Install/Reinstall.
const FAILED_LABEL_MS = 1500;

// --- Sidebar tabs ---
function selectTab(name) {
  const btn = document.querySelector(`.sidebar button[data-tab="${name}"]`);
  if (!btn) return;
  document.querySelectorAll('.sidebar button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  $('tab-' + name).classList.add('active');
}
document.querySelectorAll('.sidebar button').forEach((btn) => {
  btn.addEventListener('click', withErrors(() => selectTab(btn.dataset.tab)));
});

function fillSelect(select, entries, current) {
  select.innerHTML = '';
  for (const [value, label] of entries) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderVibemon(s) {
  fillSelect(
    $('render-mode'),
    [['2d', '2D (Pixel Art)'], ['3d', '3D (Pet)']],
    s.renderMode
  );
  fillSelect(
    $('character-lock'),
    [['auto', 'Auto'], ...s.options.characters.map((c) => [c.name, c.displayName])],
    s.characterLock
  );
  fillSelect(
    $('character-scale'),
    s.options.characterScales.map((scale) => [scale, scale + '%']),
    s.characterScale
  );
  fillSelect($('always-on-top'), Object.entries(s.options.alwaysOnTopModes), s.alwaysOnTopMode);
  fillSelect(
    $('edge-margin'),
    s.options.edgeMargins.map((margin) => [margin, margin + ' px']),
    s.edgeMargin
  );
  $('dock-corner-size-row').hidden = !s.supportsDockCorners;
  fillSelect($('dock-corner-size'), [['keep', 'Keep current size'], ['shrink', 'Auto shrink']], s.dockAutoScale ? 'shrink' : 'keep');

  const fieldsBox = $('speech-bubble-fields');
  fieldsBox.innerHTML = '';
  for (const field of s.options.speechBubbleFields) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex; align-items:center; gap:4px; cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.speechBubbleFields[field];
    cb.addEventListener('change', withErrors(async () => {
      await window.settingsAPI.setSpeechBubbleField(field, cb.checked);
    }));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(field));
    fieldsBox.appendChild(label);
  }

  $('open-at-login').checked = !!s.openAtLogin;
  $('dev-mode').checked = !!s.devMode;

  renderCloudState(s.cloud);
}

function renderCloudState(cloud) {
  const cloudBadge = $('cloud-status');
  const labels = {
    connected: ['● Connected', 'ok'],
    connecting: ['○ Connecting…', ''],
    'connection-error': ['○ Connection error', 'warn'],
    'token-expired': ['○ Read token rejected', 'warn'],
    'credential-unavailable': ['○ Re-enter saved read token', 'warn'],
    'permission-denied': ['○ Read permission required', 'warn'],
    'secure-storage-unavailable': ['○ Unlock secure storage', 'warn'],
    'not-configured': ['○ Not configured', '']
  };
  const [text, cls] = labels[cloud.status] || labels['not-configured'];
  cloudBadge.textContent = text;
  cloudBadge.className = 'badge' + (cls ? ' ' + cls : '');

}
window.settingsAPI.onCloudState(renderCloudState);

function buildHookRow(tool) {
  const row = document.createElement('div');
  row.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const label = document.createElement('label');
  label.textContent = tool.name;
  text.appendChild(label);
  row.appendChild(text);

  if (!tool.present) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Not detected';
    row.appendChild(badge);
  } else {
    const actions = document.createElement('div');
    actions.className = 'row-actions';

    // Broken outranks changed: a hook whose interpreter or script path no
    // longer exists doesn't run at all, while drift only means outdated.
    const needsAttention = tool.broken || tool.changed;

    if (tool.hasHook) {
      const badge = document.createElement('span');
      badge.className = 'badge ' + (needsAttention ? 'warn' : 'ok');
      badge.textContent = tool.broken ? 'Needs repair' : (tool.changed ? 'Changed' : 'Installed ✓');
      if (tool.broken && tool.brokenPath) {
        badge.title = `Not found: ${tool.brokenPath}`;
      }
      actions.appendChild(badge);
    } else if (tool.dismissed) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Prompts off';
      badge.title = "You picked Don't Ask Again for this tool.";
      actions.appendChild(badge);
    }

    const btn = document.createElement('button');
    btn.className = 'action' + (tool.hasHook && !needsAttention ? ' secondary' : '');
    btn.textContent = tool.hasHook ? 'Reinstall' : 'Install';
    btn.addEventListener('click', withErrors(async () => {
      const idleText = tool.hasHook ? 'Reinstall' : 'Install';
      btn.disabled = true;
      btn.textContent = tool.hasHook ? 'Reinstalling…' : 'Installing…';
      try {
        renderHooks(await window.settingsAPI.installHook(tool.flag));
      } catch (err) {
        showError(err);
        btn.textContent = 'Failed';
        // IPC prefixes the main-process message with its own wrapper; keep
        // the last "Error:" segment so the tooltip carries the real cause.
        btn.title = String((err && err.message) || err).split(/Error:\s*/).pop().trim();
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = idleText;
          btn.title = '';
        }, FAILED_LABEL_MS);
      }
    }));
    actions.appendChild(btn);

    row.appendChild(actions);
  }
  return row;
}

function renderHooks(hooks) {
  // Dot badge on the sidebar tab while any installed tool's scripts
  // drifted from the published versions or stopped resolving.
  const tabBtn = document.querySelector('.sidebar button[data-tab="ai-tools"]');
  tabBtn.classList.toggle('attention', hooks.some((t) => t.present && (t.changed || t.broken)));

  // Only offered when something is actually silenced: "Don't Ask Again"
  // is stored on disk, so without this the choice is permanent.
  const resetBtn = $('hooks-reset-prompts');
  resetBtn.hidden = !hooks.some((t) => t.dismissed);

  // The shared VibeMon Scripts entry renders in its own box above the
  // per-tool hook list.
  const sharedList = $('vibemon-scripts-list');
  sharedList.innerHTML = '';
  const list = $('hook-list');
  list.innerHTML = '';
  for (const tool of hooks) {
    (tool.flag === '--vibemon' ? sharedList : list).appendChild(buildHookRow(tool));
  }
}

function renderVibemonConfigStatus(status) {
  const box = $('vibemon-config-status');
  box.innerHTML = '';

  if (status.exists && status.hasDesktopUrl) {
    const badge = document.createElement('span');
    badge.className = 'badge ok';
    badge.textContent = 'Configured ✓';
    box.appendChild(badge);
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'action secondary';
  btn.textContent = 'Repair';
  btn.addEventListener('click', withErrors(async () => {
    btn.disabled = true;
    btn.textContent = 'Repairing…';
    try {
      renderVibemonConfigSection(await window.settingsAPI.repairVibemonConfig());
    } catch (err) {
      showError(err);
      btn.disabled = false;
      btn.textContent = 'Repair';
    }
  }));
  box.appendChild(btn);
}

function renderHttpUrls(urls) {
  const box = $('vibemon-http-urls');
  box.innerHTML = '';

  for (const url of urls) {
    const chip = document.createElement('div');
    chip.className = 'url-chip';

    const span = document.createElement('span');
    span.textContent = url;
    chip.appendChild(span);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', withErrors(async () => {
      renderVibemonConfigSection(await window.settingsAPI.removeHttpUrl(url));
    }));
    chip.appendChild(removeBtn);

    box.appendChild(chip);
  }

  const addRow = document.createElement('div');
  addRow.className = 'url-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'http://host:port';
  const addBtn = document.createElement('button');
  addBtn.className = 'action secondary';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', withErrors(async () => {
    const value = input.value.trim();
    if (!value) return;
    renderVibemonConfigSection(await window.settingsAPI.addHttpUrl(value));
  }));
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  box.appendChild(addRow);
}

function renderVibemonConfigSection(config) {
  renderVibemonConfigStatus(config.status);
  renderHttpUrls(config.http_urls);

  if (document.activeElement !== $('vibemon-serial-port')) {
    $('vibemon-serial-port').value = config.serial_port || '';
  }
  if (document.activeElement !== $('vibemon-url')) {
    $('vibemon-url').value = config.vibemon_url || '';
  }
  $('vibemon-debug').checked = !!config.debug;
  $('vibemon-auto-launch').checked = !!config.auto_launch;

  return config;
}

// Version strings come from GitHub release metadata — never inject them
// as HTML.
function highlight(text) {
  const span = document.createElement('span');
  span.className = 'highlight';
  span.textContent = text;
  return span;
}

function renderUpdate(update, isPackaged) {
  const statusEl = $('update-status');
  const actionBtn = $('update-action');
  const checkBtn = $('check-updates');
  actionBtn.style.display = 'none';
  checkBtn.disabled = false;

  if (!isPackaged) {
    statusEl.textContent = 'Update checks are only available in the packaged app.';
    checkBtn.disabled = true;
    return;
  }

  switch (update.status) {
    case 'checking':
      statusEl.textContent = 'Checking for updates…';
      checkBtn.disabled = true;
      break;
    case 'available':
      statusEl.textContent = 'New version available: ';
      statusEl.appendChild(highlight('v' + update.version));
      actionBtn.textContent = '⬆ Update to v' + update.version;
      actionBtn.style.display = 'inline-block';
      actionBtn.onclick = async () => {
        renderUpdate(await window.settingsAPI.downloadUpdate(), true);
      };
      break;
    case 'downloading':
      statusEl.textContent = 'Downloading v' + update.version + '…';
      checkBtn.disabled = true;
      break;
    case 'downloaded':
      statusEl.textContent = '';
      statusEl.appendChild(highlight('v' + update.version));
      statusEl.appendChild(document.createTextNode(' downloaded'));
      actionBtn.textContent = 'Restart to install v' + update.version;
      actionBtn.style.display = 'inline-block';
      actionBtn.onclick = () => window.settingsAPI.installDownloaded();
      break;
    default:
      statusEl.textContent = 'You are up to date.';
  }
}

async function loadAll() {
  snapshot = await window.settingsAPI.getAll();
  renderVibemon(snapshot);
  renderHooks(snapshot.hooks);
  renderVibemonConfigSection(snapshot.vibemonConfig);
  $('app-version').textContent = snapshot.version;
  renderUpdate(snapshot.update, snapshot.isPackaged);
}

// --- Control wiring ---
$('character-lock').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setCharacterLock(e.target.value);
}));
$('render-mode').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setRenderMode(e.target.value);
}));
// Select values arrive as strings; the main process validates them
// against the numeric CHARACTER_SCALES/EDGE_MARGINS lists.
$('character-scale').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setCharacterScale(Number(e.target.value));
}));
$('always-on-top').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setAlwaysOnTopMode(e.target.value);
}));
$('edge-margin').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setEdgeMargin(Number(e.target.value));
}));
$('dock-corner-size').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setDockAutoScale(e.target.value === 'shrink');
}));
$('dev-mode').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setDevMode(e.target.checked);
}));
$('open-at-login').addEventListener('change', withErrors(async (e) => {
  await window.settingsAPI.setOpenAtLogin(e.target.checked);
}));
$('open-monitoring').addEventListener('click', withErrors(() => window.settingsAPI.openMonitoring()));
$('hooks-reset-prompts').addEventListener('click', withErrors(async () => {
  const btn = $('hooks-reset-prompts');
  btn.disabled = true;
  try {
    renderHooks(await window.settingsAPI.resetHookPrompts());
  } finally {
    btn.disabled = false;
  }
}));

$('hooks-refresh').addEventListener('click', withErrors(async () => {
  const btn = $('hooks-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    renderHooks(await window.settingsAPI.refreshHookStatuses());
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}));
$('vibemon-serial-port').addEventListener('blur', withErrors(async (e) => {
  renderVibemonConfigSection(await window.settingsAPI.setVibemonConfig({ serial_port: e.target.value }));
}));
$('vibemon-url').addEventListener('blur', withErrors(async (e) => {
  renderVibemonConfigSection(await window.settingsAPI.setVibemonConfig({ vibemon_url: e.target.value }));
}));
$('vibemon-debug').addEventListener('change', withErrors(async (e) => {
  renderVibemonConfigSection(await window.settingsAPI.setVibemonConfig({ debug: e.target.checked }));
}));
$('vibemon-auto-launch').addEventListener('change', withErrors(async (e) => {
  renderVibemonConfigSection(await window.settingsAPI.setVibemonConfig({ auto_launch: e.target.checked }));
}));
$('check-updates').addEventListener('click', withErrors(async () => {
  $('check-updates').disabled = true;
  $('update-status').textContent = 'Checking for updates…';
  renderUpdate(await window.settingsAPI.checkForUpdates(), snapshot.isPackaged);
}));
$('open-docs').addEventListener('click', withErrors(() => window.settingsAPI.openExternal('docs')));
$('open-releases').addEventListener('click', withErrors(() => window.settingsAPI.openExternal('releases')));

// Live update-state pushes (e.g. download progress finished)
window.settingsAPI.onUpdateState((state) => {
  if (snapshot) renderUpdate(state, snapshot.isPackaged);
});

// Live hook-status pushes from the periodic change check
window.settingsAPI.onHookStatuses(renderHooks);

// Tab selection pushed from the main process (e.g. tray → About)
window.settingsAPI.onSelectTab(selectTab);

// Esc closes the window, like a native settings dialog.
document.addEventListener('keydown', withErrors((e) => {
  if (e.key === 'Escape') window.close();
}));

// Re-sync when the window regains focus, so changes made from the tray
// menu while this window was open are reflected.
window.addEventListener('focus', withErrors(loadAll));

loadAll().catch(showError);
