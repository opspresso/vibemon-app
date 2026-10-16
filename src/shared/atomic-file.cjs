const fs = require('fs');
const path = require('path');

/**
 * Replaces `file` in one rename, so a reader sees the old or the new content,
 * never a partial write. Creates the parent folder when it is missing.
 *
 * `mode` and `directoryMode` also tighten a folder or a leftover temporary
 * file that already exists. Platforms without POSIX permissions (Windows)
 * may reject chmod; the write then continues with the platform defaults.
 * @param {string} file
 * @param {string} text
 * @param {{mode?: number, directoryMode?: number}} [options]
 */
function writeFileAtomic(file, text, { mode, directoryMode } = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: directoryMode });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode });
  try {
    if (directoryMode !== undefined) fs.chmodSync(directory, directoryMode);
    if (mode !== undefined) fs.chmodSync(temporary, mode);
  } catch {
    // See above: permissions are not supported on this platform.
  }
  fs.renameSync(temporary, file);
}

module.exports = { writeFileAtomic };
