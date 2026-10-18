/** Light and dark color pairs from tokens.css, the canonical palette, for code that cannot read CSS. */
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, 'tokens.css');

/**
 * @param {string} css - tokens.css text
 * @param {string} token - the name after `--vm-`, for example 'background'
 * @returns {{light: string, dark: string}} lowercase `#rrggbb` colors
 */
function colorPair(css, token) {
  const match = css.match(new RegExp(`--vm-${token}:\\s*light-dark\\(#([0-9a-f]{6}),\\s*#([0-9a-f]{6})\\);`, 'i'));
  if (!match) throw new Error(`Token --vm-${token} needs a light-dark() pair of 6-digit colors`);
  return { light: `#${match[1].toLowerCase()}`, dark: `#${match[2].toLowerCase()}` };
}

const readTokens = () => fs.readFileSync(TOKENS_PATH, 'utf8');

module.exports = { colorPair, readTokens };
