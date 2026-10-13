// Local activity has its own projection; cloud identities and terminal routing stay out of it.
const FIELDS = ['project', 'state', 'character', 'tool', 'model', 'account'];
function localActivity(states, focusedProjectId) {
  return Object.entries(states)
    .filter(([id, state]) => !id.startsWith('cloud:') && typeof state.project === 'string' && state.project.trim())
    .map(([id, state]) => ({ id, focused: id === focusedProjectId, ...Object.fromEntries(FIELDS.filter(key => state[key] !== undefined).map(key => [key, state[key]])) }))
    .sort((a, b) => Number(b.focused) - Number(a.focused) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
}
module.exports = { localActivity };
