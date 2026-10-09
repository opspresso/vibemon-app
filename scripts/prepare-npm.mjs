// npm's launcher needs Electron at runtime; packaged desktop apps bundle it.
// Build a separate publication manifest so neither distribution carries the
// other one's dependency contract.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist', 'npm');
const original = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of ['README.md', 'LICENSE', 'bin', 'src', 'assets']) {
  await cp(path.join(root, file), path.join(destination, file), { recursive: true });
}
const { devDependencies, build: _build, scripts: _scripts, ...manifest } = original;
manifest.dependencies = { ...original.dependencies, electron: devDependencies.electron };
await writeFile(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared dist/npm for publication');
