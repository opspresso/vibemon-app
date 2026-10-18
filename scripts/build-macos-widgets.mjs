// Build the macOS widget extension, its reload module, and the preview tool
// from native/macos. Requires macOS and Xcode 16 or later.
//
// Products in build/macos-widgets/Release/:
//   VibeMonWidgets.appex      packaged as Contents/PlugIns/VibeMonWidgets.appex
//   widget-center.node        packaged as Contents/Resources/widget-center.node
//   vibemon-widget-preview    development tool; not packaged
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = fileURLToPath(new URL('../build/macos-widgets/', import.meta.url));
const WIDGET_PRODUCTS = `${output}Release/`;

export function buildMacosWidgets() {
  if (process.platform !== 'darwin') throw new Error('macOS widgets build only on macOS');
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const args = [
    '-project', 'native/macos/VibeMonWidgets.xcodeproj', '-alltargets', '-configuration', 'Release', '-quiet',
    // Xcode resolves relative roots from the project folder.
    `SYMROOT=${output}`, `OBJROOT=${output}obj`,
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${version}`, 'build'
  ];
  try {
    execFileSync('xcodebuild', args, { cwd: root, stdio: 'inherit' });
  } catch (error) {
    throw new Error('xcodebuild failed. Install Xcode 16 or later and select it with `sudo xcode-select -s /Applications/Xcode.app` (or set DEVELOPER_DIR).', { cause: error });
  }
  return WIDGET_PRODUCTS;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildMacosWidgets();
