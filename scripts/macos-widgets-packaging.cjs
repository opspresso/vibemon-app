/**
 * electron-builder hooks that package the macOS widgets (package.json `build`).
 *
 * - beforePack: builds native/macos before the macOS app is assembled, so
 *   `mac.extraFiles` and `mac.extraResources` find the products.
 * - sign: signs the widget extension with its own sandbox entitlements, then
 *   signs the app as electron-builder does. electron-builder skips
 *   Contents/PlugIns, and the outer signature must seal the signed extension.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const EXTENSION = 'Contents/PlugIns/VibeMonWidgets.appex';
const ENTITLEMENTS = path.join(__dirname, '..', 'native', 'macos', 'Config', 'Widgets.entitlements');

let built = null;

async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // One xcodebuild produces universal products for every packaged arch.
  built ??= import('./build-macos-widgets.mjs').then(module => module.buildMacosWidgets());
  await built;
}

async function sign(options) {
  const args = ['--force', '--sign', options.identity, '--options', 'runtime', '--entitlements', ENTITLEMENTS];
  // Ad-hoc signatures ('-') cannot carry a secure timestamp.
  if (options.identity !== '-') args.push('--timestamp');
  if (options.keychain) args.push('--keychain', options.keychain);
  execFileSync('codesign', [...args, path.join(options.app, EXTENSION)], { stdio: 'inherit' });
  const { signAsync } = require('@electron/osx-sign');
  await signAsync(options);
}

module.exports = { beforePack, sign };
