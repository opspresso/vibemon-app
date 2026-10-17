jest.mock('electron', () => ({ Menu: { buildFromTemplate: jest.fn(items => items), setApplicationMenu: jest.fn() } }));
const { Menu } = require('electron');
const { installWorkspaceMenu } = require('../src/workspace/menu.cjs');

test.each(['darwin', 'win32'])('%s application menus navigate the workspace and preserve native editing', platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  const open = jest.fn(), showCompanion = jest.fn();
  try {
    const menu = installWorkspaceMenu({ open, showCompanion });
    expect(Menu.setApplicationMenu).toHaveBeenLastCalledWith(menu);
    expect(menu.some(item => item.role === 'editMenu')).toBe(true);
    expect(menu.some(item => item.role === 'windowMenu')).toBe(platform === 'darwin');
    const app = menu[0].submenu;
    expect(app.some(item => item.role === 'quit')).toBe(true);
    app.find(item => item.label === 'About VibeMon').click();
    const settings = app.find(item => item.label === 'Settings…');
    expect(settings.accelerator).toBe('CmdOrCtrl+,'); settings.click();
    const workspace = menu.find(item => item.label === 'Workspace').submenu;
    expect(workspace.slice(0, 3).map(item => item.accelerator)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3']);
    for (const item of workspace) item.click?.();
    expect(open.mock.calls).toEqual([['about'], ['companion'], ['overview'], ['resources'], ['agents'], ['connections'], ['integrations']]);
    expect(showCompanion).toHaveBeenCalledTimes(1);
  } finally { Object.defineProperty(process, 'platform', original); }
});

test('role menu items use the App language', () => {
  const { setLocale } = require('../src/shared/i18n/locale.cjs');
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  setLocale('ko');
  try {
    const menu = installWorkspaceMenu({ open: jest.fn(), showCompanion: jest.fn() });
    const roles = menu.flatMap(item => [item, ...(item.submenu ?? [])]).filter(item => item.role);
    expect(roles.filter(item => !item.label)).toEqual([]);
    expect(menu.find(item => item.role === 'editMenu').submenu.map(item => item.label).filter(Boolean)).toEqual(['실행 취소', '실행 복귀', '오려두기', '복사하기', '붙여넣기', '전체 선택']);
    expect(menu[0].submenu.find(item => item.role === 'quit').label).toBe('VibeMon 종료');
  } finally {
    setLocale('en');
    Object.defineProperty(process, 'platform', original);
  }
});
