// The order of workspace cards. Web and iPhone use the same order.
//
// 1. Inactive coding accounts go last.
// 2. Cards that need attention come first.
// 3. Inactive accounts: the most recently active first.
// 4. Then by name.

const inactive = card => card.isAccount === true && card.displayState === 'inactive';

/** Compares two cards: resources and coding accounts (see accountCard in cards.js). */
export function compareCards(a, b) {
  return Number(inactive(a)) - Number(inactive(b))
    || Number(Boolean(b.needsAttention)) - Number(Boolean(a.needsAttention))
    || (inactive(a) && inactive(b) ? Date.parse(b.observedAt) - Date.parse(a.observedAt) : 0)
    || a.displayName.localeCompare(b.displayName);
}
