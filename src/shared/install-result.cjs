/** Pure installation diagnostics shared by native dialogs and workspace settings, in the App language. */
const { t } = require('./i18n/locale.cjs');
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
      return t(platform === 'win32' ? 'install.pythonMissingWindows' : 'install.pythonMissing');
    case 'download-failed':
      return t('install.downloadFailed', { status: result.statusCode });
    case 'download-too-large':
      return t('install.tooLarge');
    case 'integrity-check-failed':
      return t('install.integrity');
    case 'integrity-reference-missing':
      return t('install.checksumMissing');
    case 'invalid-manifest':
      return t('install.invalidManifest');
    case 'network-error':
      return t('install.network', { error: result.error });
    case 'spawn-error':
      return t('install.spawn', { error: result.error });
    case 'input-error':
      return t('install.input');
    case 'exit-code': {
      // install.py reports *why* it stopped (a failed integrity check, a file
      // it couldn't write) on stdout, so the bare exit code alone is useless.
      const detail = scriptErrorDetail(result);
      const summary = t('install.exitCode', { code: result.code });
      return detail ? `${summary}\n${detail}` : summary;
    }
    default:
      return t('install.unknown');
  }
}

module.exports = { describeFailure };
