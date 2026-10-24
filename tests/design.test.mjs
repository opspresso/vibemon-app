import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountName, metricTone, statePresentation, providerLabel, formatMeasurement, formatMeasurementParts, observationAge, formatAxisValue, formatResetTime, resetCountdown } from '../src/shared/design/presentation.mjs';
import { usageResetAt } from '../src/shared/monitoring/clock.cjs';
import { dominantState, needsAttention, sourceState, accountState } from '../src/shared/monitoring/state.cjs';
import { mergeMean } from '../src/shared/resource-schema.cjs';
import { monitoringContract } from '../scripts/generate-monitoring.mjs';
import { widgetPalette } from '../scripts/generate-widget-palette.mjs';
import tokens from '../src/shared/design/tokens.cjs';
import fixtures from '../src/shared/monitoring/cases.json' with { type: 'json' };
import states from '../src/shared/data/states.json' with { type: 'json' };
import { barColor, pickTextColor, hexToRgb } from '../src/shared/bubble/vibemon-bubble.js';

test('every shared speech-bubble state has readable text on its opaque background', () => {
  const luminance = hex => {
    const { r, g, b } = hexToRgb(hex);
    const values = [r, g, b].map(byte => byte / 255).map(s => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  assert.equal(pickTextColor('#00AA00'), '#000000');
  for (const { color } of Object.values(states.states)) {
    const a = luminance(color), b = luminance(pickTextColor(color));
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, color);
  }
});

test('renderer labels match the validated canonical policy without network access', () => monitoringContract());
test('the macOS widget palette matches the shared design tokens', () => widgetPalette());
test('measurement precision follows the shared device contract', () => {
  for (const { value, unit, expected } of fixtures.measurements) assert.equal(formatMeasurement(value, unit, false, '—', false), expected);
});
test('bubble bars change color at the inclusive usage tone thresholds', () => {
  assert.deepEqual([49.9, 50, 69.9, 70, 89.9, 90].map(barColor), ['#00AA00', '#FFCC00', '#FFCC00', '#FF8800', '#FF8800', '#FF4444']);
});
test('metric tones follow the shared device contract', () => {
  for (const { key, value, expected } of fixtures.metricTones) assert.equal(metricTone(key, value), expected, `${key} ${value}`);
});
test('agent state edge tokens stay the documented mixes of their base tokens', () => {
  const css = tokens.readTokens();
  const channels = hex => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
  const mix = (a, b, share) => '#' + channels(a).map((value, index) => Math.round(value * share + channels(b)[index] * (1 - share)).toString(16).padStart(2, '0')).join('');
  const expected = { thinking: ['accent', 'accent', 1], planning: ['info', 'good', 0.65], packing: ['accent', 'danger', 0.65] };
  for (const [state, [first, second, share]] of Object.entries(expected)) {
    for (const scheme of ['light', 'dark']) {
      assert.equal(tokens.colorPair(css, `state-${state}`)[scheme], mix(tokens.colorPair(css, first)[scheme], tokens.colorPair(css, second)[scheme], share), `${state} ${scheme}`);
    }
  }
});
test('usage reset countdowns follow the shared device contract', () => {
  const snapshot = Date.parse('2026-10-13T08:00:00Z');
  for (const { name, metric, agent, eventAgeMs, elapsedMs, expected } of fixtures.resetCountdowns) {
    const resetAt = usageResetAt(metric, agent, new Date(snapshot - eventAgeMs).toISOString(), snapshot);
    assert.equal(resetCountdown(resetAt, snapshot + elapsedMs), expected, name);
  }
});

test('reset times outside whole non-negative minutes have no text', () => {
  for (const value of [-1, 1.5, NaN, Infinity, null, undefined, '5']) assert.equal(formatResetTime(value), null);
  assert.equal(formatResetTime(10079), '6d23h');
  assert.equal(resetCountdown(null), null);
  assert.equal(resetCountdown(Date.parse('2026-10-13T08:00:00Z'), NaN), null);
});

test('weighted means remain inside the observed range without inventing maxima', () => {
  for (const value of [0.1, -0.1, 52.32263514632913]) {
    let average = value;
    for (let count = 1; count < 1000; count++) average = mergeMean(average, count, value);
    assert.equal(average, value);
  }
  assert.equal(mergeMean(10, 2, 40), 20);
  assert.equal(mergeMean(10, 2, 40, 4), 30);
});

test('account freshness follows reporting projects while preserving stopped project details', () => {
  const now = Date.now();
  const fresh = { kind: 'agent', health: 'ok', stale: false, observedAt: new Date(now).toISOString(), agent: { state: 'working' } };
  const old = { kind: 'agent', health: 'error', stale: false, observedAt: new Date(now - 600000).toISOString(), agent: { state: 'alert' } };
  const state = sources => accountState({ sources }, now);
  assert.equal(state([fresh, old]), 'working');
  assert.equal(state([old, fresh]), 'working');
  assert.equal(sourceState(old, now), 'standby');
  assert.equal(state([old, { ...fresh, observedAt: old.observedAt }]), 'standby');
  assert.equal(needsAttention(state([old])), false);
  assert.deepEqual(statePresentation('standby'), ['Standby', 'neutral']);
  assert.equal(state([fresh, { ...fresh, agent: { state: 'notification' } }, old]), 'notification');
  assert.equal(state([fresh, { ...fresh, health: 'error' }, old]), 'error');
});

test('an account surfaces attention from any reporting project', () => {
  assert.equal(dominantState(['working', 'notification'], 'working'), 'notification');
  assert.equal(dominantState(['warning', 'alert', 'standby'], 'working'), 'alert');
  assert.equal(dominantState(['ok', 'idle'], 'idle'), 'idle');
  assert.equal(needsAttention('notification'), true);
  assert.equal(needsAttention('thinking'), false);
  assert.deepEqual(statePresentation('notification'), ['Needs input', 'warning']);
});
test('unknown labels remain text, including object prototype names', () => {
  assert.deepEqual(statePresentation('constructor'), ['constructor', 'neutral']);
  assert.equal(providerLabel('constructor'), 'constructor');
  assert.equal(providerLabel('claude'), 'Claude Code');
});
test('formatting distinguishes zero, missing and small measured values', () => {
  assert.equal(formatMeasurement(0, '%'), '0%');
  assert.equal(formatMeasurement(null, '%'), '—');
  assert.equal(formatMeasurement(NaN, '%', false, 'Unavailable'), 'Unavailable');
  assert.equal(formatMeasurement(0.000001, 's', true), '0.000001 s');
  assert.equal(formatMeasurement(-12, '°C', true), '-12°C');
  assert.equal(formatMeasurement(12.345678, 'ms', true), '12.3457 ms');
});
test('percentages use at most two decimal places in cards and precise details', () => {
  for (const exact of [false, true]) {
    assert.equal(formatMeasurement(32.02693245, '%', exact), '32.03%');
    assert.equal(formatMeasurement(0.533333, '%', exact), '0.53%');
    assert.equal(formatMeasurement(99.999, '%', exact), '100%');
    assert.equal(formatMeasurement(32.02693245, '%', exact, '—', false), '32.03');
  }
});
test('observation ages preserve old data and reject invalid timestamps', () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  assert.equal(observationAge('2026-10-11T09:59:59Z', now), 'Just now');
  assert.equal(observationAge('2026-10-11T09:59:30Z', now), '30s ago');
  assert.equal(observationAge('2026-10-11T09:56:00Z', now), '4m ago');
  assert.equal(observationAge('2026-10-09T10:00:00Z', now), '2d ago');
  assert.equal(observationAge('invalid', now), 'Not reported');
});

