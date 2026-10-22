type CardFields = {
  sourceId: string;
  displayName: string;
  /** The presentation state from the shared monitoring rules. */
  displayState: string;
  needsAttention?: boolean;
};

/** Standby cards are ordered by their last activity: `observedAt` for accounts, `receivedAt` for resources. */
export type CardOrder = CardFields & ({ isAccount: true; observedAt: string } | { isAccount?: false; receivedAt: string });

export function compareCards(a: CardOrder, b: CardOrder): number;
