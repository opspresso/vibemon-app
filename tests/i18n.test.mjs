import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslator, mergeCatalogs, resolveLocale } from '../src/shared/i18n/translate.mjs';
import messages from '../src/shared/i18n/shared-messages.mjs';
import { readFileSync } from 'node:fs';
import { validateCatalog, validateWidgetStrings } from '../scripts/generate-monitoring.mjs';
import { describeReset, formatResetTime, metricLabel, observationAge, resetCountdown, resetMinutes, resourceType, sharedTranslator, stateLabel } from '../src/shared/design/presentation.mjs';

test('resolves the first supported language and falls back to English', () => {
  assert.equal(resolveLocale(['ko-KR', 'en-US']), 'ko');
  assert.equal(resolveLocale(['fr-FR', 'ja_JP']), 'ja');
  assert.equal(resolveLocale(['fr', 'de']), 'en');
  assert.equal(resolveLocale('en-GB'), 'en');
  assert.equal(resolveLocale(undefined), 'en');
});

test('translates with placeholders, plurals, and English fallback', () => {
  const catalog = { en: { hello: 'Hello {name}', items: { one: '{count} item', other: '{count} items' }, only: 'English only' }, ko: { hello: '{name}님 안녕하세요', items: '{count}개' } };
  const en = createTranslator('en', catalog);
  const ko = createTranslator('ko-KR', catalog);
  assert.equal(en('hello', { name: 'Ann' }), 'Hello Ann');
  assert.equal(en('items', { count: 1 }), '1 item');
  assert.equal(en('items', { count: 2 }), '2 items');
  assert.equal(ko.locale, 'en', 'a tag that is not a supported locale uses English');
  const korean = createTranslator('ko', catalog);
  assert.equal(korean('hello', { name: '민수' }), '민수님 안녕하세요');
  assert.equal(korean('items', { count: 2 }), '2개');
  assert.equal(korean('only'), 'English only');
  assert.equal(korean('missing'), 'missing');
  assert.equal(korean.has('only'), true);
  assert.deepEqual(mergeCatalogs({ en: { a: '1' } }, { en: { b: '2' } }), { en: { a: '1', b: '2' } });
});

const desktop = JSON.parse(readFileSync(new URL('../src/shared/i18n/desktop.json', import.meta.url), 'utf8'));

test('Desktop messages pass the catalog check and do not redefine shared keys', () => {
  assert.doesNotThrow(() => validateCatalog('desktop.json', desktop));
  assert.deepEqual(Object.keys(desktop.en).filter(key => Object.hasOwn(messages.en, key)), [], 'Desktop keys do not redefine shared keys');
  assert.throws(() => validateCatalog('broken.json', { en: { a: 'Hi {name}' }, ko: { a: '안녕' } }), /placeholders/);
  assert.throws(() => validateCatalog('broken.json', { en: { a: 'A', b: 'B' }, ja: { a: 'A' } }), /missing b/);
});

test('shared display rules use the reader language', () => {
  const ko = sharedTranslator('ko');
  const ja = sharedTranslator('ja');
  assert.equal(stateLabel('notification'), 'Needs input');
  assert.equal(stateLabel('notification', ko), '입력 필요');
  assert.equal(stateLabel('custom-state', ja), 'custom-state');
  const now = Date.parse('2026-10-17T00:10:00Z');
  assert.equal(observationAge('2026-10-17T00:05:00Z', now, ja), '5分前');
  assert.equal(observationAge(null, now, ko), '보고 없음');
  assert.equal(formatResetTime(125), '2h5m');
  assert.equal(formatResetTime(125, ko), '2시간 5분');
  assert.equal(formatResetTime(1500, ja), '1日1時間');
  assert.equal(describeReset(resetMinutes(now + 125 * 60000, now), ko), '2시간 5분 후 초기화');
  assert.equal(describeReset(0, ja), 'まもなくリセット');
  assert.equal(describeReset(0, ko), '곧 초기화');
  assert.equal(describeReset(null, ko), null);
  assert.equal(resourceType({ kind: 'host' }, ko), '호스트');
  assert.equal(resourceType({ kind: 'host', resourceType: 'Freezer' }, ko), 'Freezer');
  assert.equal(metricLabel('memoryPercent', 'Memory', ja), 'メモリ');
  assert.equal(metricLabel('memoryPercent', 'Unified memory', ko), '통합 메모리');
  assert.equal(metricLabel('temperature', 'Temperature', ko), 'Temperature', 'custom labels stay as reported');
});

test('widget strings with shared English use the shared translations', () => {
  const catalog = { en: { 'reset.now': 'Resets now', 'reset.in': 'Resets in {time}' }, ko: { 'reset.now': '곧 초기화', 'reset.in': '{time} 후 초기화' }, ja: { 'reset.now': 'まもなくリセット', 'reset.in': '{time}後にリセット' } };
  const widget = (ko, ja) => ({ strings: { 'Resets in %@': { localizations: { ko: { stringUnit: { value: ko } }, ja: { stringUnit: { value: ja } } } } } });
  assert.doesNotThrow(() => validateWidgetStrings(catalog, widget('%@ 후 초기화', '%@後にリセット')));
  assert.throws(() => validateWidgetStrings(catalog, widget('%@ 뒤 초기화', '%@後にリセット')), /must equal shared.json reset.in/);
});
