/** Pure installation diagnostics shared by native dialogs and workspace settings. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const MAX_DETAIL_LINES = 3;

function scriptErrorDetail({ stdout = '', stderr = '' }) {
  const lines = `${stdout}\n${stderr}`
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const failures = lines.filter(line => line.startsWith('✗'));
  return (failures.length > 0 ? failures : lines).slice(-MAX_DETAIL_LINES).join('\n');
}

function describeFailure(result, platform = process.platform) {
  switch (result.reason) {
    case 'python-not-found':
      return platform === 'win32'
        ? 'No working Python 3 found. Install it from python.org (tick "Add python.exe to PATH").\n'
          + 'If `python` opens the Microsoft Store, turn off the python.exe app execution alias.'
        : 'Python3 is not installed';
    case 'download-failed':
      return `Failed to download install script (HTTP ${result.statusCode})`;
    case 'download-too-large':
      return 'Install script response exceeded the size limit';
    case 'integrity-check-failed':
      return 'Install script integrity check failed';
    case 'integrity-reference-missing':
      return 'Installer checksum unavailable (manifest.json has no installer hash)';
    case 'invalid-manifest':
      return 'Published manifest.json is malformed';
    case 'network-error':
      return `Network error: ${result.error}`;
    case 'spawn-error':
      return `Execution error: ${result.error}`;
    case 'exit-code': {
      // install.py reports *why* it stopped (a failed integrity check, a file
      // it couldn't write) on stdout, so the bare exit code alone is useless.
      const detail = scriptErrorDetail(result);
      const summary = `Install script exited with code ${result.code}`;
      return detail ? `${summary}\n${detail}` : summary;
    }
    default:
      return 'Unknown error';
  }
}

module.exports = { describeFailure };
