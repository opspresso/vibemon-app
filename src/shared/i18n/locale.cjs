/**
 * The Desktop App language.
 *
 * The main process resolves the language once from the OS languages after the
 * app is ready (see initLocale). Until then, and in tests, it is English.
 * Main-process text uses t(); the workspace renderer receives
 * rendererLanguage() through its preload, because a sandboxed renderer cannot
 * read the catalog files.
 */
const { createTranslator, mergeCatalogs, resolveLocale, DEFAULT_LOCALE } = require('./translate.mjs');
const shared = require('./shared.json');
const desktop = require('./desktop.json');

const catalog = mergeCatalogs(shared, desktop);
let translate = createTranslator(DEFAULT_LOCALE, catalog);

/** The OS languages in preference order; app.getLocale() when the OS reports none. */
function systemLanguages(app) {
  const preferred = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
  return Array.isArray(preferred) && preferred.length ? preferred : [app.getLocale()];
}

/** Uses `locale` ('en', 'ko', or 'ja'; anything else is English) for all later text. */
function setLocale(locale) {
  translate = createTranslator(resolveLocale(locale), catalog);
  return translate.locale;
}

/** Resolves the language from the OS. Call once, after app 'ready'. */
const initLocale = app => setLocale(resolveLocale(systemLanguages(app)));

const t = (key, params) => translate(key, params);
const currentLocale = () => translate.locale;

/** The locale and its messages with the English fallback, for a renderer translator. */
function rendererLanguage() {
  const locale = currentLocale();
  return { locale, messages: locale === DEFAULT_LOCALE ? { en: catalog.en } : { en: catalog.en, [locale]: catalog[locale] } };
}

module.exports = { t, initLocale, setLocale, currentLocale, rendererLanguage, systemLanguages };
