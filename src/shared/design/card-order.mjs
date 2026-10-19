// The order of workspace cards and automatic Mac widget choices.
// Web and iPhone use the same order.
//
// 1. Inactive coding accounts go last.
// 2. Cards that need attention come first.
// 3. Inactive accounts: the most recently active first.
// 4. Then by name.
// 5. Stable source/account IDs break ties.

const inactive = card => card.isAccount === true && card.displayState === 'inactive';

/** Compares presentation fields for resources and coding accounts. */
export function compareCards(a, b) {
  return Number(inactive(a)) - Number(inactive(b))
    || Number(Boolean(b.needsAttention)) - Number(Boolean(a.needsAttention))
    || (inactive(a) && inactive(b) ? Date.parse(b.observedAt) - Date.parse(a.observedAt) : 0)
    || a.displayName.localeCompare(b.displayName)
    || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
}
