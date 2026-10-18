export type CardOrder = {
  sourceId: string;
  displayName: string;
  needsAttention?: boolean;
} & ({
  isAccount: true;
  displayState: string;
  observedAt: string;
} | {
  isAccount?: false;
});

export function compareCards(a: CardOrder, b: CardOrder): number;
