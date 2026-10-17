const { TextDecoder } = require('node:util');
const { t } = require('./i18n/locale.cjs');

async function readJsonResponse(response, maximumBytes) {
  if (!response.body) throw new Error(t('error.emptyJson'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error(t('error.jsonTooLarge'));
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new Error(t('error.invalidJson')); }
  } finally {
    reader.releaseLock();
  }
}
module.exports = { readJsonResponse };
