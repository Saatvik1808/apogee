/**
 * LEARNING NOTE: Shared services (dependency injection by hand)
 *
 * Game states (menu, assembly building, flight) need the same long-lived services:
 * the renderer, loaded assets, the solar system, the planet renderer, audio,
 * input and saved progress. Passing one context object around makes those
 * dependencies explicit and avoids hidden global singletons.
 *
 * Key concepts: dependency injection, service locator, state lifetimes
 */
import type { Renderer } from '../render/Renderer';
import type { GameAssets } from '../render/Assets';
import type { SolarSystem } from '../physics/SolarSystem';
import type { SpaceScene } from '../render/SpaceScene';
import type { PostFX } from '../render/post/PostFX';
import type { EnvironmentProbe } from '../render/EnvironmentProbe';
import type { Input } from './Input';
import type { AudioEngine } from '../audio/AudioEngine';
import type { SaveData } from './Save';
import type { Platform } from '../platform/Platform';

export interface GameContext {
  renderer: Renderer;
  assets: GameAssets;
  system: SolarSystem;
  space: SpaceScene;
  post: PostFX;
  env: EnvironmentProbe;
  input: Input;
  audio: AudioEngine;
  save: SaveData;
  /** Device capabilities and native-shell services (haptics, Back button, lifecycle). */
  platform: Platform;
  /** Root element for DOM UI layers. */
  ui: HTMLElement;
  /** Texture tier uploaded at start-up (changing it needs a restart). */
  textureTierLoaded: 'low' | 'standard' | 'high';
}

export interface GameState {
  update(realDt: number): void;
  render(): void;
  dispose(): void;
}
