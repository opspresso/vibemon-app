// Validate the actual packaged App, then render with its bundled artwork.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { CHARACTER_CONFIG } = require('../src/shared/characters.cjs');
const app = process.argv[2];
assert(app && process.platform === 'darwin', 'Usage: node scripts/verify-macos-widgets.mjs <VibeMon.app> (macOS)');
const plist = file => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
const contents = path.resolve(app, 'Contents');
const extension = path.join(contents, 'PlugIns/VibeMonWidgets.appex/Contents');
const resources = path.join(extension, 'Resources');
const characters = path.join(resources, 'characters');
const info = plist(path.join(contents, 'Info.plist'));
const widget = plist(path.join(extension, 'Info.plist'));
assert.equal(info.CFBundleIdentifier, 'com.opspresso.vibemon');
assert.equal(info.CFBundleDisplayName, 'VibeMon Mac');
assert.equal(widget.CFBundleIdentifier, 'com.opspresso.vibemon.widgets');
assert.equal(widget.CFBundleDisplayName, 'VibeMon Mac');
assert.equal(widget.CFBundleShortVersionString, info.CFBundleShortVersionString);
assert.equal(widget.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
execFileSync('codesign', ['--verify', '--strict', path.dirname(extension)], { stdio: 'pipe' });
const entitlementXML = execFileSync('codesign', ['-d', '--entitlements', ':-', path.dirname(extension)], { stdio: ['ignore', 'pipe', 'pipe'] });
const entitlements = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: entitlementXML, encoding: 'utf8' }));
assert.equal(entitlements['com.apple.security.app-sandbox'], true);
assert.deepEqual(entitlements['com.apple.security.temporary-exception.files.home-relative-path.read-only'], ['/.vibemon/widgets/']);
assert.notEqual(entitlements['com.apple.security.network.client'], true);
assert(info.CFBundleURLTypes.some(type => type.CFBundleURLSchemes.includes('vibemon')));
assert(existsSync(path.join(contents, 'Resources/widget-center.node')));
const metadata = JSON.parse(readFileSync(path.join(resources, 'Metadata.appintents/extract.actionsdata')));
for (const type of ['Agent', 'Resource']) {
  assert(metadata.actions[`${type}Selection`]);
  assert(metadata.entities[`${type}Entity`]);
  assert(metadata.queries[`${type}Query`]);
}
for (const { image } of Object.values(CHARACTER_CONFIG)) {
  assert.deepEqual(readFileSync(path.join(characters, image)), readFileSync(path.join(root, 'src/assets/characters', image)), `Packaged character differs: ${image}`);
}
for (const locale of ['en', 'ko', 'ja']) assert(existsSync(path.join(resources, `${locale}.lproj/Localizable.strings`)));
const icon = path.join(contents, 'Resources', info.CFBundleIconFile);
assert.deepEqual(readFileSync(icon), readFileSync(path.join(root, 'assets/icon.icns')));
const out = path.join(root, 'out/widgets');
mkdirSync(out, { recursive: true });
const shared = path.join(root, 'native/macos/Shared');
const verifier = path.join(out, 'verify-native');
execFileSync('xcrun', ['swiftc', '-swift-version', '6', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
  ...readdirSync(shared).filter(file => file.endsWith('.swift')).map(file => path.join(shared, file)),
  path.join(root, 'native/macos/Widgets/Selection.swift'), path.join(root, 'native/macos/Tests/main.swift'), '-o', verifier], { stdio: 'inherit' });
execFileSync(verifier, [path.join(out, 'feed.json'), characters, icon], { stdio: 'inherit' });
execFileSync(path.join(root, 'build/macos-widgets/Release/vibemon-widget-preview'),
  [path.join(out, 'feed.json'), characters, path.join(out, 'packaged.png')], { stdio: 'inherit' });
console.log(`PASS: packaged widget metadata, all registered artwork, localization and App icon (${info.CFBundleShortVersionString})`);
