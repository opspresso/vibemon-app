// Translation for the Desktop App, Web, and the generated iPhone strings.
//
// A catalog maps a locale to messages: { en: { key: message }, ko: {...}, ja: {...} }.
// A message is a string with {name} placeholders, or plural forms
// { one, other } chosen by the `count` parameter (Intl.PluralRules).
// English is complete; a missing key in another locale falls back to English.

export const LOCALES = Object.freeze(['en', 'ko', 'ja']);
export const DEFAULT_LOCALE = 'en';

/**
 * The first supported language in `preferred`, such as navigator.languages or
 * the OS languages. Regional variants match their language: ko-KR → ko.
 * Anything else is English.
 */
export function resolveLocale(preferred) {
  for (const tag of Array.isArray(preferred) ? preferred : [preferred]) {
    const language = typeof tag === 'string' ? tag.toLowerCase().split(/[-_]/)[0] : '';
    if (LOCALES.includes(language)) return language;
  }
  return DEFAULT_LOCALE;
}

/** Combines catalogs; later catalogs win for the same key. */
export function mergeCatalogs(...catalogs) {
  const merged = {};
  for (const catalog of catalogs) {
    for (const [locale, messages] of Object.entries(catalog)) merged[locale] = { ...merged[locale], ...messages };
  }
  return merged;
}

/**
 * A function t(key, params) for `locale`. `t.has(key)` tells whether any
 * catalog defines the key; an unknown key returns itself.
 */
export function createTranslator(locale, ...catalogs) {
  const merged = mergeCatalogs(...catalogs);
  const resolved = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const own = merged[resolved] ?? {};
  const fallback = merged[DEFAULT_LOCALE] ?? {};
  const plurals = new Intl.PluralRules(resolved);
  const t = (key, params = {}) => {
    let message = Object.hasOwn(own, key) ? own[key] : fallback[key];
    if (message === undefined) return key;
    if (typeof message === 'object') {
      const form = plurals.select(Number(params.count));
      message = message[form] ?? message.other;
    }
    return message.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
  };
  t.locale = resolved;
  t.has = key => Object.hasOwn(own, key) || Object.hasOwn(fallback, key);
  return t;
}
