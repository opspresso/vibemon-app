// Native rendering and OS credential verification against an isolated Web fixture.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Store = require('electron-store');
const { MonitoringClient } = require('../../src/monitoring/client.cjs');
const { CredentialStore } = require('../../src/monitoring/credential-store.cjs');
const { MonitoringWindow } = require('../../src/monitoring/window.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-native-monitoring-'));
app.setPath('userData', directory);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); }
  throw new Error('Monitoring UI did not become ready');
}
app.whenReady().then(async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.VIBEMON_TEST_FIXTURE, 'utf8'));
  const preferences = new Store({ name: 'monitoring' });
  const credentials = new CredentialStore(preferences, safeStorage);
  assert.ok(credentials.available(), 'OS secure storage must be available');
  const client = new MonitoringClient({ preferences, credentials, allowLocalHttp: true });
  const snapshot = await client.configure({ url: 'http://127.0.0.1:3180', token: fixture.readToken });
  assert.equal(snapshot.status, 'connected');
  assert.ok(snapshot.sources.some(source => source.sourceId === 'spark-0702'));
  assert.ok(!fs.readFileSync(preferences.path, 'utf8').includes(fixture.readToken));
  const view = new MonitoringWindow(client);
  view.open();
  await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll(".card").length > 0'));
  await view.window.webContents.executeJavaScript('document.getElementById("settings").open = false;');
  await delay(250);
  fs.writeFileSync(path.join(__dirname, '..', '..', 'docs', 'images', 'monitoring-spark.png'), (await view.window.webContents.capturePage()).toPNG());
  await view.window.webContents.executeJavaScript('document.querySelector(".card button").click();');
  await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll("#chart circle").length > 0'));
  const result = await view.window.webContents.executeJavaScript('({ cards: document.querySelectorAll(".card").length, gauges: document.querySelectorAll("progress").length, points: document.querySelectorAll("#chart circle").length, unified: document.body.textContent.includes("Unified memory"), credentialVisible: Boolean(document.getElementById("read-token").value) })');
  assert.ok(result.gauges >= 3); assert.equal(result.unified, true); assert.equal(result.credentialVisible, false);
  await delay(250);
  const image = await view.window.webContents.capturePage();
  const destination = path.join(__dirname, '..', '..', 'docs', 'images', 'monitoring-spark-trend.png');
  fs.writeFileSync(destination, image.toPNG());
  console.log('PASS native monitoring:', JSON.stringify(result));
  view.cleanup(); client.stop(); credentials.clear();
  app.quit();
}).catch(error => { console.error(error.name, error.message); app.exit(1); });
