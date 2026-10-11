// Native rendering and OS credential verification against an isolated Web fixture.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Store = require('electron-store');
const { MonitoringClient } = require('../../src/monitoring/client.cjs');
const { CredentialStore } = require('../../src/monitoring/credential-store.cjs');
const { WorkspaceWindow } = require('../../src/workspace/window.cjs');
const { WorkspaceSettings } = require('../../src/workspace/settings.cjs');
const { createPorts } = require('../fixtures/workspace.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-native-monitoring-'));
const artifacts = process.env.VIBEMON_TEST_ARTIFACTS || path.join(__dirname, '..', '..', 'out', 'monitoring-tests');
fs.mkdirSync(artifacts, { recursive: true });
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
  const snapshot = await client.configure({ url: process.env.VIBEMON_TEST_ORIGIN || 'http://127.0.0.1:3180', token: fixture.readToken });
  assert.equal(snapshot.status, 'connected');
  assert.ok(snapshot.sources.some(source => source.sourceId === 'spark-0702'));
  assert.ok(!fs.readFileSync(preferences.path, 'utf8').includes(fixture.readToken));
  await client.select({ sources: ['spark-0702'], accounts: [], metrics: ['cpuPercent', 'memoryPercent', 'gpuPercent', 'gpuTemperatureC'] });
  const ports = createPorts();
  const view = new WorkspaceWindow({ monitoring: client, settings: new WorkspaceSettings(ports), ...ports, reportError: error => { throw error; } });
  view.open('resources');
  await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll("[data-page]:not([hidden]) .card").length > 0'));
  await delay(250);
  fs.writeFileSync(path.join(artifacts, 'monitoring-spark.png'), (await view.window.webContents.capturePage()).toPNG());
  await view.window.webContents.executeJavaScript('document.querySelector("[data-page]:not([hidden]) .card button").click();');
  await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll("#chart circle").length > 0'));
  const result = await view.window.webContents.executeJavaScript('({ cards: document.querySelectorAll("[data-page]:not([hidden]) .card").length, gauges: document.querySelectorAll("#resource-cards [role=meter]").length, points: document.querySelectorAll("#chart circle").length, unified: document.body.textContent.includes("Unified memory"), credentialVisible: Boolean(document.getElementById("read-token").value) })');
  assert.ok(result.gauges >= 3); assert.equal(result.unified, true); assert.equal(result.credentialVisible, false);
  await delay(250);
  const image = await view.window.webContents.capturePage();
  const destination = path.join(artifacts, 'monitoring-spark-trend.png');
  fs.writeFileSync(destination, image.toPNG());
  console.log('PASS native monitoring:', JSON.stringify(result));
  if (snapshot.accounts.some(account => account.accountId === 'codex:work')) {
    view.open('agents');
    await view.window.webContents.executeJavaScript('document.querySelector("[data-close-dialog=detail-dialog]").click();');
    await client.select({ sources: [], accounts: ['codex:work', 'claude:personal'], metrics: ['contextPercent', 'usageSessionPercent', 'usageWeekPercent'] });
    await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll("[data-page]:not([hidden]) .card").length === 2'));
    const names = await view.window.webContents.executeJavaScript('[...document.querySelectorAll("#agent-cards h3")].map(element => element.textContent).sort()');
    assert.deepEqual(names, ['Fixture claude personal', 'Fixture codex work']);
    await view.window.webContents.executeJavaScript('document.getElementById("main").scrollTop = 0;');
    await view.window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(150);
    fs.writeFileSync(path.join(artifacts, 'monitoring-accounts.png'), (await view.window.webContents.capturePage()).toPNG());
    await view.window.webContents.executeJavaScript('document.querySelector("[data-page]:not([hidden]) .card button").click();');
    await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll("#chart circle").length > 0'));
    console.log('PASS native account selection: two same-project provider accounts and account trend');
  }
  if (snapshot.sources.some(source => source.sourceId === 'k8s-live')) {
    view.open('resources');
    await view.window.webContents.executeJavaScript('document.querySelector("[data-close-dialog=detail-dialog]").click();');
    await client.select({ sources: ['spark-0702', 'k8s-live'], accounts: [], metrics: ['cpuPercent', 'memoryPercent', 'gpuPercent', 'gpuTemperatureC', 'nodesReady', 'nodesTotal', 'podsUnhealthy'] });
    await until(() => view.window.webContents.executeJavaScript('document.querySelectorAll("[data-page]:not([hidden]) .card").length === 2'));
    const text = await view.window.webContents.executeJavaScript('document.getElementById("resource-cards").textContent');
    assert.ok(text.includes('Ready nodes')); assert.ok(text.includes('Unified memory'));
    await view.window.webContents.executeJavaScript('document.getElementById("main").scrollTop = 0;');
    await view.window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(150);
    fs.writeFileSync(path.join(artifacts, 'monitoring-resources.png'), (await view.window.webContents.capturePage()).toPNG());
    console.log('PASS native resource selection: real Spark and Kubernetes summaries');
  }
  await view.window.webContents.executeJavaScript('document.querySelector("[data-close-dialog=detail-dialog]").click();');
  await assert.rejects(client.configure({ url: snapshot.url, token: 'vm_' + '0'.repeat(60) }));
  assert.equal(client.getStatus(), 'connected', 'rejected candidates preserve a working read connection');
  preferences.set('credential', 'corrupt');
  await client.poll(true);
  assert.equal(client.getStatus(), 'credential-unavailable');
  await until(() => view.window.webContents.executeJavaScript('document.getElementById("connection-chip").textContent.includes("Replace saved token") && !document.getElementById("connection-notice").hidden'));
  await client.configure({ url: snapshot.url, token: fixture.readToken });
  assert.equal(client.getStatus(), 'connected');
  console.log('PASS native recovery: rejected/corrupt credentials remain distinct from network errors and offer connection settings');
  view.cleanup(); client.stop(); credentials.clear();
  app.quit();
}).catch(error => { console.error(error.name, error.message); app.exit(1); });
