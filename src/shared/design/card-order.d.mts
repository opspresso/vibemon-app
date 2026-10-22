export type CardOrder = {
  sourceId: string;
  displayName: string;
  /** The presentation state from the shared monitoring rules. */
  displayState: string;
  /** The last observation; it orders standby cards. */
  observedAt: string;
  needsAttention?: boolean;
  isAccount?: boolean;
};

export function compareCards(a: CardOrder, b: CardOrder): number;
