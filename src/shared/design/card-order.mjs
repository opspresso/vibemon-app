// The order of workspace cards and automatic Mac widget choices.
// Web and iPhone use the same order.
//
// 1. Standby cards go last.
// 2. Cards that need attention come first.
// 3. Standby cards: the most recently active first. A resource was last
//    active when the server received its report (`receivedAt`), the same
//    clock that puts it on standby; an account when its project reported
//    (`observedAt`).
// 4. Then by name.
// 5. Stable source/account IDs break ties.

const standby = card => card.displayState === 'standby';
const activeAt = card => Date.parse(card.isAccount ? card.observedAt : card.receivedAt);

/** Compares presentation fields for resources and coding accounts. */
export function compareCards(a, b) {
  return Number(standby(a)) - Number(standby(b))
    || Number(Boolean(b.needsAttention)) - Number(Boolean(a.needsAttention))
    || (standby(a) && standby(b) ? activeAt(b) - activeAt(a) : 0)
    || a.displayName.localeCompare(b.displayName)
    || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
}
