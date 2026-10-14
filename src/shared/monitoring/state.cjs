// Canonical monitoring rules; ESP32 compiles the same policy and verifies the same cases.
const constants = require('../data/constants.json');
const { states } = require('../data/monitoring.json');
const rule = state => Object.hasOwn(states, state) ? states[state] : {};

const attention = Object.keys(states).filter(state => states[state].attentionRank).sort((a, b) => states[a].attentionRank - states[b].attentionRank);
const needsAttention = state => attention.includes(state);
const dominantState = (states, fallback = 'unknown') => attention.find(state => states.includes(state)) ?? fallback;
// Collectors report resources periodically, so silence means lost data. Coding
// hooks report events only: a long tool call or response is silent while work
// continues, so agent liveness comes from the event clock instead.
const sourceStale = (source, now = Date.now()) => source.kind !== 'agent' && (Boolean(source.stale) || now - Date.parse(source.receivedAt) >= constants.CLOUD_STALE_MS);

function agentTransition(state) {
  const transition = rule(state).transition;
  return transition ? { state: transition.state, after: constants[transition.after] } : null;
}

function idleAgentState(state, observedAt, now = Date.now()) {
  let elapsed = now - Date.parse(observedAt);
  let transition = agentTransition(state);
  while (transition && elapsed >= transition.after) {
    elapsed -= transition.after;
    state = transition.state;
    transition = agentTransition(state);
  }
  return state;
}

function sourceState(source, now = Date.now()) {
  if (source.agent) {
    // A project whose event clock reached sleep has stopped reporting.
    const state = idleAgentState(source.agent.state, source.observedAt, now);
    if (state === 'sleep') return 'inactive';
    // Health belongs to the event; once its state has aged, so has its health.
    return state === source.agent.state ? dominantState([source.health, state], state) : state;
  }
  return sourceStale(source, now) ? 'stale' : source.health;
}

function codingAccountState(states) {
  const reporting = states.filter(state => state !== 'inactive');
  return dominantState(reporting, reporting[0] ?? 'inactive');
}

const accountState = (account, now = Date.now()) => codingAccountState(account.sources.map(source => sourceState(source, now)));
function accountActivity(account, now = Date.now()) {
  const state = accountState(account, now);
  // Sources are newest first. Select the project responsible for the badge,
  // including older input requests; when inactive, retain the last project.
  const source = account.sources.find(source => sourceState(source, now) === state);
  const project = source?.agent?.project?.trim() || source?.displayName || account.displayName;
  return { state, source, project };
}
function companionState(source, now = Date.now()) {
  const state = sourceState(source, now);
  const mapped = { inactive: 'sleep', stale: 'sleep', error: 'alert', warning: 'notification', unknown: 'idle', ok: 'idle' };
  return Object.hasOwn(mapped, state) ? mapped[state] : state;
}
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
    // Source IDs are ASCII. Code-point ordering is identical on all platforms/locales.
    members.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    return { accountId, ...members[0].account, latest: members[0], sources: members, sourceIds: members.map(source => source.sourceId) };
  });
}

function attentionCount(sources, now = Date.now()) {
  return sources.filter(source => source.kind !== 'agent' && needsAttention(sourceState(source, now))).length
    + groupAccounts(sources).filter(account => needsAttention(accountState(account, now))).length;
}

module.exports = { needsAttention, dominantState, sourceStale, agentTransition, idleAgentState, sourceState, companionState, codingAccountState, accountState, accountActivity, accountKey, groupAccounts, attentionCount };
