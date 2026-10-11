import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dominantState, needsAttention, statePresentation, providerLabel, formatMeasurement, observationAge } from '../src/shared/design/presentation.mjs';

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
test('observation ages preserve old data and reject invalid timestamps', () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  assert.equal(observationAge('2026-10-11T09:59:59Z', now), 'Just now');
  assert.equal(observationAge('2026-10-11T09:59:30Z', now), '30s ago');
  assert.equal(observationAge('2026-10-11T09:56:00Z', now), '4m ago');
  assert.equal(observationAge('2026-10-09T10:00:00Z', now), '2d ago');
  assert.equal(observationAge('invalid', now), 'Not reported');
});
