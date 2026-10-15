// Renderer and engine files are ES modules that the browser loads directly.
// Jest runs CommonJS, so tests read the source, drop its import/export syntax,
// and evaluate it in a vm context that supplies the browser globals it needs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBrowserModule(relativePath, exportNames, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8')
    .replace(/^import[^;]*;/gm, '')
    .replace(/^export \{[^}]*\};?/gm, '')
    .replace(/^export /gm, '')
    + `\nmodule.exports = { ${exportNames.join(', ')} };`;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, ...globals });
  return module.exports;
}

module.exports = { loadBrowserModule };
