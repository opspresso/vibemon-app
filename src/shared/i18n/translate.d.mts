export type Locale = 'en' | 'ko' | 'ja';
export type Message = string | { one?: string; other: string };
export type Catalog = Partial<Record<Locale, Record<string, Message>>>;
export interface Translator {
  (key: string, params?: Record<string, string | number>): string;
  readonly locale: Locale;
  has(key: string): boolean;
}
export const LOCALES: readonly Locale[];
export const DEFAULT_LOCALE: Locale;
export function resolveLocale(preferred: string | readonly string[] | null | undefined): Locale;
export function mergeCatalogs(...catalogs: Catalog[]): Catalog;
export function createTranslator(locale: string, ...catalogs: Catalog[]): Translator;
