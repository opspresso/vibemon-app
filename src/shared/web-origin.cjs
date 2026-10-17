const { URL } = require('node:url');
const { t } = require('./i18n/locale.cjs');

function webOrigin(value, allowLocalHttp = false) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(t('error.webOrigin')); }
  const local = allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(t('error.webOrigin'));
  }
  return url.origin;
}
function sameWebOrigin(first, second, allowLocalHttp = false) {
  try { return webOrigin(first, allowLocalHttp) === webOrigin(second, allowLocalHttp); }
  catch { return false; } // An invalid saved address never authorizes credential reuse.
}
module.exports = { webOrigin, sameWebOrigin };
