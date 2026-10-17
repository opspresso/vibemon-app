// Main-process modules require the shared ES modules (for example
// src/shared/i18n/translate.mjs) the way Electron's Node does. Jest loads only
// CommonJS, so this transform rewrites the static import and export
// statements of an .mjs file into require() and module.exports.
const SOURCE = String.raw`(['"][^'"]+['"])`;
const bindings = names => names.split(',').map(name => name.trim()).filter(Boolean)
  .map(name => name.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2')).join(', ');

function process(source) {
  const exported = [];
  const code = source
    .replace(new RegExp(String.raw`^import\s+(\w+)\s*,\s*\{([^}]*)\}\s+from\s+${SOURCE};?`, 'gm'),
      (_, name, names, from) => `const ${name} = __default(require(${from})); const { ${bindings(names)} } = require(${from});`)
    .replace(new RegExp(String.raw`^import\s+\{([^}]*)\}\s+from\s+${SOURCE};?`, 'gm'),
      (_, names, from) => `const { ${bindings(names)} } = require(${from});`)
    .replace(new RegExp(String.raw`^import\s+(\w+)\s+from\s+${SOURCE};?`, 'gm'),
      (_, name, from) => `const ${name} = __default(require(${from}));`)
    .replace(/^export\s+default\s+/gm, 'exports.default = ')
    .replace(/^export\s+((?:async\s+)?function\*?|const|let|class)\s+(\w+)/gm, (_, kind, name) => {
      exported.push(name);
      return `${kind} ${name}`;
    });
  if (/^\s*(import|export)\b/m.test(code)) throw new Error('esm-transform supports only static import and export declarations');
  return {
    code: 'Object.defineProperty(exports, "__esModule", { value: true });\n'
      + 'const __default = module => (module && module.__esModule ? module.default : module);\n'
      + code
      + `\nObject.assign(exports, { ${exported.join(', ')} });\n`
  };
}

// Jest caches transformed files by their source and config only, so the key
// also covers this transform: a changed rewrite then applies without --clearCache.
const ownSource = require('node:fs').readFileSync(__filename, 'utf8');
function getCacheKey(source, filename, { configString }) {
  return require('node:crypto').createHash('sha256').update(ownSource).update('\0').update(source).update('\0').update(filename).update('\0').update(configString).digest('hex');
}

module.exports = { process, getCacheKey };
