// Render the macOS widgets with synthetic workspace data, without the App.
//
// The script builds the native products, sends the shared synthetic fixture
// through MonitoringClient and buildWidgetFeed, and renders every item and
// notice in light and dark appearance and in the approximate vibrant mode.
//
// VIBEMON_LOCALE=ko or ja renders that language; the default is English.
//
// Output: out/widgets/feed.json and out/widgets/preview.png
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildMacosWidgets } from './build-macos-widgets.mjs';
import { buildWidgetFeed } from '../src/widgets/feed.mjs';

const require = createRequire(import.meta.url);
const { MonitoringClient } = require('../src/monitoring/client.cjs');
const { CHARACTER_CONFIG } = require('../src/shared/characters.cjs');
const { TOKEN, memoryStore, sources } = require('../tests/fixtures/workspace.cjs');

const out = fileURLToPath(new URL('../out/widgets/', import.meta.url));
const now = Date.now();
const locale = process.env.VIBEMON_LOCALE || 'en';

// Two accounts of the same provider exercise generated IDs in the picker.
const fixtureSources = sources(now).map(source => source.account?.provider === 'codex' ? {
  ...source, account: { ...source.account, id: `auto:${(source.account.id === 'personal' ? '27e702a8' : '396c8f1c').repeat(8)}` }
} : source);
const products = buildMacosWidgets();
// Rendering must use what the extension ships, not the source image folder.
const characters = `${products}VibeMonWidgets.appex/Contents/Resources/characters/`;
const client = new MonitoringClient({
  preferences: memoryStore(),
  credentials: { has: () => true, get: () => TOKEN, set() {}, clear() {} },
  fetchImpl: async () => new Response(JSON.stringify({ serverTime: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), sources: fixtureSources })),
  now: () => now
});
await client.configure({ url: 'https://vibemon.io', token: TOKEN });
const local = [{
  id: 'local:preview', since: now - 20000,
  status: { state: 'done', project: 'vibemon-app', character: 'clawd', memory: 18, usage5h: 23, usageWeek: 41, usage5hResetsIn: 42, usageWeekResetsIn: 8640, observedAt: new Date(now - 20000).toISOString(), account: { id: 'default', provider: 'claude', displayName: 'claude default' } }
}];
const feed = buildWidgetFeed({ cloud: client.snapshot(), local, now, locale, artwork: name => CHARACTER_CONFIG[name]?.image });

mkdirSync(out, { recursive: true });
writeFileSync(`${out}feed.json`, JSON.stringify(feed, null, 2));
execFileSync(`${products}vibemon-widget-preview`, [`${out}feed.json`, characters, `${out}preview.png`], { stdio: 'inherit', env: { ...process.env, VIBEMON_LOCALE: locale } });
