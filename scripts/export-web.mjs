// Publish only the reviewed paths in web-distribution.json. No Web checkout,
// credentials, installed dependencies, or private application code is needed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitoringContract } from './generate-monitoring.mjs';

await monitoringContract();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { files } = JSON.parse(await readFile(path.join(root, 'web-distribution.json'), 'utf8'));
const relative = value => typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.' || !part);
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
const contents = new Map();
for (const [target, source] of Object.entries(files)) {
  if (!relative(source) || !relative(target) || !/^(public\/(install|static)\/|docs\/)/.test(target)) throw new Error(`Invalid distribution path: ${target}`);
  if (!tracked.has(source)) throw new Error(`Distribution source is not tracked: ${source}`);
  const filename = path.join(root, source);
  if (await realpath(filename) !== filename) throw new Error(`Distribution source must not be a symlink: ${source}`);
  contents.set(target, await readFile(filename));
}
for (const file of tracked) {
  if (file.startsWith('public/install/') && files[file] !== file) throw new Error(`Installer file is missing from distribution: ${file}`);
}
const registry = JSON.parse(contents.get('public/static/data/characters.json').toString());
for (const character of Object.values(registry.characters)) {
  if (files[`public/static/characters/${character.image}`] !== `src/assets/characters/${character.image}`) throw new Error(`Character is missing from distribution: ${character.image}`);
}
if (process.argv.includes('--write')) {
  const destination = path.join(root, 'dist', 'web');
  await rm(destination, { recursive: true, force: true });
  const manifest = {};
  for (const [target, bytes] of contents) {
    if (!target.startsWith('public/')) continue;
    const relativePath = target.slice('public/'.length);
    const file = path.join(destination, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    manifest[relativePath] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(path.join(destination, 'distribution-manifest.json'), JSON.stringify({ files: manifest }, null, 2) + '\n');
  console.log(`Exported ${Object.keys(manifest).length} public files to dist/web`);
} else {
  console.log(`Verified ${contents.size} public distribution sources without private repository access`);
}
