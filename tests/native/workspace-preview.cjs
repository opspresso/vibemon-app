// The fixture owns isolated preferences, a loopback API, and fake integration ports.
const { app } = require('electron');
const { startFixture } = require('./workspace-fixture.cjs');
startFixture().then(({ client }) => {
  client.start();
  console.log('Workspace preview running with isolated demo data.');
}).catch(error => { console.error(error.stack); app.exit(1); });
