import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCards } from '../src/shared/design/card-order.mjs';

const at = minutes => new Date(Date.UTC(2026, 9, 17, 12, minutes)).toISOString();
const account = (displayName, displayState, minutes, needsAttention = false) => ({ isAccount: true, displayName, displayState, observedAt: at(minutes), needsAttention });
const names = cards => [...cards].sort(compareCards).map(card => card.displayName);

test('standby cards go last, the most recently active first', () => {
  assert.deepEqual(names([
    account('a-old', 'standby', 1), account('b-working', 'working', 50), account('c-new', 'standby', 40),
    account('d-input', 'notification', 30, true), account('e-middle', 'standby', 20)
  ]), ['d-input', 'b-working', 'c-new', 'e-middle', 'a-old']);
});

test('active accounts and resources keep attention first, then name', () => {
  assert.deepEqual(names([
    { displayName: 'zeta', displayState: 'ok', observedAt: at(59) }, { displayName: 'alpha', displayState: 'ok', observedAt: at(1) },
    { displayName: 'mid', displayState: 'warning', observedAt: at(5), needsAttention: true }
  ]), ['mid', 'alpha', 'zeta']);
  // Equal activity times fall back to the name.
  assert.deepEqual(names([account('b', 'standby', 10), account('a', 'standby', 10)]), ['a', 'b']);
});

test('equal names and activity times use stable source or account IDs', () => {
  for (const isAccount of [true, false]) {
    const cards = ['b', 'a'].map(sourceId => ({ ...account('Same name', 'standby', 10), isAccount, sourceId }));
    assert.deepEqual(cards.sort(compareCards).map(card => card.sourceId), ['a', 'b']);
    assert.deepEqual(cards.reverse().sort(compareCards).map(card => card.sourceId), ['a', 'b']);
  }
});

test('agents precede resources, each category keeps its state and recency order', () => {
  // A resource's activity is its receipt time; its collector clock (observedAt) does not order it.
  const resource = (displayName, displayState, minutes) => ({ displayName, displayState, receivedAt: at(minutes), observedAt: at(59 - minutes), sourceId: displayName });
  assert.deepEqual(names([
    resource('a-silent', 'standby', 5), account('b-idle', 'standby', 30), resource('c-live', 'ok', 1),
    resource('d-error', 'error', 2), account('e-working', 'working', 3)
  ].map(card => card.displayName === 'd-error' ? { ...card, needsAttention: true } : card)), ['e-working', 'b-idle', 'd-error', 'c-live', 'a-silent']);
});
