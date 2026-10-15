// Local activity has its own projection; cloud identities and terminal routing stay out of it.
const { LOADING_STATES } = require('../shared/config.cjs');
const FIELDS = ['project', 'state', 'character', 'tool', 'model', 'account'];
function localActivity(states, focusedProjectId) {
  return Object.entries(states)
    .filter(([id, state]) => !id.startsWith('cloud:') && typeof state.project === 'string' && state.project.trim())
    // `running` comes from the state registry, so the renderer needs no state list of its own.
    .map(([id, state]) => ({ id, focused: id === focusedProjectId, running: LOADING_STATES.includes(state.state), ...Object.fromEntries(FIELDS.filter(key => state[key] !== undefined).map(key => [key, state[key]])) }))
    .sort((a, b) => Number(b.focused) - Number(a.focused) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
}
module.exports = { localActivity };
