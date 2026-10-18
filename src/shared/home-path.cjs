const os = require('os');
const path = require('path');

/** Expands a leading `~` like a shell and resolves the rest from the working directory. */
function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

module.exports = { expandHome };
