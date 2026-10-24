const { Menu } = require('electron');
const { t } = require('../shared/i18n/locale.cjs');

// Electron gives role items English labels, so every role item sets its label.
const item = (role, key) => ({ role, label: t(key) });

/**
 * Installs the application menu. `companionShown` chooses between Show and
 * Hide companion; reinstall the menu when it changes.
 */
function installWorkspaceMenu({ open, companionShown, setCompanionVisible }) {
  const mac = process.platform === 'darwin';
  const settings = { label: t('action.settingsMenu'), accelerator: 'CmdOrCtrl+,', click: () => open('companion') };
  const about = { label: t('action.aboutApp'), click: () => open('about') };
  const application = mac
    ? [about, { type: 'separator' }, settings, { type: 'separator' }, item('services', 'menu.services'), { type: 'separator' },
      item('hide', 'menu.hide'), item('hideOthers', 'menu.hideOthers'), item('unhide', 'menu.unhide'), { type: 'separator' }, item('quit', 'action.quitApp')]
    : [settings, about, { type: 'separator' }, item('quit', 'action.quitApp')];
  const edit = [
    item('undo', 'menu.undo'), item('redo', 'menu.redo'), { type: 'separator' },
    item('cut', 'menu.cut'), item('copy', 'menu.copy'), item('paste', 'menu.paste'),
    ...(mac ? [item('pasteAndMatchStyle', 'menu.pasteAndMatchStyle')] : []), item('delete', 'menu.delete'), item('selectAll', 'menu.selectAll')
  ];
  const windows = [item('minimize', 'menu.minimize'), item('zoom', 'menu.zoom'), { type: 'separator' }, item('front', 'menu.front')];
  const workspace = [
    ...['overview', 'agents', 'resources'].map((route, index) => ({ label: t(`nav.${route}`), accelerator: `CmdOrCtrl+${index + 1}`, click: () => open(route) })),
    { type: 'separator' },
    { label: t('nav.connections'), click: () => open('connections') },
    { label: t('nav.integrations'), click: () => open('integrations') },
    companionShown
      ? { label: t('action.hideCompanion'), click: () => setCompanionVisible(false) }
      : { label: t('action.showCompanion'), click: () => setCompanionVisible(true) },
    { type: 'separator' },
    { role: 'close', label: t('action.closeWindow'), accelerator: 'CmdOrCtrl+W' }
  ];
  const menu = Menu.buildFromTemplate([
    { label: 'VibeMon', submenu: application },
    { role: 'editMenu', label: t('menu.edit'), submenu: edit },
    { label: t('nav.workspace'), submenu: workspace },
    // The windowMenu role keeps the macOS window list in this menu.
    ...(mac ? [{ role: 'windowMenu', label: t('menu.window'), submenu: windows }] : [])
  ]);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { installWorkspaceMenu };
