export interface AnimatedEngine {
  setReducedMotion(enabled: boolean): void;
  startAnimation(): void;
  stopAnimation(): void;
  render(): void;
}
export function observeAnimation(engine: AnimatedEngine, page?: Document, motion?: MediaQueryList): () => void;
