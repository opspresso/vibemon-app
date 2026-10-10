const { Menu } = require('electron');

function installWorkspaceMenu({ open, showCompanion }) {
  const mac = process.platform === 'darwin';
  const settings = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => open('companion') };
  const about = { label: 'About VibeMon', click: () => open('about') };
  const application = mac
    ? [about, { type: 'separator' }, settings, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }]
    : [settings, about, { type: 'separator' }, { role: 'quit' }];
  const workspace = [
    ...[['Overview', 'overview'], ['Resources', 'resources'], ['Coding agents', 'agents']].map(([label, route], index) => ({ label, accelerator: `CmdOrCtrl+${index + 1}`, click: () => open(route) })),
    { type: 'separator' },
    { label: 'Connections', click: () => open('connections') },
    { label: 'Integrations', click: () => open('integrations') },
    { label: 'Show companion', click: showCompanion },
    { type: 'separator' },
    { role: 'close', label: 'Close window', accelerator: 'CmdOrCtrl+W' }
  ];
  const menu = Menu.buildFromTemplate([
    { label: 'VibeMon', submenu: application },
    { role: 'editMenu' },
    { label: 'Workspace', submenu: workspace },
    ...(mac ? [{ role: 'windowMenu' }] : [])
  ]);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { installWorkspaceMenu };
