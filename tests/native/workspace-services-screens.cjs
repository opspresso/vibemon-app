// Captures the Connected services screens in the fixture language (VIBEMON_LOCALE),
// in the light and dark themes: pnpm screens:services, or VIBEMON_LOCALE=ko pnpm screens:services.
const { app, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./workspace-fixture.cjs');
const output = process.env.VIBEMON_TEST_ARTIFACTS || path.join(__dirname, '../../out/workspace-tests');
const locale = process.env.VIBEMON_LOCALE || 'en';
fs.mkdirSync(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let cleanup;
startFixture().then(async fixture => {
  cleanup = fixture.cleanup;
  const { view, errors } = fixture;
  const web = view.window.webContents;
  const ui = code => web.executeJavaScript(code);
  async function until(check, label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await check()) return; await delay(50); }
    throw new Error(`Screen condition failed: ${label}`);
  }
  const visible = selector => ui(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
  const navigate = async route => {
    view.open(route);
    await until(() => visible(`section[data-page="${route}"]`), `${route} page`);
  };
  const capture = async name => {
    await until(() => ui('document.getElementById("toast").hidden'), 'toast hidden');
    await ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(250);
    const file = path.join(output, `services-${locale}-${nativeTheme.themeSource}-${name}.png`);
    fs.writeFileSync(file, (await web.capturePage()).toPNG());
    console.log(`Capture: ${path.relative(process.cwd(), file)}`);
  };
  const card = id => `[...document.querySelectorAll("#agent-cards .card")].find(card => card._source.sourceId === ${JSON.stringify(id)})`;
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await ui(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await navigate('services');
    await until(() => ui('document.querySelectorAll("#service-list .service-row").length === 2'), 'two connections');
    await capture('list');
    await ui('document.querySelector("#service-list .service-connect button:first-child").click()');
    await until(() => visible('#service-start'), 'Claude choice');
    await capture('connect-claude-choice');
    await ui('document.getElementById("service-start").click()');
    await until(() => visible('[data-service-phase="code"]'), 'Claude code step');
    await capture('connect-claude');
    await ui('document.getElementById("service-dialog").close()');
    await ui('document.querySelector("#service-list .service-connect button:last-child").click()');
    await ui('document.getElementById("service-start").click()');
    await until(() => visible('[data-service-phase="device"]'), 'Codex device step');
    await capture('connect-codex');
    await ui('document.getElementById("service-dialog").close()');
    await navigate('agents');
    await until(() => ui(`Boolean(${card('codex:auto:solo')})`), 'connected-only card');
    await ui(`${card('claude:studio')}.scrollIntoView({ block: 'start' })`);
    await capture('agent-cards');
    await ui(`${card('codex:auto:solo')}.scrollIntoView({ block: 'center' })`);
    await capture('connected-only-card');
    await ui(`${card('claude:studio')}._parts.details.click()`);
    await until(() => visible('#detail-connection'), 'account details');
    await ui('document.getElementById("detail-connection").scrollIntoView({ block: "center" })');
    await capture('account-details');
    await ui('document.getElementById("detail-dialog").close()');
  }
  if (!fixture.state.usage.requests.some(request => request.startsWith('DELETE /api/v1/usage/authorizations/'))) throw new Error('closed sign-ins were not cancelled');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`PASS Connected services screens: ${locale}, light and dark.`);
  app.quit();
}).catch(error => { console.error(error?.stack || error); cleanup?.(); app.exit(1); });