test('axis labels stay concise without rounding tiny readings to zero', () => {
  assert.equal(formatAxisValue(1e9), '1.0e+9');
  assert.equal(formatAxisValue(1e-8), '1.0e-8');
  assert.equal(formatAxisValue(-12.345), '-12.3');
  assert.equal(formatAxisValue(0), '0');
});


test('account labels shorten generated identities without changing manual names', () => {
  for (const kind of ['auto', 'profile', 'credential']) {
    assert.equal(accountName(`codex:${kind}:27e702a8${'a'.repeat(56)}`), '27e702a8');
  }
  assert.equal(accountName('claude:work'), 'work');
  assert.equal(accountName('codex:default'), 'default');
  assert.equal(accountName('claude:auto:manual-name'), 'auto:manual-name');
  assert.equal(accountName(`codex:${'long'.repeat(20)}`).length, 22);
});

test('semantic number segments preserve precision, signs, and locale grouping', () => {
  for (const locale of ['en-US', 'ko-KR', 'ja-JP', 'de-DE', 'fr-FR', 'ar-EG', 'hi-IN']) {
    for (const [value, unit, exact] of [[1234.567, '%', false], [-1234.567, 'GiB', false], [0.0001234, 'ms', false], [99.999, '%', false], [0, '', false], [12.3456789, 'ms', true], [12.3456789, 'toString', true]]) {
      const { integer, fraction } = formatMeasurementParts(value, unit, exact, '—', locale);
      assert.equal(integer + fraction, formatMeasurement(value, unit, exact, '—', false, locale));
    }
  }
  assert.deepEqual(formatMeasurementParts(-1234.56, '%', false, '—', 'de-DE'), { integer: '-1.234', fraction: ',56' });
  assert.deepEqual(formatMeasurementParts(99.999, '%'), { integer: '100', fraction: '' });
  for (const value of [null, undefined, NaN, Infinity, '12']) {
    assert.deepEqual(formatMeasurementParts(value), { integer: '—', fraction: '' });
  }
});
