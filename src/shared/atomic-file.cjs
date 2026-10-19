const fs = require('fs');
const path = require('path');

/**
 * Replaces `file` in one rename, so a reader sees the old or the new content,
 * never a partial write. Creates the parent folder when it is missing.
 *
 * On POSIX systems, `directoryMode` is enforced before writing and a new
 * file starts with `mode`. Windows uses the account's filesystem ACLs.
 * Each write owns a private temporary directory; leftover files and links
 * from earlier writes cannot redirect or receive the new content.
 * @param {string} file
 * @param {string} text
 * @param {{mode?: number, directoryMode?: number}} [options]
 */
function writeFileAtomic(file, text, { mode, directoryMode } = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: directoryMode });
  if (directoryMode !== undefined && process.platform !== 'win32') fs.chmodSync(directory, directoryMode);
  const temporaryDirectory = fs.mkdtempSync(path.join(directory, `.${path.basename(file)}-`));
  const temporary = path.join(temporaryDirectory, 'data');
  try {
    fs.writeFileSync(temporary, text, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = { writeFileAtomic };
