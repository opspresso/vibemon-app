import { $, el, text, icon, keyed, choices, sprite, button, connection } from '../dom.js';

const fieldLabels = {
  status: 'Activity',
  project: 'Project name',
  model: 'Model',
  memory: 'Context usage',
  usage5h: 'Session usage',
  usageWeek: 'Weekly usage',
  usageWeekModel: 'Model usage'
};
const descriptions = {
  '--claude': 'Session activity, context, and available plan usage from Claude Code.',
  '--codex': 'Activity from Codex CLI. Review new or changed hooks with /hooks in Codex.',
  '--kiro': 'Activity from Kiro. Usage is shown only when the tool reports it.',
  '--openclaw': 'Project and tool activity from your OpenClaw gateway.',
  '--opencode': 'Session and tool events from OpenCode.',
  '--vibemon': 'Shared collection and native App launch support for your integrations.'
};

export function setupPreferences({ getFrame, request, run, notify }) {
  let latest = null;
  const save = (action, ...args) => request('settings', action, args);
  const inputs = ['web-url', 'vibemon-serial-port', 'vibemon-url'];
  for (const id of inputs)
    $(id).addEventListener('input', () => {
      $(id).dataset.dirty = 'true';
    });
  function field(id, value) {
    const input = $(id);
    if (!input.dataset.dirty && input.value !== String(value ?? '')) input.value = String(value ?? '');
  }
  function bind(id, action, convert = (input) => input.value, event = 'change') {
    $(id).addEventListener(event, () => {
      const input = $(id);
      run(input, async () => {
        try {
          await save(action, convert(input));
          delete input.dataset.dirty;
        } catch (error) {
          delete input.dataset.dirty;
          if (latest) render(latest);
          throw error;
        }
      });
    });
  }
  for (const [id, action] of [
    ['render-mode', 'set-render-mode'],
    ['character-lock', 'set-character-lock'],
    ['always-on-top', 'set-always-on-top-mode']
  ])
    bind(id, action);
  for (const [id, action] of [
    ['character-scale', 'set-character-scale'],
    ['edge-margin', 'set-edge-margin']
  ])
    bind(id, action, (input) => Number(input.value));
  bind('dock-corner-size', 'set-dock-auto-scale', (input) => input.value === 'shrink');
  bind('open-at-login', 'set-open-at-login', (input) => input.checked);
  bind('dev-mode', 'set-dev-mode', (input) => input.checked);
  bind('vibemon-debug', 'set-vibemon-config', (input) => ({ debug: input.checked }));
  bind('vibemon-auto-launch', 'set-vibemon-config', (input) => ({ auto_launch: input.checked }));
  bind('vibemon-serial-port', 'set-vibemon-config', (input) => ({ serial_port: input.value }), 'blur');
  bind('vibemon-url', 'set-vibemon-config', (input) => ({ vibemon_url: input.value }), 'blur');
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run($('save-connection'), async () => {
      const token = $('read-token').value.trim();
      $('read-token').value = '';
      const cloud = await request('configure', { url: $('web-url').value.trim(), token });
      delete $('web-url').dataset.dirty;
      text(
        $('connection-saved'),
        cloud.status === 'connected' ? 'Connected successfully' : connection(cloud.status)[1]
      );
      if (cloud.status === 'connected') notify('Workspace connected');
    });
  });
  $('disconnect').addEventListener('click', () =>
    run($('disconnect'), async () => {
      $('read-token').value = '';
      await request('disconnect');
      text($('connection-saved'), 'This desktop is disconnected');
    })
  );
  $('preview-companion').addEventListener('click', () =>
    run($('preview-companion'), () => request('show-companion'))
  );
  $('hooks-refresh').addEventListener('click', () =>
    run($('hooks-refresh'), async () => {
      await save('refresh-hook-statuses');
      notify('Integration status refreshed');
    })
  );
  $('hooks-reset-prompts').addEventListener('click', () =>
    run($('hooks-reset-prompts'), () => save('reset-hook-prompts'))
  );
  $('repair-routing').addEventListener('click', () =>
    run($('repair-routing'), () => save('repair-vibemon-config'))
  );
  $('add-http-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(event.submitter, async () => {
      await save('add-http-url', $('new-http-url').value.trim());
      $('new-http-url').value = '';
    });
  });
  $('check-updates').addEventListener('click', () =>
    run($('check-updates'), () => save('check-for-updates'))
  );
  $('update-action').addEventListener('click', () =>
    run($('update-action'), () =>
      save(getFrame().settings.update.status === 'downloaded' ? 'install-downloaded' : 'download-update')
    )
  );
  $('open-releases').addEventListener('click', () =>
    run($('open-releases'), () => save('open-external', 'releases'))
  );
  const storedTheme = window.localStorage.getItem('vibemon.workspace.theme');
  const theme = ['light', 'dark', 'system'].includes(storedTheme) ? storedTheme : 'system';
  document.documentElement.dataset.theme = theme;
  $('theme').value = theme;
  $('theme').addEventListener('change', () => {
    document.documentElement.dataset.theme = $('theme').value;
    window.localStorage.setItem('vibemon.workspace.theme', $('theme').value);
  });

  function render(frame) {
    latest = frame;
    const settings = frame.settings,
      cloud = frame.cloud;
    $('integration-progress').hidden = !settings.installing;
    $('hooks-refresh').disabled = Boolean($('hooks-refresh').dataset.busy) || settings.installing;
    field('web-url', cloud.url);
    text($('token-state'), cloud.tokenConfigured ? 'A token is saved securely' : 'No token saved');
    $('read-token').placeholder = cloud.tokenConfigured
      ? 'Enter a new token to replace the saved one'
      : 'Paste your read token';
    $('disconnect').disabled = Boolean($('disconnect').dataset.busy) || !cloud.tokenConfigured;
    choices(
      $('render-mode'),
      [
        ['3d', '3D pet'],
        ['2d', 'Pixel art']
      ],
      settings.renderMode
    );
    choices(
      $('character-lock'),
      [
        ['auto', 'Follow the active tool'],
        ...settings.options.characters.map((item) => [item.name, item.displayName])
      ],
      settings.characterLock
    );
    choices(
      $('character-scale'),
      settings.options.characterScales.map((value) => [value, `${value}%`]),
      settings.characterScale
    );
    choices($('always-on-top'), Object.entries(settings.options.alwaysOnTopModes), settings.alwaysOnTopMode);
    choices(
      $('edge-margin'),
      settings.options.edgeMargins.map((value) => [value, `${value} px`]),
      settings.edgeMargin
    );
    $('dock-corner-size-row').hidden = !settings.supportsDockCorners;
    choices(
      $('dock-corner-size'),
      [
        ['keep', 'Keep current size'],
        ['shrink', 'Auto shrink']
      ],
      settings.dockAutoScale ? 'shrink' : 'keep'
    );
    for (const [id, checked] of [
      ['open-at-login', settings.openAtLogin],
      ['dev-mode', settings.devMode],
      ['vibemon-debug', settings.vibemonConfig.debug],
      ['vibemon-auto-launch', settings.vibemonConfig.auto_launch]
    ]) {
      if (!$(id).dataset.busy) $(id).checked = Boolean(checked);
    }
    keyed(
      $('character-gallery'),
      settings.options.characters,
      (item) => item.name,
      (item) => {
        const tile = button(
          '',
          () => run(tile, () => save('set-character-lock', item.name)),
          'character-tile'
        );
        const image = el('img');
        image.src = sprite(item.name);
        image.alt = '';
        tile.replaceChildren(image, el('span', item.displayName));
        tile.setAttribute('aria-label', `Use ${item.displayName} character`);
        return tile;
      },
      (tile, item) => tile.setAttribute('aria-pressed', String(settings.characterLock === item.name))
    );
    keyed(
      $('speech-bubble-fields'),
      settings.options.speechBubbleFields,
      (key) => key,
      (key) => {
        const label = el('label', undefined, 'choice');
        const input = el('input');
        input.type = 'checkbox';
        input.addEventListener('change', () =>
          run(input, () => save('set-speech-bubble-field', key, input.checked))
        );
        label.append(input, el('span', fieldLabels[key] || key));
        return label;
      },
      (label, key) => {
        if (!label.firstElementChild.dataset.busy)
          label.firstElementChild.checked = Boolean(settings.speechBubbleFields[key]);
      }
    );
    keyed(
      $('hook-list'),
      settings.hooks,
      (tool) => tool.flag,
      () => {
        const card = el('article', undefined, 'integration-card');
        const heading = el('div', undefined, 'integration-card-header');
        const glyph = el('span', undefined, 'source-icon');
        glyph.append(icon('plug'));
        const title = el('h3'),
          status = el('span', undefined, 'chip');
        heading.append(glyph, title, status);
        const description = el('p');
        const action = button('Install', () =>
          run(action, async () => {
            if (!card._tool.present) {
              await request('open-web', 'docs');
              return;
            }
            await save('install-hook', card._tool.flag);
            notify(`${card._tool.name} installation updated`);
          })
        );
        const detail = el('div', undefined, 'small muted');
        card.append(heading, description, action, detail);
        card._parts = { title, status, description, action, detail };
        return card;
      },
      (card, tool) => {
        card._tool = tool;
        const { title, status, description, action, detail } = card._parts;
        text(title, tool.name);
        text(description, descriptions[tool.flag] || 'Send local tool activity to your desktop.');
        const attention = tool.broken || tool.changed;
        text(
          status,
          !tool.present
            ? 'Not detected'
            : tool.broken
              ? 'Needs repair'
              : tool.changed
                ? 'Update available'
                : tool.hasHook
                  ? 'Installed'
                  : 'Not installed'
        );
        status.className = `chip ${!tool.present ? 'neutral' : attention ? 'warning' : tool.hasHook ? 'good' : 'neutral'}`;
        text(
          action,
          !tool.present
            ? 'Setup guide'
            : tool.hasHook
              ? attention
                ? 'Repair installation'
                : 'Reinstall'
              : 'Install integration'
        );
        action.className = `button ${(tool.hasHook && !attention) || !tool.present ? 'secondary' : ''}`;
        action.disabled = Boolean(action.dataset.busy) || Boolean(settings.installing && tool.present);
        text(
          detail,
          tool.brokenPath
            ? `Missing: ${tool.brokenPath}`
            : tool.dismissed
              ? 'Automatic installation prompts are off.'
              : ''
        );
        detail.hidden = !detail.textContent;
      }
    );
    $('hooks-reset-prompts').hidden = !settings.hooks.some((tool) => tool.dismissed);
    const config = settings.vibemonConfig;
    text($('routing-status'), config.status.error ? 'Check configuration' : config.status.hasDesktopUrl ? 'Desktop connected' : 'Setup needed');
    $('routing-status').className = `chip ${config.status.error ? 'warning' : config.status.hasDesktopUrl ? 'good' : 'neutral'}`;
    text($('routing-error'), config.status.error || '');
    $('routing-error').hidden = !config.status.error;
    keyed(
      $('http-destinations'),
      config.http_urls,
      (url) => url,
      (url) => {
        const row = el('div', undefined, 'destination-row');
        const remove = button(
          '',
          () => run(remove, () => save('remove-http-url', url)),
          'icon-button',
          'close'
        );
        remove.setAttribute('aria-label', `Remove ${url}`);
        row.append(el('span', url), remove);
        return row;
      },
      () => {}
    );
    field('vibemon-serial-port', config.serial_port);
    field('vibemon-url', config.vibemon_url);
    text($('app-version'), `Version ${settings.version}`);
    text($('footer-version'), settings.version);
    const update = settings.update;
    const updateDescriptions = {
      current: 'You are using the latest available version.',
      error: 'The update could not finish. Check again to try another download.',
      checking: 'Checking for a new version…',
      available: `Version ${update.version} is available.`,
      downloading: `Downloading version ${update.version}…`,
      downloaded: `Version ${update.version} is ready to install.`
    };
    text(
      $('update-status'),
      !settings.isPackaged
        ? 'Updates are available in the installed App.'
        : updateDescriptions[update.status] || 'Check for the latest available version.'
    );
    $('check-updates').disabled =
      Boolean($('check-updates').dataset.busy) ||
      !settings.isPackaged ||
      ['checking', 'downloading', 'downloaded'].includes(update.status);
    $('update-action').hidden = !['available', 'downloaded'].includes(update.status);
    text($('update-action'), update.status === 'downloaded' ? 'Restart and install' : 'Download update');
  }
  return {
    render,
    leave() {
      $('read-token').value = '';
    }
  };
}
