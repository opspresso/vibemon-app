const { Menu } = require('electron');
const { t } = require('../shared/i18n/locale.cjs');

// Role items (Edit, Window, Hide, Quit) keep the labels that Electron gives them.

function installWorkspaceMenu({ open, showCompanion }) {
  const mac = process.platform === 'darwin';
  const settings = { label: t('action.settingsMenu'), accelerator: 'CmdOrCtrl+,', click: () => open('companion') };
  const about = { label: t('action.aboutApp'), click: () => open('about') };
  const application = mac
    ? [about, { type: 'separator' }, settings, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
    : [settings, about, { type: 'separator' }, { role: 'quit' }];
  const workspace = [
    ...['overview', 'resources', 'agents'].map((route, index) => ({ label: t(`nav.${route}`), accelerator: `CmdOrCtrl+${index + 1}`, click: () => open(route) })),
    { type: 'separator' },
    { label: t('nav.connections'), click: () => open('connections') },
    { label: t('nav.integrations'), click: () => open('integrations') },
    { label: t('action.showCompanion'), click: showCompanion },
    { type: 'separator' },
    { role: 'close', label: t('action.closeWindow'), accelerator: 'CmdOrCtrl+W' }
  ];
  const menu = Menu.buildFromTemplate([
    { label: 'VibeMon', submenu: application },
    { role: 'editMenu' },
    { label: t('nav.workspace'), submenu: workspace },
    ...(mac ? [{ role: 'windowMenu' }] : [])
  ]);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { installWorkspaceMenu };
