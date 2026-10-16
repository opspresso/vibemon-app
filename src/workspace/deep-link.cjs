/**
 * `vibemon://` links, opened by macOS widgets.
 *
 * `vibemon://dashboard/<page>` opens the workspace at Overview, Resources, or
 * Coding agents. Any app can open such a link, so a link only selects one of
 * these pages; every other link is rejected.
 */
const { URL } = require('node:url');

const PAGES = new Set(['overview', 'resources', 'agents']);

/** @returns {string|null} the workspace page, or null for an unsupported link */
function dashboardPage(link) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'vibemon:' || url.hostname !== 'dashboard') return null;
  const page = url.pathname.replace(/^\//, '');
  return PAGES.has(page) ? page : null;
}

module.exports = { dashboardPage };
