// Native contract tests use disposable data, the real preload, and a loopback HTTP API.
const { app, Menu, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { startFixture, TOKEN, WRITE_TOKEN, CLAUDE_CODE } = require('./workspace-fixture.cjs');
const { usageConnections, USAGE_IDS } = require('../fixtures/workspace.cjs');
const { AGENT_TEXT_LIMITS } = require('../../src/shared/resource-schema.cjs');
const { colorPair, readTokens } = require('../../src/shared/design/tokens.cjs');
const output = process.env.VIBEMON_TEST_ARTIFACTS || path.join(__dirname, '../../out/workspace-tests');
fs.mkdirSync(output, { recursive: true });
nativeTheme.themeSource = 'dark';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Set once the workspace exists: records the state of a failed condition.
let diagnose = async () => {};
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  await diagnose(label);
  throw new Error(`Workspace condition failed: ${label}`);
}

let cleanup;
let rendererErrors = [];
// The earlier checks count the accounts without connected services; a later section adds them.
startFixture({ connections: [] }).then(async fixture => {
  cleanup = fixture.cleanup;
  rendererErrors = fixture.errors;
  const { view, client, ports, state, errors, selectDashboard, trayManager } = fixture;
  const web = view.window.webContents;
  const ui = code => web.executeJavaScript(code);
  // The frames and visibility changes that the main process sent, newest last.
  const sent = [];
  const send = web.send.bind(web);
  web.send = (channel, value) => {
    sent.push({ at: Date.now(), channel, ...(channel === 'workspace:changed' ? { route: value.route } : { value }) });
    if (sent.length > 40) sent.shift();
    return send(channel, value);
  };
  // A failed condition saves a capture and the window, page, and main-process
  // state to out/workspace-tests, so a CI failure shows what the page showed.
  diagnose = async label => {
    const name = `failure-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)}`;
    const bounded = (promise, fallback) => Promise.race([promise, delay(2000).then(() => fallback)]).catch(error => `failed: ${error.message}`);
    const page = await bounded(ui(`({
      location: location.href, page: document.documentElement.dataset.page,
      visibleSections: [...document.querySelectorAll('[data-page]')].filter(node => !node.hidden).map(node => node.dataset.page),
      openDialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.id),
      visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
      activeElement: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      error: document.getElementById('error').hidden ? null : document.getElementById('error-message').textContent
    })`), 'renderer did not answer within 2 s');
    const native = view.window && !view.window.isDestroyed()
      ? { visible: view.window.isVisible(), focused: view.window.isFocused(), minimized: view.window.isMinimized(), bounds: view.window.getBounds() }
      : 'destroyed';
    const report = { label, at: new Date().toISOString(), route: view.route, pendingPublish: Boolean(view.timer), native, page, sent: sent.slice(-20).map(entry => ({ ...entry, ago: Date.now() - entry.at })), rendererErrors: errors.slice(-20) };
    fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(report, null, 2));
    console.error(`Diagnostics: ${JSON.stringify(report)}`);
    const image = await bounded(web.capturePage(), null);
    if (image?.toPNG) fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
  };
  const click = async selector => {
    await until(() => ui(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), `${selector} accepts a click`);
    return ui(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const value = selector => ui(`document.querySelector(${JSON.stringify(selector)}).value`);
  const text = selector => ui(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const input = (selector, value, event = 'input') => ui(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  const nextFrames = () => ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  // Main-process changes reach the renderer in one debounced frame. Wait until
  // that frame is sent and the renderer has drawn it.
  const published = async () => {
    await until(() => view.timer === null, 'workspace frame published');
    await nextFrames();
  };
  const visible = selector => ui(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
  const verifyContrast = async () => {
    const ratios = await ui(`(() => {
      function luminance(color) {
        if (!/^rgb/.test(color)) throw new Error('Unresolved color: ' + color);
        const channels = color.match(/[\\d.]+/g).slice(0, 3).map(value => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }
      return [['body', 'body'], ['#page-description', 'body'], ['.project-tag', '.project-tag'], ['#save-connection', '#save-connection'], ['.chip.good', '.chip.good'], ['.chip.warning', '.chip.warning']].map(([foreground, background]) => {
        const a = luminance(getComputedStyle(document.querySelector(foreground)).color);
        const b = luminance(getComputedStyle(document.querySelector(background)).backgroundColor);
        return { selector: foreground, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    })()`);
    for (const entry of ratios) assert.ok(entry.ratio >= 4.5, `text contrast ${entry.selector}: ${entry.ratio.toFixed(2)}`);
  };
  const navigate = async route => {
    view.open(route);
    await until(() => visible(`section[data-page="${route}"]`), `${route} page visible`);
  };
  const assertActiveBadgeTone = async () => {
    const selected = await ui('document.documentElement.dataset.theme');
    const appearance = ['light', 'dark'].includes(selected) ? selected : nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    const hex = colorPair(readTokens(), 'info')[appearance];
    const expected = `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
    const colors = await ui(`[...document.querySelectorAll('.vm-agent-card[data-agent-tone="active"] .chip')].map(node => getComputedStyle(node).color)`);
    assert.ok(colors.length > 0, 'the sample workspace has active status badges');
    assert.ok(colors.every(color => color === expected), 'active badges use the same blue tone as native clients, independently of the decorative state edge');
  };
  const screenshot = async name => {
    console.log(`Capture: ${name}`);
    await until(() => ui('document.getElementById("toast").hidden'), 'transient feedback completed');
    await ui(`Promise.all(document.getAnimations().filter(animation => {
      const target = animation.effect?.target;
      if (!(target instanceof Element) || !target.checkVisibility({ contentVisibilityAuto: true }) || animation.effect.getTiming().iterations === Infinity || animation.playState === 'paused') return false;
      const bounds = target.getBoundingClientRect();
      return bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth;
    }).map(animation => animation.finished.catch(error => {
      // Hover/focus transitions can be superseded by the next state update.
      if (error.name !== 'AbortError') throw error;
    })))`);
    await nextFrames();
    fs.writeFileSync(path.join(output, `${name}.png`), (await web.capturePage()).toPNG());
  };
  await until(() => ui('document.querySelectorAll("#overview-resources .card").length === 3'), 'populated overview');
  assert.deepEqual(await ui('[...document.querySelectorAll(".sidebar > nav [data-page-link]")].map(node => node.dataset.pageLink)'), ['overview', 'agents', 'resources'], 'keyboard and reading order follow the same category order');
  const typography = await ui(`(() => {
    const fraction = [...document.querySelectorAll('#overview-resources .vm-metric-fraction')].find(node => node.textContent);
    const style = getComputedStyle(fraction), parent = getComputedStyle(fraction.parentElement);
    return { text: fraction.parentElement.textContent, scale: parseFloat(style.fontSize) / parseFloat(parent.fontSize), opacity: Number(style.opacity) };
  })()`);
  assert.equal(typography.text, '12.4');
  assert.ok(typography.scale > 0.8 && typography.scale < 0.9);
  assert.ok(typography.opacity >= 0.75 && typography.opacity < 1);
  assert.equal(await text('#summary-local-note'), '2 active on this device', 'the fixture uses the production local-activity projection');
  await until(() => view.window.isVisible(), 'workspace shown');
  // Calling the menu handler in code does not activate the App as a native click does.
  app.focus({ steal: true });
  view.window.focus();
  web.focus();
  await until(() => ui('document.hasFocus()'), 'workspace accepts keyboard input');
  await nextFrames();
  assert.equal(client.getStatus(), 'connected');
  assert.ok(!JSON.stringify(view.snapshot()).includes(TOKEN), 'snapshots omit read credentials');
  assert.ok(!JSON.stringify(view.snapshot()).includes(ports.config.vibemon_token), 'snapshots omit collector credentials');
  assert.equal(await value('#read-token'), '');
  assert.deepEqual(await ui('import("./dom.js").then(({ providerName, stateLabel }) => [providerName("constructor"), providerName("opencode"), stateLabel("constructor")])'), ['constructor', 'OpenCode', 'constructor']);
  assert.equal(await text('#summary-resources'), '4');
  assert.equal(await text('#summary-accounts'), '4');
  assert.equal(await text('#summary-local'), '2');
  // The silent build runner is on standby, which needs no attention.
  assert.equal(await text('#summary-attention'), '2');
  assert.deepEqual(await ui('[...document.querySelectorAll("#overview-accounts .card")].map(card => card._source.sourceId)'), ['kiro:lab', 'codex:personal', 'claude:studio'], 'equal project names use account IDs before the Overview limit');
  const localClock = client.now;
  try {
    for (const offset of [-86400000, 86400000]) {
      client.now = () => Date.now() + offset;
      await client.poll(true); await published();
      assert.equal(await text('#summary-attention'), '2', 'wall-clock skew does not change standby or attention');
      assert.equal(await ui('[...document.querySelectorAll("#overview-accounts time")].every(node => node.textContent === "Just now")'), true, 'report age uses server time');
      // The three-card Overview may omit the account whose reset we are checking.
      await navigate('agents');
      assert.equal(await ui('document.querySelectorAll("#agent-cards .card").length'), 4);
      const resets = await ui('[...[...document.querySelectorAll("#agent-cards .card")].find(card => card._source.sourceId === "codex:team").querySelectorAll(".metric-reset:not([hidden])")].map(node => node.textContent)');
      assert.ok(resets.includes('Resets in 2h5m'), 'reset countdowns use server time');
      await navigate('overview');
    }
  } finally { client.now = localClock; await client.poll(true); }
  const overviewBounds = await ui('({ bottom: document.querySelector("#overview-accounts .card").getBoundingClientRect().bottom, viewport: innerHeight })');
  assert.ok(overviewBounds.bottom < overviewBounds.viewport, `account metrics fit in the initial viewport: ${JSON.stringify(overviewBounds)}`);
  assert.equal(state.requests.some(url => url.includes('/trend?')), false, 'history is not prefetched');
  await assertActiveBadgeTone();
  await screenshot('overview-dark');
  await click('#overview-attention');
  assert.equal(await ui('document.getElementById("overview-attention").getAttribute("aria-pressed")'), 'true');
  assert.equal(await ui('[...document.querySelectorAll("#overview-resources .card, #overview-accounts .card")].some(card => card.classList.contains("compact-card"))'), false, 'attention view expands every reused card');
  assert.deepEqual(await ui('[...document.querySelectorAll("#overview-resources .card h3")].map(node => node.textContent)'), ['Cache service']);
  assert.deepEqual(await ui('[...document.querySelectorAll("#overview-accounts .card h3")].map(node => node.textContent)'), ['experiments']);
  await client.poll(true); await published();
  assert.equal(await ui('document.querySelectorAll("#overview-accounts .card").length'), 1, 'background refresh preserves the attention filter');
  await click('#overview-attention');
  assert.equal(await ui('document.querySelectorAll("#overview-accounts .card").length'), 3);


  await navigate('resources');
  await ui('window.focusTrace = []; for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => window.focusTrace.push({ type, id: event.target.id, page: document.documentElement.dataset.page }));');
  assert.equal(await ui('document.querySelectorAll("#resource-cards .card").length'), 4);
  assert.ok((await text('#resource-cards')).includes('Unified memory'));
  assert.ok((await text('#resource-cards')).includes('Standby'));
  assert.ok((await text('#resource-cards')).includes('—'), 'missing readings remain unavailable');
  const uneditedSources = state.sources;
  state.sources = () => uneditedSources().map(source => source.sourceId === 'gpu-workstation' ? {
    ...source, resourceType: 'DGX Spark', metricDefinitions: { memoryPercent: { label: 'Shared memory ratio', unit: 'ratio', display: 'number' } }, metricOrder: ['memoryPercent'], metrics: { memoryPercent: 0.123456 }
  } : source);
  await client.poll(true); await published();
  assert.ok((await text('#resource-cards')).includes('Shared memory ratio'), 'saved labels override preset labels');
  assert.ok((await text('#resource-cards')).includes('0.123456'), 'edited presets retain custom precision');
  state.sources = uneditedSources; await client.poll(true);
  const orderingSources = state.sources;
  // Overview also lists Production cluster; focus the card on this page.
  await ui('document.querySelector(\'#resource-cards [aria-label="View Production cluster details"]\').focus()');
  state.sources = () => orderingSources().map(source => source.sourceId === 'production' ? { ...source, health: 'error' } : source);
  await client.poll(true); await published();
  assert.equal(await ui('document.activeElement.getAttribute("aria-label")'), 'View Production cluster details', 'attention reordering preserves keyboard focus');
  state.sources = orderingSources; await client.poll(true);

  await ui('window.originalCard = [...document.querySelectorAll("#resource-cards .card")].find(card => card.textContent.includes("Cache service")); document.getElementById("resource-search").focus();');
  await input('#resource-search', 'Cache');
  await ui('document.getElementById("resource-search").setSelectionRange(1, 3)');
  assert.equal(await ui('document.activeElement.id'), 'resource-search', 'the search field has focus before polling');
  await client.poll(true); await published();
  if (await ui('document.activeElement.id') !== 'resource-search') console.log('Focus diagnostic:', await ui('({ page: document.documentElement.dataset.page, active: document.activeElement.tagName, visible: document.visibilityState, focused: document.hasFocus(), events: window.focusTrace })'));
  assert.deepEqual(await ui('({ same: window.originalCard === document.querySelector("#resource-cards .card"), focused: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd })'), { same: true, focused: 'resource-search', start: 1, end: 3 });
  await input('#resource-search', 'no matching resource');
  assert.equal(await text('#resource-cards h3'), 'No matching resources');
  await click('#resource-cards .empty button');
  assert.equal(await value('#resource-search'), '');
  assert.equal(await ui('document.querySelectorAll("#resource-cards .card").length'), 4);
  state.trendDelayMs = 1000;
  await click('[aria-label="View Cache service details"]');
  const loadingEditTop = await ui('document.getElementById("edit-resource").getBoundingClientRect().top');
  await until(() => ui('document.querySelectorAll("#chart circle").length > 0'), 'custom resource history');
  const loadedEditTop = await ui('document.getElementById("edit-resource").getBoundingClientRect().top');
  assert.ok(Math.abs(loadedEditTop - loadingEditTop) < 1, `loading history does not move the edit action: ${loadedEditTop - loadingEditTop}px`);
  state.trendDelayMs = 0;
  assert.ok((await text('#detail-message')).includes('Latency is above'));
  assert.equal(await ui('document.activeElement.getAttribute("aria-label")'), 'Close source details');
  await screenshot('resource-detail');
  await click('#remove-monitor');
  await until(() => ports.calls.some(call => call[0] === 'external' && call[1].includes('remove=source') && call[1].includes('id=cache') && call[1].includes('owner=fixture-owner')), 'resource removal opens the matching Web confirmation');
  await ui('document.querySelector(\'[data-close-dialog="detail-dialog"]\').click(); document.querySelector(\'[aria-label="View Cache service details"]\').click();');
  await until(() => ui('document.querySelectorAll("#chart circle").length > 0'), 'reopening details before the queued close event preserves the new history');
  assert.equal(await ui('document.querySelectorAll("#chart path.average, #chart path.maximum").length'), 2, 'history renders averages and maxima');
  await ui('window.chartMutations = 0; window.chartObserver = new MutationObserver(() => window.chartMutations++); window.chartObserver.observe(document.getElementById("chart"), { childList: true, subtree: true });');
  for (let index = 0; index < 3; index++) { view.notify('activity'); await published(); }
  assert.equal(await ui('window.chartMutations'), 0, 'local activity does not redraw unchanged cloud history');
  await ui('window.chartObserver.disconnect()');
  state.trendStatus = 503;
  await ui('document.dispatchEvent(new Event("visibilitychange"))');
  await until(() => visible('#trend-error'), 'history failure remains separate from retained chart data');
  await client.poll(true); await published();
  assert.equal(await visible('#trend-error'), true, 'latest-state polling cannot hide history failures');
  state.trendStatus = 200;
  await click('#retry-trend');
  await until(async () => !(await visible('#trend-error')), 'history retry clears only the recovered error');

  const originalSources = state.sources;
  state.sources = () => originalSources().map(source => source.sourceId === 'cache' ? { ...source, metrics: { ...source.metrics, latency: 12.3456 } } : source);
  await client.poll(true);
  await until(async () => (await text('#detail-readings')).includes('12.3456 ms'), 'custom detail keeps six significant digits');
  assert.ok((await text('#resource-cards')).includes('12.3456 ms'), 'full resource cards retain custom metric precision');
  state.sources = () => originalSources().map(source => source.sourceId === 'cache' ? { ...source, statusMessage: 'Recovered <script>window.injected=true</script>', metrics: { ...source.metrics, latency: 0 }, metricOrder: ['throughput', 'latency', 'connections'] } : source);
  await client.poll(true);
  await until(async () => (await text('#detail-readings')).includes('0 ms'), 'open detail reflects latest measurement');
  assert.equal(await ui('window.injected'), undefined, 'untrusted text is never interpreted as HTML');
  assert.equal(await text('#detail-readings .detail-reading span'), 'Throughput', 'custom metric ordering is preserved');
  await click('[data-close-dialog="detail-dialog"]');
  assert.equal(await ui('document.getElementById("detail-dialog").open'), false);
  await input('#resource-search', 'Cache');
  await screenshot('custom-resource');
  state.sources = originalSources;
  await client.poll(true);

  const originalTrend = state.trend;
  state.trend = item => ({ ...originalTrend(item), metricDefinitions: { latency: { label: 'Temperature', unit: '°C', display: 'gauge', min: -40, max: 20 } }, metricOrder: ['latency'], points: [{ timestamp: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(), average: { latency: -12 }, maximum: { latency: -12 }, samples: 1, expiresAt: Date.now() / 1000 + 86400 }] });
  await click('[aria-label="View Cache service details"]');
  await until(async () => (await text('#chart')).includes('-40') && (await text('#trend-metric')).includes('Temperature (°C)'), 'history uses its returned signed metric schema');
  await client.poll(true); await published();
  assert.ok((await text('#chart')).includes('-40') && (await text('#trend-metric')).includes('Temperature (°C)'), 'a latest-state poll cannot relabel historical values');
  assert.ok(Math.abs(await ui('Number(document.querySelector("#chart circle").getAttribute("cy"))') - 115.333333) < 0.000001);
  await click('[data-close-dialog="detail-dialog"]');
  state.trend = originalTrend;

  await navigate('agents');
  assert.equal(await ui('document.querySelectorAll("#agent-cards .card").length'), 4);
  await input('#agent-filter', 'codex');
  await ui('document.getElementById("agent-filter").focus()');
  state.sources = () => {
    const current = originalSources();
    const agent = current.find(source => source.kind === 'agent');
    return [...current, { ...agent, sourceId: 'new-openclaw',
      account: { provider: 'openclaw', id: 'new', displayName: 'New account' },
      agent: { ...agent.agent, character: 'claw' } }];
  };
  await client.poll(true); await published();
  assert.equal(await value('#agent-filter'), 'codex', 'new provider options preserve the focused filter');
  assert.equal(await ui('document.querySelectorAll("#agent-cards .card").length'), 2);
  assert.equal(await ui('document.activeElement.id'), 'agent-filter');
  await input('#agent-filter', 'openclaw');
  state.sources = originalSources;
  await client.poll(true); await published();
  assert.equal(await value('#agent-filter'), 'all', 'a removed provider returns to the valid default');
  assert.equal(await ui('document.querySelectorAll("#agent-cards .card").length'), 4);
  state.sources = () => originalSources().map(source => source.sourceId === 'codex-personal'
    ? { ...source, observedAt: new Date(Date.now() - 600000).toISOString() }
    : source);
  await client.poll(true); await published();
  assert.deepEqual(await ui('[...document.querySelectorAll("#agent-cards h3")].map(node => node.textContent)'), ['experiments', 'web-console', 'web-console', 'api-gateway'], 'inactive accounts follow all reporting accounts');
  await screenshot('agent-inactive-last');
  await navigate('overview');
  assert.deepEqual(await ui('[...document.querySelectorAll("#overview-accounts h3")].map(node => node.textContent)'), ['experiments', 'web-console', 'web-console'], 'overview applies activity ordering before its three-card limit');
  state.sources = originalSources;
  await client.poll(true); await published();
  await navigate('agents');
  assert.deepEqual(await ui('[...document.querySelectorAll("#agent-cards h3")].map(node => node.textContent)'), ['experiments', 'api-gateway', 'web-console', 'web-console'], 'resumed accounts regain their position while idle stays ahead of inactive');
  for (const [name, states] of [['agent-active-states', ['working', 'planning', 'thinking', 'packing']], ['agent-response-states', ['done', 'idle', 'alert', 'notification']]]) {
    state.sources = () => {
      let index = 0;
      return originalSources().map(source => source.kind === 'agent' ? { ...source, agent: { ...source.agent, state: states[index++] } } : source);
    };
    await client.poll(true);
    await until(() => ui(`JSON.stringify([...document.querySelectorAll('#agent-cards .card')].map(card => card.dataset.agentState).sort()) === ${JSON.stringify(JSON.stringify([...states].sort()))}`), name);
    await screenshot(name);
  }
  state.sources = () => {
    const data = originalSources();
    const team = data.find(source => source.sourceId === 'codex-team');
    return [...data, { ...team, sourceId: 'waiting-review', displayName: 'release-review', observedAt: new Date(Date.now() - 1000).toISOString(), agent: { ...team.agent, state: 'notification', project: 'release-review' } }];
  };
  await client.poll(true);
  await until(() => ui('[...document.querySelectorAll("#agent-cards .card")].find(card => card.querySelector("h3").textContent === "release-review")?.querySelector(".chip").textContent === "Needs input"'), 'account surfaces attention from an older reporting project');
  await ui('window.activityCard = document.querySelector(\'#agent-cards [aria-label="release-review · Codex · team"]\')');
  assert.equal(await ui('activityCard.dataset.agentTone'), 'warning');
  assert.equal(await ui('getComputedStyle(activityCard.querySelector(".vm-agent-edge"), "::before").animationName'), await ui('matchMedia("(prefers-reduced-motion: reduce)").matches') ? 'none' : 'vm-agent-wait');
  await click('#agent-cards [aria-label="View release-review · Codex · team details"]');
  assert.equal(await text('#detail-status .chip'), 'Needs input');
  assert.ok((await text('#detail-members')).includes('release-review'));
  assert.ok((await text('#detail-readings')).includes('38%'), 'account usage still comes from its latest observation');
  await click('[data-close-dialog="detail-dialog"]');
  state.sources = originalSources;
  await client.poll(true);
  await until(() => ui('[...document.querySelectorAll("#agent-cards .card")].find(card => card._source.sourceId === "codex:team")?.querySelector(".chip").textContent === "Working"'), 'account attention clears when the project no longer reports it');
  assert.equal(await ui('activityCard === document.querySelector(\'#agent-cards [aria-label="web-console · Codex · team"]\')'), true, 'project changes preserve the account card node');
  assert.equal(await ui('activityCard.dataset.agentTone'), 'active');
  await ui('activityCard.querySelector(".card-footer button").focus()');
  await until(() => ui('getComputedStyle(activityCard).boxShadow.includes("0px 0px 0px 3px")'), 'keyboard focus strengthens the active glow');
  await ui('activityCard.querySelector(".card-footer button").blur()');
  web.debugger.attach('1.3');
  await web.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  assert.equal(await ui('getComputedStyle(activityCard.querySelector(".vm-agent-edge"), "::before").animationName'), 'vm-agent-orbit');
  const cardSize = await ui('[activityCard.offsetWidth, activityCard.offsetHeight]');
  await web.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await ui('getComputedStyle(activityCard.querySelector(".vm-agent-edge"), "::before").animationName'), 'none');
  assert.equal(await ui('getComputedStyle(activityCard, "::before").animationName'), 'none');
  assert.deepEqual(await ui('[activityCard.offsetWidth, activityCard.offsetHeight]'), cardSize, 'motion does not change layout');
  web.debugger.detach();
  state.sources = () => originalSources().filter(source => source.kind === 'agent').map(source => ({
    ...source, observedAt: new Date(Date.now() - 600000).toISOString(), receivedAt: new Date(Date.now() - 600000).toISOString()
  }));
  await client.poll(true);
  await until(() => ui('[...document.querySelectorAll("#agent-cards .card-heading > .chip")].every(chip => chip.textContent === "Standby")'), 'stopped coding hooks are on neutral standby in every card');
  assert.equal(await ui('[...document.querySelectorAll("#agent-cards .card")].every(card => card.dataset.agentTone === "neutral" && getComputedStyle(card.querySelector(".vm-agent-edge"), "::before").animationName === "none")'), true);
  assert.equal(client.snapshot().attentionCount, 0);
  assert.equal(trayManager.notices.dashboard, null, 'inactive agents do not mark the Dashboard menu item');
  assert.equal(trayManager.notices.integrations, 'Codex CLI has an update', 'the fixture update stays assigned to Integrations');
  const integrationsItem = Menu.buildFromTemplate(trayManager.buildMenuTemplate()).items.find(item => item.label.startsWith('Integrations…'));
  assert.ok((process.platform === 'darwin' ? integrationsItem.sublabel : integrationsItem.label).includes('Codex CLI has an update'), 'the native menu item names the issue');
  await navigate('overview');
  assert.equal(await text('#summary-attention'), '0');
  await click('#overview-attention');
  assert.equal(await ui('document.querySelectorAll("#overview-accounts .card").length'), 0);
  await click('#overview-attention');
  state.sources = originalSources;
  await client.poll(true);
  await navigate('agents');
  await input('#agent-filter', 'codex');
  assert.deepEqual(await ui('[...document.querySelectorAll("#agent-cards h3")].map(node => node.textContent)'), ['api-gateway', 'web-console']);
  assert.ok((await text('#agent-cards')).includes('Codex · team'));
  assert.ok((await text('#agent-cards')).includes('Codex · personal'));
  assert.ok((await text('#agent-cards')).includes('Resets in 2h5m') && (await text('#agent-cards')).includes('Resets in 3d1h'), 'plan usage shows its reset countdown');
  for (const query of ['Engineering', 'team', 'web-console']) {
    await input('#agent-search', query);
    assert.deepEqual(await ui('[...document.querySelectorAll("#agent-cards .card")].map(card => card._source.sourceId)'), ['codex:team'], `${query} finds the same account after its title changes`);
  }
  await input('#agent-search', '');
  await input('#agent-filter', 'kiro');
  assert.ok((await text('#agent-cards')).includes('Needs input'));
  assert.ok((await text('#agent-cards')).includes('—'), 'unreported provider quota is not zero');
  assert.equal(await ui('document.querySelectorAll("#agent-cards .metric-reset:not([hidden])").length'), 0, 'an unreported reset time shows nothing');
  await input('#agent-filter', 'all');
  const beforeMetricSelection = client.snapshot();
  await client.select({ sources: beforeMetricSelection.selectedSources, accounts: beforeMetricSelection.selectedAccounts, metrics: [] });
  await published();
  const historyRequests = state.requests.filter(url => url.includes('/trend?')).length;
  await click('#agent-cards [aria-label="View web-console · Codex · team details"]');
  await delay(150);
  assert.equal(state.requests.filter(url => url.includes('/trend?')).length, historyRequests, 'hidden metrics do not cause unused history requests');
  assert.ok((await text('#trend-state')).includes('Choose a visible metric'));
  await click('[data-close-dialog="detail-dialog"]');
  await client.select({ sources: beforeMetricSelection.selectedSources, accounts: beforeMetricSelection.selectedAccounts, metrics: beforeMetricSelection.selectedMetrics });
  await published();
  await screenshot('coding-accounts');
  await verifyContrast();
  await click('[data-page="agents"] [data-selection]');
  await until(() => visible('#selection-dialog'), 'selection dialog');
  const chosenMetrics = await ui('document.querySelectorAll("#metric-choices input:checked").length');
  await ui(`new Promise(resolve => {
    document.getElementById('selection-dialog').addEventListener('close', resolve, { once: true });
    document.querySelector('[data-close-dialog="selection-dialog"]').click();
    document.querySelector('[data-page="agents"] [data-selection]').click();
  })`);
  assert.equal(await ui('document.querySelectorAll("#metric-choices input:checked").length'), chosenMetrics, 'a queued close cannot clear reopened selection choices');
  await click('#select-none');
  assert.equal(await ui('document.querySelectorAll("#source-choices input:checked, #account-choices input:checked").length'), 0);
  assert.equal(await ui('document.querySelectorAll("#metric-choices input:checked").length'), chosenMetrics, 'clearing sources preserves metric preferences');
  await click('#select-all');
  await click('#selection-dialog details summary');
  await click('#clear-metrics');
  assert.equal(await ui('document.querySelectorAll("#metric-choices input:checked").length'), 0);
  assert.equal(await ui('document.querySelectorAll("#source-choices input:checked, #account-choices input:checked").length'), 8, 'clearing metrics preserves source choices');
  await click('#all-metrics');
  await click('#selection-dialog details summary');
  await click('#select-none');
  state.sourceDelayMs = 1000;
  const discoveryRequests = state.requests.length;
  await click('#discover');
  await until(() => state.requests.length > discoveryRequests, 'delayed discovery started');
  await click('[data-close-dialog="selection-dialog"]');
  await click('[data-page="agents"] [data-selection]');
  await click('#source-choices input[value="production"]');
  state.sourceDelayMs = 0;
  await until(() => ui('!document.getElementById("discover").disabled'), 'previous discovery completed');
  assert.equal(await ui('document.querySelectorAll("#source-choices input:checked, #account-choices input:checked").length'), 7, 'previous discovery cannot overwrite a reopened selection draft');
  state.sourceDelayMs = 1000;
  const currentDiscoveryRequests = state.requests.length;
  await click('#discover');
  await until(() => state.requests.length > currentDiscoveryRequests, 'discovery with editable choices started');
  await click('#source-choices input[value="production"]');
  state.sourceDelayMs = 0;
  await until(() => ui('!document.getElementById("discover").disabled'), 'current discovery completed');
  assert.equal(await ui('document.querySelector(\'#source-choices input[value="production"]\').checked'), true, 'choices changed during discovery survive its response');
  await click('#select-none');
  await click('#source-choices input[value="production"]');
  state.sourceDelayMs = 1000;
  const selectionRequests = state.requests.length;
  await click('#save-selection');
  await until(() => state.requests.length > selectionRequests, 'delayed selection save started');
  await click('[data-close-dialog="selection-dialog"]');
  await click('[data-page="agents"] [data-selection]');
  await click('#select-none');
  await click('#source-choices input[value="production"]');
  await click('#source-choices input[value="cache"]');
  state.sourceDelayMs = 0;
  await until(() => ui('!document.getElementById("save-selection").disabled'), 'previous selection save completed');
  assert.equal(await ui('document.getElementById("selection-dialog").open'), true, 'previous save cannot close the reopened selector');
  assert.equal(await ui('document.querySelectorAll("#source-choices input:checked, #account-choices input:checked").length'), 2, 'previous save preserves the new unsaved choices');
  await click('#select-all');
  await click('#source-choices input[value="production"]');
  await client.poll(true); await published();
  assert.equal(await ui('document.querySelector("#source-choices input[value=production]").checked'), false, 'polling preserves selection drafts');
  state.status = 503;
  await click('#discover');
  await until(() => visible('#selection-dialog .dialog-error'), 'discovery failure is visible inside the modal');
  assert.equal(await ui('document.querySelector("#source-choices input[value=production]").checked'), false);
  state.status = 200;
  await click('#discover');
  await until(() => ui('!document.getElementById("discover").disabled'), 'discovery recovered');
  assert.equal(await ui('document.querySelector("#source-choices input[value=production]").checked'), false);
  await click('#save-selection');
  await until(() => ui('!document.getElementById("selection-dialog").open'), 'selection saved');
  assert.equal(client.snapshot().sources.some(source => source.sourceId === 'production'), false);

  await navigate('companion');
  const invokeSetting = fixture.settings.invoke.bind(fixture.settings);
  let releasePreference;
  const preferenceGate = new Promise(resolve => { releasePreference = resolve; });
  fixture.settings.invoke = async (action, ...args) => {
    if (action === 'set-render-mode') await preferenceGate;
    return invokeSetting(action, ...args);
  };
  await ui('document.getElementById("render-mode").focus()');
  await input('#render-mode', '2d', 'change');
  await until(() => ui('document.getElementById("render-mode").disabled'), 'preference save pending');
  view.notify('activity'); await published();
  assert.equal(await value('#render-mode'), '2d', 'an older frame preserves the pending preference choice');
  await screenshot('preference-save-pending');
  releasePreference();
  await until(() => ports.appearance.RenderMode === '2d', 'render mode saved');
  await until(() => ui('!document.getElementById("render-mode").disabled'), 'render control ready');
  fixture.settings.invoke = invokeSetting;
  assert.equal(await ui('document.activeElement.id'), 'render-mode', 'saving retains keyboard focus');
  assert.equal(await value('#render-mode'), '2d', 'the save response contains authoritative preferences');
  const setRenderMode = ports.windowManager.setRenderMode;
  ports.windowManager.setRenderMode = () => { throw new Error('Unable to save render style'); };
  await input('#render-mode', '3d', 'change');
  await until(() => visible('#error'), 'failed preference shown');
  await until(() => ui('!document.getElementById("render-mode").disabled'), 'failed control ready');
  assert.equal(await value('#render-mode'), '2d', 'failed saves restore the persisted value');
  assert.equal(await ui('document.activeElement.id'), 'render-mode');
  ports.windowManager.setRenderMode = setRenderMode;
  await click('#dismiss-error');
  await click('[aria-label="Use Kiro character"]');
  await until(() => ports.appearance.CharacterLock === 'kiro', 'character choice saved');
  await click('#speech-bubble-fields input');
  await until(() => !ports.appearance.SpeechBubbleFields.status, 'bubble preference saved');
  await input('#character-scale', '80', 'change');
  await until(() => ports.appearance.CharacterScale === 80, 'scale preference saved');
  await ui('window.originalStorageWrite = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new Error("Storage denied"); }; void 0;');
  await input('#theme', 'light', 'change');
  assert.equal(await ui('document.documentElement.dataset.theme'), 'light', 'appearance still works without persistence');
  assert.ok((await text('#theme-storage-status')).includes('this session'));
  await ui('Storage.prototype.setItem = window.originalStorageWrite; delete window.originalStorageWrite;');
  await input('#theme', 'light', 'change');
  assert.equal(await visible('#theme-storage-status'), false);

  await navigate('agents');
  await verifyContrast();
  await navigate('overview');
  await assertActiveBadgeTone();
  await screenshot('overview-light');
  await navigate('companion');
  assert.equal(await value('#render-mode'), '2d');
  assert.equal(await value('#character-lock'), 'kiro');
  assert.equal(await value('#character-scale'), '80');
  await screenshot('companion-settings');
  await navigate('integrations');
  assert.equal(await visible('#account-profiles-empty'), false);
  assert.equal(await ui('document.querySelectorAll("#account-profiles article").length'), 2);
  assert.ok((await text('#account-profiles')).includes('Detected account'));
  assert.ok((await text('#account-profiles')).includes('Unidentified profile'));
  assert.ok((await text('#account-profiles')).includes('Usage could not be refreshed'));
  await click('#account-profiles summary');
  assert.equal(await ui('document.querySelector("#account-profiles details").open'), true);
  await click('#accounts-guide');
  await until(() => ports.calls.some(call => call[0] === 'external' && call[1].includes('/docs/coding-agents#keep-several-accounts-apart')), 'account guide opened');
  await ui('document.getElementById("account-profiles-title").scrollIntoView({ block: "start" })');
  await screenshot('integration-accounts');
  assert.equal(await value('#cloud-write-token'), '');
  await input('#cloud-write-token', TOKEN);
  await click('#save-cloud-delivery');
  await until(() => visible('#cloud-delivery-error'), 'read-only token rejected for cloud delivery');
  assert.ok((await text('#cloud-delivery-error')).includes('write permission'));
  assert.equal(await visible('#error'), false, 'delivery errors appear once, inside their form');
  assert.equal(ports.config.vibemon_token, 'fixture-secret-must-not-cross-IPC', 'failed check preserves saved configuration');
  await input('#cloud-write-token', WRITE_TOKEN);
  await click('#save-cloud-delivery');
  await until(async () => (await text('#cloud-delivery-status')) === 'Write access verified', 'cloud write access verified');
  assert.equal(ports.config.vibemon_token, WRITE_TOKEN);
  assert.equal(await value('#cloud-write-token'), '');
  assert.ok(!JSON.stringify(view.snapshot()).includes(WRITE_TOKEN), 'write credential never returns over IPC');
  await screenshot('cloud-delivery');
  await click('#disconnect-cloud-delivery');
  await until(async () => (await text('#cloud-delivery-status')) === 'No saved write token', 'shared cloud credential removed');
  assert.equal(ports.config.vibemon_token, '');
  assert.equal(client.snapshot().tokenConfigured, true, 'stopping publication retains the independent read connection');
  assert.ok(ports.config.http_urls.includes('http://127.0.0.1:19280'));
  ports.config.vibemon_token = 'fixture-secret-must-not-cross-IPC';
  view.notify('settings');

  const installByFlag = ports.hookInstaller.installByFlag;
  let finishInstallation;
  const installation = new Promise(resolve => { finishInstallation = resolve; });
  ports.hookInstaller.installByFlag = async flag => {
    ports.hookInstaller.isRunning = true;
    ports.hookInstaller.onStateChanged();
    try {
      await installation;
      return await installByFlag(flag);
    } finally {
      ports.hookInstaller.isRunning = false;
      ports.hookInstaller.onStateChanged();
    }
  };
  await ui('[...document.querySelectorAll("#hook-list .integration-card")].find(card => card.textContent.includes("Codex CLI")).querySelector("button").click()');
  await until(() => visible('#integration-progress'), 'installation progress announced');
  assert.equal(await ui('document.getElementById("hooks-refresh").disabled'), true);
  assert.deepEqual(await ui('[...document.querySelectorAll("#hook-list .integration-card button")].map(button => ({ label: button.textContent, disabled: button.disabled }))'), [
    { label: 'Reinstall', disabled: true },
    { label: 'Repair installation', disabled: true },
    { label: 'Install integration', disabled: true },
    { label: 'Setup guide', disabled: false },
    { label: 'Setup guide', disabled: false },
    { label: 'Reinstall', disabled: true }
  ]);
  finishInstallation();
  await until(() => ports.calls.some(call => call[0] === 'install' && call[1] === '--codex'), 'integration repair');
  await until(async () => !(await text('#hook-list')).includes('Update available'), 'integration repair reflected');
  await until(async () => !(await visible('#integration-progress')), 'installation progress cleared');
  assert.equal(await ui('document.querySelectorAll("#hook-list button:disabled").length'), 0);
  ports.hookInstaller.installByFlag = installByFlag;
  await screenshot('integration-settings');
  await click('#local-routing summary');
  const getConfigStatus = ports.vibemonConfigManager.getStatus;
  ports.vibemonConfigManager.getStatus = () => ({ exists: true, hasDesktopUrl: false, error: 'Invalid field types in ~/.vibemon/config.json: http_urls.' });
  view.notify('settings');
  await until(() => visible('#routing-error'), 'invalid integration config explained');
  assert.ok((await text('#routing-error')).includes('http_urls'));
  for (const area of ['settings', 'integrations']) {
    assert.equal(await ui(`document.querySelector('[data-attention="${area}"]').getAttribute('aria-label')`), 'Local delivery settings need repair', `${area} names the integration issue`);
  }
  assert.equal(await ui('document.querySelector(\'[data-attention="about"]\').hidden'), true, 'quiet tabs stay unmarked');
  ports.vibemonConfigManager.getStatus = getConfigStatus;
  view.notify('settings');
  await input('#new-http-url', 'http://127.0.0.1:19999');
  await click('#add-http-form button');
  await until(() => ports.config.http_urls.includes('http://127.0.0.1:19999'), 'HTTP destination saved');
  assert.equal(ports.config.vibemon_token, 'fixture-secret-must-not-cross-IPC');

  ports.app.isPackaged = true;
  let update = { status: null, version: null };
  ports.updateChecker.getState = () => ({ ...update });
  ports.updateChecker.checkForUpdates = async () => { update = { status: 'current', version: null }; };
  ports.updateChecker.downloadUpdate = async () => { ports.calls.push(['download-update']); update = { status: 'downloaded', version: '3.1.0' }; };
  ports.updateChecker.installDownloaded = () => ports.calls.push(['install-update']);
  view.notify('settings');
  await navigate('about');
  await click('#check-updates');
  await until(async () => (await text('#update-status')).includes('latest available version'), 'confirmed update check');
  update = { status: 'available', version: '3.1.0' }; view.notify('settings');
  await until(() => visible('#update-action'), 'update action shown');
  assert.equal(await text('#update-action'), 'Download update');
  await click('#update-action');
  await until(async () => (await text('#update-action')) === 'Restart and install', 'downloaded update awaits restart');
  assert.equal(ports.calls.some(call => call[0] === 'install-update'), false);
  await click('#update-action');
  await until(() => ports.calls.some(call => call[0] === 'install-update'), 'explicit install action');
  // A request's reply can reach the page after a newer published frame, because
  // replies and published changes travel on separate IPC paths. Hold one reply
  // until another page is published: the late reply must not bring its page back.
  const request = view.request.bind(view);
  let release = null;
  view.request = async (command, args) => {
    const value = await request(command, args);
    if (command === 'settings' && args[0] === 'open-external') await new Promise(resolve => { release = resolve; });
    return value;
  };
  await click('#open-releases');
  await until(() => Boolean(release), 'a settings reply is held');
  view.request = request;
  await navigate('overview');
  release();
  await until(() => ui('!document.getElementById("open-releases").disabled'), 'the held reply arrived');
  await nextFrames();
  assert.equal(await visible('section[data-page="overview"]'), true, 'a late reply does not bring back the page it was sent from');

  // Connected services: the list, the account link, a connected-only card, and both sign-ins.
  const beforeServices = { sources: client.snapshot().selectedSources, accounts: client.snapshot().selectedAccounts, metrics: client.snapshot().selectedMetrics };
  // Without a connection, Overview invites one, as Web and iPhone do.
  await navigate('overview');
  await until(() => visible('#overview-services-onboarding'), 'Overview invites a first connection');
  assert.equal(await text('#overview-services-onboarding h2'), 'See your weekly allowance. No computer setup required.');
  assert.deepEqual(await ui('[...document.querySelectorAll("#overview-services-connect button")].map(node => node.textContent)'), ['Connect Claude', 'Connect Codex']);
  await click('#overview-services-connect button:last-child');
  await until(() => visible('#service-dialog'), 'Overview starts a connection');
  assert.equal(await text('#service-dialog-title'), 'Connect Codex');
  await click('[data-close-dialog="service-dialog"]');
  state.usage.connections = usageConnections();
  await client.select({ sources: null, accounts: null, metrics: Object.keys(client.snapshot().metrics) });
  await navigate('services');
  await until(() => ui('document.querySelectorAll("#service-list .service-row").length === 2'), 'connected services listed');
  const serviceRow = id => `[...document.querySelectorAll("#service-list .service-row")].find(row => row._connection.id === ${JSON.stringify(id)})`;
  const claudeRow = await ui(`${serviceRow(USAGE_IDS.claude)}.innerText`);
  for (const part of ['Claude', 'Max', 'design@example.com', 'Connected', 'Weekly usage', '84%', 'Updated 2m ago']) assert.ok(claudeRow.includes(part), `Claude row shows ${part}: ${claudeRow}`);
  assert.equal(claudeRow.includes('Session usage'), false, 'a connection row shows only its primary window');
  const codexRow = await ui(`${serviceRow(USAGE_IDS.codex)}.innerText`);
  for (const part of ['Codex', 'Plus', 'Temporarily limited', 'Codex limited usage reads', 'Weekly usage', '31%']) assert.ok(codexRow.includes(part), `Codex row shows ${part}: ${codexRow}`);
  assert.equal(await ui(`${serviceRow(USAGE_IDS.codex)}._parts.refresh.disabled`), true, 'Refresh waits for refreshableAt');
  assert.equal(await ui(`${serviceRow(USAGE_IDS.codex)}._parts.showAgent.hidden`), false, 'a connected-only account has an agent card too');
  assert.ok(!JSON.stringify(view.snapshot()).includes(TOKEN), 'snapshots omit read credentials with connected services');
  await screenshot('connected-services');
  const sourceRequests = state.requests.length;
  await ui(`${serviceRow(USAGE_IDS.claude)}._parts.refresh.click()`);
  await until(() => state.usage.requests.includes(`POST /api/v1/usage/connections/${USAGE_IDS.claude}`) && state.requests.slice(sourceRequests).some(url => url.startsWith('/api/v1/sources')), 'refresh reads again and reloads the sources');
  await ui(`${serviceRow(USAGE_IDS.claude)}._parts.showAgent.click()`);
  await until(() => visible('#detail-dialog'), 'Show agent card opens the account');
  assert.equal(await text('#detail-type'), 'Claude Code · studio');
  assert.equal(await visible('#detail-connection'), true);
  assert.equal(await text('#detail-connection-chip'), 'Usage from Claude Max');
  // The details header stays text; the Connected service section below it shows the connection.
  assert.equal(await ui('document.querySelector("#detail-type .connection-link")'), null, 'the details header has no link icon');
  assert.equal(await visible('#detail-history'), true, 'a reporting account keeps its history');
  await screenshot('service-account-details');
  await click('#detail-manage-services');
  await until(async () => await ui('!document.getElementById("detail-dialog").open') && visible('section[data-page="services"]'), 'Manage connected services closes details and opens the list');
  await navigate('agents');
  const agentCard = id => `[...document.querySelectorAll("#agent-cards .card")].find(card => card._source.sourceId === ${JSON.stringify(id)})`;
  await until(() => ui(`Boolean(${agentCard('codex:auto:solo')})`), 'connected-only account card');
  // A connected account shows a link icon right after the provider name; its tooltip names the service.
  const link = id => `${agentCard(id)}._parts.type._subtitle.link`;
  const linkState = id => ui(`(() => { const link = ${link(id)}; const box = link.getBoundingClientRect(); return { visible: link.checkVisibility(), title: link.title, label: link.getAttribute('aria-label'), tone: link.dataset.tone, before: link.previousElementSibling.textContent, after: link.nextElementSibling.textContent, target: box.width >= 24 && box.height >= 24, text: link.textContent }; })()`);
  assert.deepEqual(await linkState('claude:studio'), { visible: true, title: 'Usage from Claude Max', label: 'Usage from Claude Max · Manage connected services', tone: 'active', before: 'Claude Code', after: ' · studio', target: true, text: '' });
  assert.deepEqual(await linkState('codex:auto:solo'), { visible: true, title: 'Usage from Codex Plus · Temporarily limited', label: 'Usage from Codex Plus · Temporarily limited · Manage connected services', tone: 'warning', before: 'Codex', after: ' · auto:solo', target: true, text: '' });
  assert.equal(await ui(`${agentCard('claude:studio')}._parts.type.textContent`), 'Claude Code · studio', 'the subtitle text is unchanged');
  assert.equal(await ui(`${agentCard('claude:studio')}.querySelector('.connection-chip')`), null, 'the card has no usage chip');
  assert.equal(await ui(`${agentCard('codex:auto:solo')}._parts.message.hidden`), true, 'a connected-only card omits project activity guidance');
  assert.deepEqual(await ui(`[...${agentCard('codex:auto:solo')}.querySelectorAll(".metric-label")].map(node => node.textContent)`), ['Session usage', 'Weekly usage'], 'a connected-only card shows plan usage only');
  // The rule follows the metric key, not which values arrived: context never shows, a missing window shows as unavailable.
  const withServices = state.sources;
  state.sources = () => withServices().map(source => source.sourceId.startsWith('usage:') ? { ...source, metrics: { ...source.metrics, contextPercent: 50, usageSessionPercent: null } } : source);
  await client.poll(true); await published();
  assert.deepEqual(await ui(`[...${agentCard('codex:auto:solo')}.querySelectorAll(".metric-label")].map(node => node.textContent)`), ['Session usage', 'Weekly usage'], 'a connected-only card never shows context');
  state.sources = withServices;
  await client.poll(true); await published();
  assert.equal(await ui(`${agentCard('codex:auto:solo')}._parts.members.hidden`), true, 'a connected-only card has no project tags');
  assert.equal(await ui(`${link('claude:studio')}.hidden`), false);
  // A card and the service row of its connection show the same reading.
  for (const [account, connectionId] of [['claude:studio', USAGE_IDS.claude], ['codex:auto:solo', USAGE_IDS.codex]]) {
    const cardWeekly = await ui(`[...${agentCard(account)}.querySelectorAll(".metric")].find(node => node.querySelector(".metric-label").textContent === "Weekly usage").querySelector("strong").textContent`);
    const rowWeekly = await ui(`[...document.querySelectorAll("#agent-services .service-row")].find(row => row._connection.id === ${JSON.stringify(connectionId)}).querySelector(".service-metric strong").textContent`);
    assert.equal(cardWeekly, rowWeekly, `${account} card and service row agree`);
  }
  assert.equal(await ui(`${link('codex:team')}.hidden`), true, 'an account without a connection has no link icon');
  assert.equal(await ui('document.querySelectorAll("#agent-services .service-row").length'), 2, 'the Agents page lists the connections');
  await screenshot('service-agent-cards');
  await ui(`${agentCard('codex:auto:solo')}._parts.details.click()`);
  await until(() => visible('#detail-dialog'), 'connected-only details');
  assert.equal(await visible('#detail-history'), false, 'a connected-only account has no history');
  assert.equal(await ui('document.querySelectorAll("#detail-members .detail-member").length'), 0, 'the project list omits usage sources');
  assert.equal(await ui('document.querySelectorAll("#detail-readings .detail-reading").length'), 2);
  await screenshot('connected-only-details');
  await click('[data-close-dialog="detail-dialog"]');
  await ui(`${link('claude:studio')}.click()`);
  await until(() => visible('section[data-page="services"]'), 'the link icon opens Connected services');
  assert.equal(await ui('document.getElementById("detail-dialog").open'), false, 'the link icon does not open the card details');
  await navigate('overview');
  await until(() => visible('#overview-services'), 'a limited connection needs the person on Overview');
  assert.equal(await visible('#overview-services-onboarding'), false, 'Overview stops inviting once a service is connected');
  assert.ok((await text('#overview-services')).includes('Temporarily limited'));
  await click('#overview-services');
  await until(() => visible('section[data-page="services"]'), 'the Overview row opens Connected services');
  // Claude: open the service page, paste a code; a rejected code keeps the sign-in.
  await click('#service-list .service-connect button:first-child');
  await until(() => visible('#service-dialog'), 'connect dialog');
  assert.equal(await text('#service-dialog-title'), 'Connect Claude');
  assert.ok((await text('#service-disclosure')).startsWith("Anthropic's page names Claude Code"));
  await click('#service-start');
  await until(() => visible('[data-service-phase="code"]'), 'Claude code step');
  await click('#service-open-claude');
  await until(() => ports.calls.some(call => call[0] === 'external' && new URL(call[1]).hostname === 'claude.ai'), 'Claude sign-in opened');
  await input('#service-code', 'wrong-code');
  await click('#service-submit');
  await until(() => visible('#service-dialog-error'), 'rejected code explained');
  assert.equal(await text('#service-dialog-error'), 'This code does not match the sign-in. Copy the whole code from the service page again.');
  assert.equal(await visible('[data-service-phase="code"]'), true, 'a rejected code keeps the sign-in');
  await screenshot('connect-claude');
  await input('#service-code', CLAUDE_CODE);
  await click('#service-submit');
  await until(() => visible('[data-service-phase="connected"]'), 'Claude connected');
  assert.equal(await text('#service-connected'), 'Claude is connected.');
  await until(() => client.snapshot().accounts.some(account => account.accountId === 'claude:auto:new-claude'), 'a new connection reloads the sources');
  await click('#service-dialog-close');
  // Codex: copy the device code, open the device page, and poll until approval.
  await click('#service-list .service-connect button:last-child');
  await until(() => visible('#service-dialog'), 'connect Codex dialog');
  await click('#service-start');
  await until(() => visible('[data-service-phase="device"]'), 'Codex device step');
  assert.equal(await text('#service-user-code'), 'BCDF-GHJK');
  await screenshot('connect-codex');
  await click('#service-open-codex');
  await until(() => ports.calls.some(call => call[0] === 'clipboard' && call[1] === 'BCDF-GHJK') && ports.calls.some(call => call[0] === 'external' && new URL(call[1]).hostname === 'auth.openai.com'), 'device code copied and page opened');
  await until(() => visible('[data-service-phase="connected"]'), 'Codex connected after polling');
  assert.equal(await text('#service-connected'), 'Codex is connected.');
  await click('#service-dialog-close');
  // Closing an unfinished sign-in abandons it on the server.
  await click('#service-list .service-connect button:last-child');
  await click('#service-start');
  await until(() => visible('[data-service-phase="device"]'), 'second Codex sign-in');
  await click('[data-close-dialog="service-dialog"]');
  await until(() => state.usage.requests.some(request => request.startsWith('DELETE /api/v1/usage/authorizations/')), 'closed sign-in cancelled');
  await until(() => ui('document.querySelectorAll("#service-list .service-row").length === 4'), 'new connections listed');
  const newCodex = state.usage.connections.find(connection => connection.accountId === 'auto:new-codex').id;
  await ui(`${serviceRow(newCodex)}._parts.disconnect.click()`);
  await until(() => visible('#service-disconnect-dialog'), 'disconnect confirmation');
  assert.equal(await text('#service-disconnect-body'), 'VibeMon deletes the saved sign-in and the usage readings of Codex · new-codex@example.com.');
  await click('#service-disconnect-confirm');
  await until(() => ui('document.querySelectorAll("#service-list .service-row").length === 3'), 'disconnected connection removed');
  assert.ok(state.usage.requests.includes(`DELETE /api/v1/usage/connections/${newCodex}`));
  // A token from before the usage permission: sign in again; the dashboard keeps working.
  state.usage.scope = false;
  await click('#service-list .service-connect button:first-child');
  await click('#service-start');
  await until(() => visible('#service-vibemon-sign-in'), 'sign in again offered');
  assert.equal(await text('#service-dialog-error'), 'Sign in to VibeMon again on this desktop to connect services.');
  assert.equal(client.getStatus(), 'connected', 'a usage permission failure does not change the dashboard connection');
  await click('#service-dialog-close');
  // A disconnect with that token offers the VibeMon sign-in on the row as well.
  await ui(`${serviceRow(USAGE_IDS.codex)}._parts.disconnect.click()`);
  await click('#service-disconnect-confirm');
  await until(() => ui(`${serviceRow(USAGE_IDS.codex)}._parts.vibemonSignIn.checkVisibility()`), 'row offers sign in again');
  assert.equal(await ui(`${serviceRow(USAGE_IDS.codex)}._parts.failure.textContent`), 'Sign in to VibeMon again on this desktop to connect services.');
  state.usage.scope = true;
  // Minimizing or hiding the App keeps a sign-in: the person may be approving it in the browser.
  const cancellations = () => state.usage.requests.filter(request => request.startsWith('DELETE /api/v1/usage/authorizations/')).length;
  const cancelled = cancellations();
  await click('#service-list .service-connect button:last-child');
  await click('#service-start');
  await until(() => visible('[data-service-phase="device"]'), 'Codex sign-in before leaving the window');
  view.window.minimize();
  await until(() => view.window.isMinimized(), 'workspace minimized');
  await delay(500);
  view.window.restore();
  // macOS hides the App like Cmd+H; elsewhere a window hide stands in for it.
  if (process.platform === 'darwin') { app.hide(); await delay(500); app.show(); }
  else { view.window.hide(); await delay(500); }
  view.open('services');
  await until(() => view.window.isVisible() && !view.window.isMinimized(), 'workspace shown again');
  assert.equal(cancellations(), cancelled, 'minimizing or hiding does not cancel the sign-in');
  assert.equal(await visible('[data-service-phase="device"]'), true, 'the connect dialog still shows the sign-in');
  // Closing the window closes the connect dialog and cancels its unfinished sign-in.
  view.window.close();
  await until(() => cancellations() === cancelled + 1, 'closed window cancels the sign-in');
  view.open('services');
  await until(() => view.window.isVisible() && visible('section[data-page="services"]'), 'workspace shown again');
  assert.equal(await ui('document.getElementById("service-dialog").open'), false, 'the connect dialog stays closed');
  state.usage.connections = [];
  await client.select(beforeServices); await client.poll(true); await published();

  await navigate('connections');
  await until(async () => (await text('#account-identities')).includes('viewer@example.com'), 'signed-in account loaded');
  assert.equal(await ui('document.querySelectorAll("#account-identities .account-profile-row").length'), 1, 'shared email is shown once');
  assert.equal(await text('#sidebar-account'), 'viewer@example.com');
  assert.ok((await text('#account-identities')).includes('Google · Email'));
  state.accountStatus = 503;
  await click('#account-profile-retry');
  await until(async () => (await text('#account-profile-status')).includes('could not be loaded'), 'account failure is visible');
  state.accountStatus = 401;
  await click('#account-profile-retry');
  await until(async () => (await text('#sidebar-account')) === '', 'rejected credentials clear the account identity');
  state.accountStatus = 200;
  state.accountProfile = { identities: [{ provider: 'apple', label: 'other@example.com', primary: true }] };
  await client.configure({ url: client.savedUrl(), token: TOKEN });
  await until(async () => (await text('#sidebar-account')) === 'other@example.com', 'new connection replaces account identity');
  assert.equal((await text('#account-identities')).includes('viewer@example.com'), false, 'previous account identity is cleared');
  const originalSignIn = view.signIn;
  const requestedScopes = [];
  await view.settings.cloudDelivery.disconnect();
  view.signIn = {
    async signIn(_url, scope, adopt) {
      requestedScopes.push(scope);
      return adopt(scope === 'write' ? WRITE_TOKEN : TOKEN, new globalThis.AbortController().signal);
    },
    cancel() {}
  };
  try {
    await input('#web-url', 'https://vibemon.io');
    await click('#sign-in');
    await until(async () => view.settings.cloudDelivery.snapshot().status === 'verified' && ui('!document.getElementById("sign-in").disabled'), 'automatic activity setup completed');
    assert.deepEqual(requestedScopes, ['read usage', 'write']);
    assert.equal(ports.config.vibemon_token, WRITE_TOKEN, 'activity uses its separate write credential');
    assert.ok(!JSON.stringify(view.snapshot()).includes(WRITE_TOKEN), 'automatic setup never exposes its credential');
    await screenshot('automatic-activity-setup');
    requestedScopes.length = 0;
    await click('#sign-in');
    await until(() => ui('!document.getElementById("sign-in").disabled'), 'existing activity setup preserved');
    assert.deepEqual(requestedScopes, ['read usage']);
  } finally { view.signIn = originalSignIn; }
  let finishSignIn;
  view.signIn = {
    signIn: () => new Promise(resolve => { finishSignIn = resolve; }),
    cancel() {}
  };
  try {
    await input('#web-url', 'https://vibemon.io');
    await click('#sign-in');
    await until(() => Boolean(finishSignIn), 'sign-in request started');
    await input('#web-url', 'https://draft.example');
    finishSignIn(client.snapshot());
    await until(() => ui('!document.getElementById("sign-in").disabled'), 'sign-in request settled');
    view.notify('settings'); await published();
    assert.equal(await value('#web-url'), 'https://draft.example', 'a pending sign-in cannot discard a newer address edit');
  } finally { view.signIn = originalSignIn; }
  await input('#web-url', 'https://edited.example');
  await client.poll(true); await published();
  assert.equal(await value('#web-url'), 'https://edited.example', 'polling preserves unsaved connection edits');
  await input('#web-url', 'https://vibemon.io');
  await input('#read-token', 'vm_' + '0'.repeat(60));
  await click('#save-connection');
  await until(() => visible('#error'), 'rejected replacement explained');
  assert.equal(client.getStatus(), 'connected', 'a rejected replacement preserves the working connection');
  assert.ok((await text('#error')).includes('active read token'));
  assert.equal(await value('#read-token'), '');
  await input('#read-token', TOKEN); await click('#save-connection');
  await until(async () => client.getStatus() === 'connected' && ui('!document.getElementById("save-connection").disabled'), 'token recovery');
  fixture.corruptCredential(); await client.poll(true);
  await until(async () => (await text('#connection-chip')).includes('Replace saved token'), 'corrupt credential recovery');
  await input('#read-token', TOKEN); await click('#save-connection');
  await until(() => client.getStatus() === 'connected', 'credential replaced');
  await screenshot('connection-settings');
  const accountResponses = state.accountResponses;
  state.accountDelayMs = 500;
  await click('#account-profile-retry');
  await click('#disconnect');
  await until(() => client.getStatus() === 'not-configured', 'disconnect');
  await navigate('overview');
  await until(async () => (await text('#summary-resources')) === '0', 'previous connection data cleared');
  assert.equal(await ui('document.querySelectorAll("#resource-cards .card, #agent-cards .card").length'), 0);
  assert.ok((await text('#overview-activity')).includes('web-console'), 'local activity survives cloud disconnect');
  await until(() => state.accountResponses > accountResponses, 'old account response completed after disconnect');
  assert.equal(await text('#sidebar-account'), '', 'disconnect clears the account name and rejects late responses');
  assert.equal(await ui('document.getElementById("workspace-account").hidden'), true);
  await screenshot('disconnected');

  view.window.setSize(820, 600);
  for (const route of ['overview', 'resources', 'agents', 'connections', 'services', 'companion', 'integrations', 'about']) {
    await navigate(route);
    assert.equal(await ui('document.getElementById("main").scrollWidth <= document.getElementById("main").clientWidth'), true, `${route} fits the minimum window width`);
  }
  await screenshot('minimum-window');
  view.window.hide();
  await client.configure({ url: 'https://vibemon.io', token: TOKEN });
  assert.equal(view.window.isVisible(), false, 'background refresh leaves the workspace hidden');
  selectDashboard();
  await until(() => view.window.isVisible() && visible('section[data-page="overview"]'), 'Dashboard menu selection restores the overview');
  await until(async () => (await text('#summary-resources')) === '3', 'hidden window receives latest state with the saved selection');
  await nextFrames();
  const compactBounds = await ui('({ bottom: document.querySelector("#overview-accounts .card").getBoundingClientRect().bottom, viewport: innerHeight })');
  await screenshot('compact-overview');
  assert.ok(compactBounds.bottom < compactBounds.viewport, `both categories fit the minimum window: ${JSON.stringify(compactBounds)}`);
  // A wrapped label would make one card taller than the others and push the second category down.
  const wrappedLabels = await ui('[...document.querySelectorAll(".compact-card .metric-label")].filter(node => { const range = document.createRange(); range.selectNodeContents(node); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1; }).map(node => node.textContent)');
  assert.deepEqual(wrappedLabels, [], 'compact metric labels stay on one line');
  assert.equal(await ui('[...document.querySelectorAll(".compact-card .metric-label")].every(node => node.title === node.textContent)'), true, 'truncated labels keep their full text as a tooltip');
  const beforeGeneratedAccount = state.sources;
  const previousSelection = { sources: client.snapshot().selectedSources, accounts: client.snapshot().selectedAccounts, metrics: client.snapshot().selectedMetrics };
  const generatedId = `auto:27e702a8${'a'.repeat(56)}`;
  state.sources = () => beforeGeneratedAccount().map(source => source.sourceId === 'codex-team' ? { ...source, account: { ...source.account, id: generatedId } } : source);
  await client.poll(true);
  await client.select({ ...previousSelection, accounts: null });
  await published(); await navigate('agents');
  assert.ok((await text('#agent-cards')).includes('Codex · 27e702a8'));
  assert.ok(!(await text('#agent-cards')).includes(generatedId));
  await ui(`[...document.querySelectorAll('#agent-cards .card')].find(card => card._source.sourceId === ${JSON.stringify(`codex:${generatedId}`)}).querySelector('.card-footer button').click()`);
  await until(() => visible('#detail-dialog'), 'generated account detail');
  assert.equal(await text('#detail-type'), 'Codex · 27e702a8');
  await click('#remove-monitor');
  await until(() => ports.calls.some(call => call[0] === 'external' && new URL(call[1]).searchParams.get('id') === `codex:${generatedId}`), 'account removal keeps the full ID');
  await screenshot('account-short-label');
  await click('[data-close-dialog="detail-dialog"]');
  state.sources = beforeGeneratedAccount;
  await client.poll(true); await client.select(previousSelection); await published();
  // Exercise the API's accepted text/value limits at the minimum window size.
  const longName = '測'.repeat(128);
  state.sources = () => originalSources().map(source => {
    if (source.sourceId === 'cache') return {
      ...source, displayName: longName, resourceType: '基'.repeat(64), statusMessage: '確'.repeat(160),
      metrics: { ...source.metrics, latency: Number.MAX_SAFE_INTEGER },
      metricDefinitions: { ...source.metricDefinitions, latency: { label: '測'.repeat(80), unit: '測定単位'.repeat(4), display: 'number' } }
    };
    if (source.sourceId === 'codex-team') return {
      ...source, account: { provider: 'p'.repeat(32), id: 'a'.repeat(128), displayName: longName },
      agent: { ...source.agent, project: '計'.repeat(AGENT_TEXT_LIMITS.project), state: 'notification',
        tool: '道'.repeat(AGENT_TEXT_LIMITS.tool), model: '型'.repeat(AGENT_TEXT_LIMITS.model),
        usageWeekModelLabel: '型'.repeat(AGENT_TEXT_LIMITS.usageWeekModelLabel) }
    };
    return source;
  });
  await client.poll(true);
  assert.equal(client.getStatus(), 'connected', 'accepted-limit fixture must satisfy the source contract');
  await client.select({ sources: null, accounts: null, metrics: Object.keys(client.snapshot().metrics) });
  await input('#resource-search', '');
  const overflow = [];
  const checkFit = async (label, selector) => {
    await nextFrames();
    const invalid = await ui(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => ({ tag: node.tagName, id: node.id, className: node.className, width: node.clientWidth, content: node.scrollWidth }))`);
    if (invalid.length) overflow.push({ label, invalid });
  };
  for (const route of ['overview', 'resources', 'agents']) {
    await navigate(route);
    const cardTitle = route === 'agents' ? '計'.repeat(AGENT_TEXT_LIMITS.project) : longName;
    await until(async () => (await text(route === 'agents' ? '#agent-cards' : route === 'resources' ? '#resource-cards' : '#overview-resources')).includes(cardTitle), `${route} renders accepted long names`);
    await checkFit(route, '#main, .card, .card-heading, .metric, .metric-line, .card-title-group');
    if (route === 'overview') continue;
    const detailIdentity = route === 'agents' ? `${cardTitle} · ${'p'.repeat(32)} · ${'a'.repeat(15)}…${'a'.repeat(6)}` : cardTitle;
    await click(`section[data-page="${route}"] [aria-label="View ${detailIdentity} details"]`);
    await until(() => visible('#detail-dialog'), 'long source details');
    assert.equal(await text('#detail-type'), route === 'agents' ? `${'p'.repeat(32)} · ${'a'.repeat(15)}…${'a'.repeat(6)}` : '基'.repeat(64));
    await checkFit(`${route} detail`, '#detail-dialog, .dialog-heading, #detail-type, .detail-message, .detail-reading, .detail-member');
    await screenshot(`long-${route}-detail`);
    await click('[data-close-dialog="detail-dialog"]');
  }
  await click('[data-page="agents"] [data-selection]');
  await until(() => visible('#selection-dialog'), 'long source selection');
  await checkFit('selection', '#selection-dialog, .selection-columns fieldset, .selection-columns .choice');
  await screenshot('long-selection');
  await click('[data-close-dialog="selection-dialog"]');
  assert.deepEqual(overflow, [], 'accepted API values fit cards and dialogs without horizontal clipping');
  require('electron').autoUpdater.emit('before-quit-for-update');
  assert.equal(view.window, null, 'native update shutdown releases the real workspace before closing windows');
  assert.equal(view.disposed, true);
  view.open('overview');
  assert.equal(view.window, null, 'activation during update shutdown cannot reopen the workspace');
  assert.deepEqual(errors, [], 'no renderer or loading errors');
  console.log('PASS native workspace: navigation, custom metrics, multiple accounts, focus, selection, preferences, credential boundaries, recovery, resizing and visibility.');
  app.quit();
}).catch(error => { console.error(error?.stack || error); for (const message of rendererErrors) console.error(message); cleanup?.(); app.exit(1); });
