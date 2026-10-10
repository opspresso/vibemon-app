// The fixture owns isolated preferences, a loopback API, and fake integration ports.
const { startFixture } = require('./workspace-fixture.cjs');
const { app } = require('electron');
startFixture().then(({ client, view }) => {
  view.window.on('hide', () => console.log('Preview workspace hidden.'));
  view.window.on('show', () => console.log(`Preview workspace shown: ${view.route}.`));
  client.start();
  console.log('Workspace preview running with isolated demo data and a preview tray icon.');
}).catch(error => { console.error(error.stack); app.exit(1); });
