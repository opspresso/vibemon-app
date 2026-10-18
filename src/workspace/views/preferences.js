import { $, el, text, icon, keyed, choices, sprite, button, connection } from '../dom.js';
import { t, locale } from '../i18n.js';

// Speech bubble fields and installer flags with a message in the catalog.
const bubbleFields = new Set(['status', 'project', 'model', 'memory', 'usage5h', 'usageWeek', 'usageWeekModel']);
const hookFlags = new Set(['--claude', '--codex', '--kiro', '--openclaw', '--opencode', '--vibemon']);

export function setupPreferences({ getFrame, request, run, notify }) {
  $('accounts-guide').addEventListener('click', () => run($('accounts-guide'), () => save('open-external', 'accounts')));
  let latest = null;
  let deliveryError = '';
  const runDelivery = (control, action) => {
    deliveryError = '';
    return run(control, action, error => { deliveryError = error.message; });
  };
  const save = (action, ...args) => request('settings', action, args);
  const inputs = ['web-url', 'vibemon-serial-port', 'cloud-delivery-url'];
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
  $('open-write-token-account').addEventListener('click', () => runDelivery($('open-write-token-account'), () => request('open-write-token-account', $('cloud-delivery-url').value.trim())));
  $('cloud-delivery-form').addEventListener('submit', event => {
    event.preventDefault();
    runDelivery($('save-cloud-delivery'), async () => {
      const token = $('cloud-write-token').value.trim();
      $('cloud-write-token').value = '';
      await save('configure-cloud-delivery', { url: $('cloud-delivery-url').value.trim(), token });
      delete $('cloud-delivery-url').dataset.dirty;
      notify(t('toast.deliverySaved'));
    });
  });
  $('check-cloud-delivery').addEventListener('click', () => runDelivery($('check-cloud-delivery'), async () => {
    await save('check-cloud-delivery');
    notify(t('toast.writeVerified'));
  }));
  $('disconnect-cloud-delivery').addEventListener('click', () => runDelivery($('disconnect-cloud-delivery'), async () => {
    $('cloud-write-token').value = '';
    const { tokenDeleted } = await save('disconnect-cloud-delivery');
    notify(t(tokenDeleted ? 'toast.writeTokenRemoved' : 'toast.writeTokenKept'));
  }));
  // While the browser is open, Cancel stops waiting so the person can start again.
  const waiting = async (cancel, action) => {
    $(cancel).hidden = false;
    try { return await action(); } finally { $(cancel).hidden = true; }
  };
  for (const id of ['cancel-sign-in', 'cancel-cloud-sign-in']) $(id).addEventListener('click', () => request('cancel-sign-in'));
  $('sign-in').addEventListener('click', () =>
    run($('sign-in'), () => waiting('cancel-sign-in', async () => {
      text($('connection-saved'), t('connections.finishInBrowser'));
      try {
        const cloud = await request('sign-in', $('web-url').value.trim());
        delete $('web-url').dataset.dirty;
        text($('connection-saved'), cloud.status === 'connected' ? t('connections.connected') : connection(cloud.status)[1]);
        if (cloud.status === 'connected') notify(t('toast.connected'));
      } catch (error) {
        text($('connection-saved'), '');
        throw error;
      }
    }))
  );
  $('sign-in-cloud-delivery').addEventListener('click', () => runDelivery($('sign-in-cloud-delivery'), () => waiting('cancel-cloud-sign-in', async () => {
    $('cloud-delivery-help').textContent = t('connections.finishInBrowser');
    await request('sign-in-cloud-delivery', $('cloud-delivery-url').value.trim());
    delete $('cloud-delivery-url').dataset.dirty;
    notify(t('toast.deliverySignedIn'));
  })));
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run($('save-connection'), async () => {
      const token = $('read-token').value.trim();
      $('read-token').value = '';
      const cloud = await request('configure', { url: $('web-url').value.trim(), token });
      delete $('web-url').dataset.dirty;
      text(
        $('connection-saved'),
        cloud.status === 'connected' ? t('connections.connected') : connection(cloud.status)[1]
      );
      if (cloud.status === 'connected') notify(t('toast.connected'));
    });
  });
  $('disconnect').addEventListener('click', () =>
    run($('disconnect'), async () => {
      $('read-token').value = '';
      const result = await request('disconnect');
      text($('connection-saved'), t(result.tokenDeleted ? 'connections.disconnectedDeleted' : 'connections.disconnectedKept'));
    })
  );
  $('preview-companion').addEventListener('click', () =>
    run($('preview-companion'), () => request('show-companion'))
  );
  $('hooks-refresh').addEventListener('click', () =>
    run($('hooks-refresh'), async () => {
      await save('refresh-hook-statuses');
      notify(t('toast.integrationsRefreshed'));
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
  const appearanceNotice = message => {
    text($('theme-storage-status'), message);
    $('theme-storage-status').hidden = !message;
  };
  const themes = ['light', 'dark', 'system'];
  const sessionOnly = t('companion.themeSessionOnly');
  let storedTheme = null;
  try { storedTheme = window.localStorage.getItem('vibemon.workspace.theme'); }
  catch { appearanceNotice(sessionOnly); }
  if (storedTheme !== null && !themes.includes(storedTheme)) appearanceNotice(t('companion.themeInvalid'));
  const theme = themes.includes(storedTheme) ? storedTheme : 'system';
  document.documentElement.dataset.theme = theme;
  $('theme').value = theme;
  $('theme').addEventListener('change', () => {
    document.documentElement.dataset.theme = $('theme').value;
    try {
      window.localStorage.setItem('vibemon.workspace.theme', $('theme').value);
      appearanceNotice('');
    } catch { appearanceNotice(sessionOnly); }
  });

  function render(frame) {
    latest = frame;
    const settings = frame.settings,
      cloud = frame.cloud;
    $('integration-progress').hidden = !settings.installing;
    $('hooks-refresh').disabled = Boolean($('hooks-refresh').dataset.busy) || settings.installing;
    field('web-url', cloud.url);
    text($('token-state'), t(cloud.tokenConfigured ? 'connections.tokenSaved' : 'connections.noToken'));
    $('read-token').placeholder = t(cloud.tokenConfigured ? 'connections.replaceToken' : 'connections.pasteToken');
    $('disconnect').disabled = Boolean($('disconnect').dataset.busy) || !cloud.tokenConfigured;
    choices(
      $('render-mode'),
      [
        ['3d', t('companion.render3d')],
        ['2d', t('companion.render2d')]
      ],
      settings.renderMode
    );
    choices(
      $('character-lock'),
      [
        ['auto', t('companion.followTool')],
        ...settings.options.characters.map((item) => [item.name, item.displayName])
      ],
      settings.characterLock
    );
    choices(
      $('character-scale'),
      settings.options.characterScales.map((value) => [value, t('companion.scale', { value })]),
      settings.characterScale
    );
    choices($('always-on-top'), Object.entries(settings.options.alwaysOnTopModes).map(([mode, label]) => [mode, t.has(`companion.onTopMode.${mode}`) ? t(`companion.onTopMode.${mode}`) : label]), settings.alwaysOnTopMode);
    choices(
      $('edge-margin'),
      settings.options.edgeMargins.map((value) => [value, t('companion.pixels', { value })]),
      settings.edgeMargin
    );
    $('dock-corner-size-row').hidden = !settings.supportsDockCorners;
    choices(
      $('dock-corner-size'),
      [
        ['keep', t('companion.dockKeep')],
        ['shrink', t('companion.dockShrink')]
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
        tile.setAttribute('aria-label', t('companion.useCharacter', { name: item.displayName }));
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
        label.append(input, el('span', bubbleFields.has(key) ? t(`companion.field.${key}`) : key));
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
        const action = button(t('dialog.button.install'), () =>
          run(action, async () => {
            if (!card._tool.present) {
              await request('open-web', 'docs');
              return;
            }
            await save('install-hook', card._tool.flag);
            notify(t('toast.installUpdated', { name: card._tool.name }));
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
        text(description, t(hookFlags.has(tool.flag) ? `integrations.hook.${tool.flag.slice(2)}` : 'integrations.hook.default'));
        const attention = tool.broken || tool.changed;
        text(
          status,
          t(!tool.present
            ? 'integrations.status.notDetected'
            : tool.broken
              ? 'integrations.status.needsRepair'
              : tool.changed
                ? 'integrations.status.update'
                : tool.hasHook
                  ? 'integrations.status.installed'
                  : 'integrations.status.notInstalled')
        );
        status.className = `chip ${!tool.present ? 'neutral' : attention ? 'warning' : tool.hasHook ? 'good' : 'neutral'}`;
        text(
          action,
          t(!tool.present
            ? 'integrations.action.guide'
            : tool.hasHook
              ? attention
                ? 'integrations.action.repair'
                : 'integrations.action.reinstall'
              : 'integrations.action.install')
        );
        action.className = `button ${(tool.hasHook && !attention) || !tool.present ? 'secondary' : ''}`;
        action.disabled = Boolean(action.dataset.busy) || Boolean(settings.installing && tool.present);
        text(
          detail,
          tool.brokenPath
            ? t('integrations.missing', { path: tool.brokenPath })
            : tool.dismissed
              ? t('integrations.promptsOff')
              : ''
        );
        detail.hidden = !detail.textContent;
      }
    );
    const profiles = settings.accountProfiles || [];
    $('account-profiles-empty').hidden = profiles.length > 0;
    keyed($('account-profiles'), profiles, profile => profile.key, () => {
      const card = el('article', undefined, 'integration-card');
      const title = el('h4');
      const kind = el('span', undefined, 'chip neutral');
      const scope = el('p', undefined, 'small muted');
      const details = el('details', undefined, 'advanced');
      const summary = el('summary', t('accounts.profile'));
      const root = el('p', undefined, 'small muted');
      const checked = el('p', undefined, 'small muted');
      const usage = el('p', undefined, 'small muted');
      details.append(summary, root, checked);
      card.append(title, kind, scope, usage, details);
      card._parts = { title, kind, scope, root, checked, usage };
      return card;
    }, (card, profile) => {
      const { title, kind, scope, root, checked, usage } = card._parts;
      text(title, profile.account.displayName);
      text(kind, t(`accounts.kind.${profile.account.kind}`));
      kind.className = `chip ${profile.account.kind === 'account' ? 'good' : 'neutral'}`;
      text(scope, [profile.provider, profile.instance, profile.context].filter(Boolean).join(' · '));
      text(root, profile.root);
      text(checked, profile.checkedAt ? t('accounts.observed', { time: new Date(profile.checkedAt * 1000).toLocaleString(locale) }) : '');
      text(usage, profile.usageRefreshFailed ? t('accounts.usageUnavailable') : '');
      usage.hidden = !profile.usageRefreshFailed;
    });
    $('hooks-reset-prompts').hidden = !settings.hooks.some((tool) => tool.dismissed);
    const config = settings.vibemonConfig;
    text($('routing-status'), t(config.status.error ? 'routing.status.error' : config.status.hasDesktopUrl ? 'routing.status.connected' : 'routing.status.setup'));
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
        remove.setAttribute('aria-label', t('routing.remove', { url }));
        row.append(el('span', url), remove);
        return row;
      },
      () => {}
    );
    field('vibemon-serial-port', config.serial_port);
    const delivery = settings.cloudDelivery;
    field('cloud-delivery-url', delivery.url);
    $('cloud-delivery-url').disabled = delivery.busy;
    $('cloud-write-token').disabled = delivery.busy;
    const deliveryLabels = { 'not-configured': 'notConfigured', 'not-verified': 'notVerified', checking: 'checking', verified: 'verified', error: 'error' };
    text($('cloud-delivery-status'), Object.hasOwn(deliveryLabels, delivery.status) ? t(`cloudDelivery.status.${deliveryLabels[delivery.status]}`) : '');
    $('cloud-delivery-status').className = `chip ${delivery.status === 'verified' ? 'good' : delivery.status === 'error' ? 'warning' : 'neutral'}`;
    text($('cloud-token-state'), t(delivery.tokenConfigured ? 'cloudDelivery.tokenSaved' : 'cloudDelivery.noToken'));
    $('cloud-write-token').placeholder = t(delivery.tokenConfigured ? 'cloudDelivery.replaceToken' : 'cloudDelivery.writeTokenPlaceholder');
    for (const id of ['save-cloud-delivery', 'check-cloud-delivery', 'disconnect-cloud-delivery']) {
      $(id).disabled = Boolean($(id).dataset.busy) || delivery.busy || (id !== 'save-cloud-delivery' && !delivery.tokenConfigured);
    }
    const cloudError = deliveryError || (delivery.busy ? '' : delivery.error);
    text($('cloud-delivery-error'), cloudError);
    $('cloud-delivery-error').hidden = !cloudError;
    text($('cloud-delivery-help'), delivery.checkedAt ? t('cloudDelivery.lastChecked', { time: new Date(delivery.checkedAt).toLocaleTimeString(locale) }) : t('cloudDelivery.localStays'));
    text($('app-version'), t('about.version', { version: settings.version }));
    text($('footer-version'), settings.version);
    const update = settings.update;
    const updateStates = new Set(['current', 'error', 'checking', 'available', 'downloading', 'downloaded']);
    text(
      $('update-status'),
      t(!settings.isPackaged
        ? 'about.update.unpackaged'
        : updateStates.has(update.status) ? `about.update.${update.status}` : 'about.update.idle', { version: update.version })
    );
    $('check-updates').disabled =
      Boolean($('check-updates').dataset.busy) ||
      !settings.isPackaged ||
      ['checking', 'downloading', 'downloaded'].includes(update.status);
    $('update-action').hidden = !['available', 'downloaded'].includes(update.status);
    text($('update-action'), t(update.status === 'downloaded' ? 'about.restartInstall' : 'about.download'));
  }
  return {
    render,
    leave() {
      $('read-token').value = '';
      $('cloud-write-token').value = '';
    }
  };
}
