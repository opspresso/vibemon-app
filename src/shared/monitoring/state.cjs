// Canonical monitoring rules for the Desktop main process and Web.
const { CLOUD_STALE_MS, IDLE_TIMEOUT_MS, SLEEP_TIMEOUT_MS } = require('../data/constants.json');

const attention = ['error', 'alert', 'notification', 'warning', 'stale'];
const needsAttention = state => attention.includes(state);
const dominantState = (states, fallback = 'unknown') => attention.find(state => states.includes(state)) ?? fallback;
const sourceStale = (source, now = Date.now()) => Boolean(source.stale) || now - Date.parse(source.receivedAt) >= CLOUD_STALE_MS;

function idleAgentState(state, observedAt, now = Date.now()) {
  const elapsed = now - Date.parse(observedAt);
  const idleAfter = ['start', 'done'].includes(state) ? IDLE_TIMEOUT_MS
    : ['thinking', 'planning', 'working', 'notification', 'packing', 'alert'].includes(state) ? SLEEP_TIMEOUT_MS
      : state === 'idle' ? 0 : Infinity;
  if (elapsed >= idleAfter + SLEEP_TIMEOUT_MS) return 'sleep';
  if (elapsed >= idleAfter) return 'idle';
  return state;
}

function sourceState(source, now = Date.now()) {
  // Coding hooks report events, not a continuous heartbeat. Silence is normal.
  if (sourceStale(source, now)) return source.kind === 'agent' ? 'inactive' : 'stale';
  const state = source.agent ? idleAgentState(source.agent.state, source.observedAt, now) : source.health;
  return dominantState([source.health, state], state);
}

function codingAccountState(states) {
  const reporting = states.filter(state => state !== 'inactive');
  return dominantState(reporting, reporting[0] ?? 'inactive');
}

const accountState = (account, now = Date.now()) => codingAccountState(account.sources.map(source => sourceState(source, now)));
const accountKey = account => `${account.provider}:${account.id}`;

function groupAccounts(sources) {
  const groups = new Map();
  for (const source of sources) {
    if (source.kind !== 'agent' || !source.account) continue;
    const key = accountKey(source.account);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }
  return [...groups].map(([accountId, members]) => {
    members.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.sourceId.localeCompare(b.sourceId));
    return { accountId, ...members[0].account, latest: members[0], sources: members, sourceIds: members.map(source => source.sourceId) };
  });
}

function attentionCount(sources, now = Date.now()) {
  return sources.filter(source => source.kind !== 'agent' && needsAttention(sourceState(source, now))).length
    + groupAccounts(sources).filter(account => needsAttention(accountState(account, now))).length;
}

module.exports = { needsAttention, dominantState, sourceStale, idleAgentState, sourceState, codingAccountState, accountState, accountKey, groupAccounts, attentionCount };
