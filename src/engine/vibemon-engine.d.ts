export interface VibeMonEngineCharacterConfig {
  color: string;
  eyeColor?: string;
  glassesColor?: string;
  eyes: {
    left: { x: number; y: number };
    right: { x: number; y: number };
    w?: number;
    h?: number;
    size?: number;
  };
  effect: { x: number; y: number };
}

export interface VibeMonEngineStateConfig {
  eyeType: string;
  effect: string;
}

export interface VibeMonEngineOptions {
  characters: Record<string, VibeMonEngineCharacterConfig>;
  defaultCharacter?: string;
  characterImageUrls: Record<string, string | string[]>;
  states: Record<string, VibeMonEngineStateConfig>;
}

export declare class VibeMonEngine {
  constructor(container: HTMLElement | null, options: VibeMonEngineOptions);
  init(): Promise<VibeMonEngine>;
  setState(data: { state?: string; character?: string }): void;
  render(): void;
  startAnimation(): void;
  stopAnimation(): void;
  cleanup(): void;
}

export declare function createVibeMonEngine(
  container: HTMLElement | null,
  options: VibeMonEngineOptions
): VibeMonEngine;
