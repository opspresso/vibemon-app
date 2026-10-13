import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statePresentation, providerLabel, formatMeasurement, observationAge, formatAxisValue } from '../src/shared/design/presentation.mjs';
import { dominantState, needsAttention, sourceState, accountState } from '../src/shared/monitoring/state.cjs';
import { mergeMean } from '../src/shared/resource-schema.cjs';
import { monitoringContract } from '../scripts/generate-monitoring.mjs';
import fixtures from '../src/shared/monitoring/cases.json' with { type: 'json' };
import states from '../src/shared/data/states.json' with { type: 'json' };
import { pickTextColor, hexToRgb } from '../src/bubble/vibemon-bubble.js';

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
test('measurement precision follows the shared device contract', () => {
  for (const { value, unit, expected } of fixtures.measurements) assert.equal(formatMeasurement(value, unit, false, '—', false), expected);
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

test('account freshness follows reporting projects while preserving stale project details', () => {
  const fresh = { kind: 'agent', health: 'ok', stale: false, agent: { state: 'working' } };
  const old = { kind: 'agent', health: 'error', stale: true, agent: { state: 'alert' } };
  const state = sources => accountState({ sources });
  assert.equal(state([fresh, old]), 'working');
  assert.equal(state([old, fresh]), 'working');
  assert.equal(sourceState(old), 'inactive');
  assert.equal(state([old, { ...fresh, stale: true }]), 'inactive');
  assert.equal(needsAttention(state([old])), false);
  assert.deepEqual(statePresentation('inactive'), ['Inactive', 'neutral']);
  assert.equal(state([fresh, { ...fresh, agent: { state: 'notification' } }, old]), 'notification');
  assert.equal(state([fresh, { ...fresh, health: 'error' }, old]), 'error');
});

test('an account surfaces attention from any reporting project', () => {
  assert.equal(dominantState(['working', 'notification'], 'working'), 'notification');
  assert.equal(dominantState(['warning', 'alert', 'stale'], 'working'), 'alert');
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
