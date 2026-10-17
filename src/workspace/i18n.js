// The workspace language. The main process resolves it from the OS (see
// shared/i18n/locale.cjs) and the preload passes the locale and its messages,
// because this sandboxed page cannot read the catalog files.
import { createTranslator } from '../shared/i18n/translate.mjs';

const language = window.workspace?.language;
// Without the catalog the page would show message keys; fail visibly instead.
if (!language) throw new Error('The workspace preload did not pass the App language');
/** t(key, params) in the App language, with English for missing messages. */
export const t = createTranslator(language.locale, language.messages);
/** The BCP 47 tag for Intl and toLocale* calls. */
export const locale = t.locale;

const TEXT_NODE = 3;
// Replaces the element's first text, so icons and nested elements stay.
function setText(node, value) {
  const textNode = [...node.childNodes].find(child => child.nodeType === TEXT_NODE && child.textContent.trim());
  if (!textNode) {
    node.prepend(document.createTextNode(value));
    return;
  }
  const [, before, , after] = textNode.textContent.match(/^(\s*)([\s\S]*?)(\s*)$/);
  textNode.textContent = `${before}${value}${after}`;
}

/**
 * Translates the static page once: data-i18n="key" sets the element's text,
 * and data-i18n-attr="aria-label:key;placeholder:key" sets attributes. The
 * English text in the HTML stays as the fallback.
 */
export function localizeDocument(root = document) {
  document.documentElement.lang = locale;
  for (const node of root.querySelectorAll('[data-i18n]')) setText(node, t(node.dataset.i18n));
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const entry of node.dataset.i18nAttr.split(';')) {
      const [name, key] = entry.split(':').map(part => part.trim());
      if (name && key) node.setAttribute(name, t(key));
    }
  }
}
