// The fixture owns isolated preferences, a loopback API, and fake integration ports.
const { app } = require('electron');
const { startFixture } = require('./workspace-fixture.cjs');
const { TrayManager } = require('../../src/modules/tray-manager.cjs');
startFixture().then(({ client, view, ports }) => {
  const tray = new TrayManager({ getProjectIds: () => [], getState: () => null }, app, client);
  tray.openDashboard = () => view.open('overview');
  tray.openSettings = page => view.open(page);
  tray.setShowCharacterHandler(ports.showCompanion);
  tray.createTray();
  tray.tray.setToolTip('VibeMon workspace preview');
  view.window.on('hide', () => console.log('Preview workspace hidden.'));
  view.window.on('show', () => console.log(`Preview workspace shown: ${view.route}.`));
  app.once('before-quit', () => tray.cleanup());
  client.start();
  console.log('Workspace preview running with isolated demo data and a preview tray icon.');
}).catch(error => { console.error(error.stack); app.exit(1); });
