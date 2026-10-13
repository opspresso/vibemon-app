export declare function barColor(percent: number): string;
export declare function formatMinutes(mins: number): string;
export declare function hexToRgb(hex: string): { r: number; g: number; b: number };
export declare function bgRgba(hex: string, alpha: number): string;
export declare function pickTextColor(hex: string): string;

export interface BubbleTextField {
  type: 'text';
  text: string;
  showLoading?: boolean;
  slow?: boolean;
}

export interface BubbleMetricField {
  type: 'metric';
  icon: string;
  value: number;
  resetIn?: number;
  /** Prefix shown before the percentage, e.g. "Fable" on the model-scoped weekly row. */
  label?: string;
}

export declare function renderBubble(
  bubbleEl: HTMLElement,
  fields: Record<string, BubbleTextField | BubbleMetricField>,
  tailSide: 'top' | 'bottom' | 'left' | 'right',
  bgColor: string,
  opts?: { opaque?: boolean }
): void;
