/**
 * LEARNING NOTE: Persistence with localStorage
 *
 * The browser gives every site a small key-value store that survives reloads.
 * We keep one versioned JSON document: saved rocket designs, campaign progress and
 * settings. Every read/write is wrapped in try/catch — storage can be disabled
 * (private mode) or full, and the game must still run.
 *
 * Key concepts: serialisation, schema versioning, defensive I/O
 */
import type { CraftData } from '../parts/Craft';
import type { VesselSnapshot } from '../sim/Snapshot';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export type Level3 = 'low' | 'medium' | 'high';
export type Level4 = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  /** A named preset fills in every graphics field below; 'custom' keeps the player's own mix. */
  quality: QualityPreset | 'custom';
  /** Internal resolution in CSS-pixel multiples (1 = one render pixel per CSS pixel). */
  renderScale: number;
  /** Lower the resolution automatically when the frame rate drops. */
  dynamicResolution: boolean;
  textures: 'low' | 'standard' | 'high';
  shadows: 'off' | 'low' | 'high';
  atmosphere: Level4;
  terrain: Level4;
  effects: Level3;
  master: number;
  music: number;
  sfx: number;
  voice: boolean;
  clouds: boolean;
  bloom: boolean;
  grain: boolean;
  showFps: boolean;
  /** On-screen flight controls: follow the device, or force on/off. */
  touchControls: 'auto' | 'on' | 'off';
  haptics: boolean;
  /** Frame-rate cap (0 = display refresh rate). 30 saves battery on phones. */
  frameCap: 0 | 30 | 60;
  /** Joystick sensitivity multiplier for touch steering. */
  stickSensitivity: number;
}

export interface CampaignProgress {
  /** Universal time of the campaign clock (s since J2000); new flights start no earlier. */
  ut: number;
  /** Vessels left in space or on other worlds between flights — the tracking station. */
  vessels: VesselSnapshot[];
  completed: string[];
  /** Best star rating (1–3) per mission id. */
  scores: Record<string, number>;
  funds: number;
  /** Story scenes already shown (chapter intros), so they play once. */
  storySeen: string[];
}

export interface SaveData {
  version: 1;
  crafts: CraftData[];
  campaign: CampaignProgress;
  settings: Settings;
  lastCraft: string | null;
}

const KEY = 'apogee.save.v1';

export function defaultSave(): SaveData {
  return {
    version: 1,
    crafts: [],
    campaign: { ut: 0, vessels: [], completed: [], scores: {}, funds: 0, storySeen: [] },
    settings: {
      quality: 'high',
      renderScale: 1.5,
      dynamicResolution: false,
      textures: 'high',
      shadows: 'high',
      atmosphere: 'high',
      terrain: 'high',
      effects: 'high',
      master: 0.8,
      music: 0.45,
      sfx: 0.9,
      voice: true,
      clouds: true,
      bloom: true,
      grain: true,
      showFps: false,
      touchControls: 'auto',
      haptics: true,
      frameCap: 0,
      stickSensitivity: 1,
    },
    lastCraft: null,
  };
}

/** True when a save already exists (first launch otherwise). */
export function hasSave(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const d = JSON.parse(raw) as Partial<SaveData>;
    const base = defaultSave();
    // Older saves predate the tracking station: fill in its fields
    const campaign = { ...base.campaign, ...(d.campaign ?? {}) };
    if (!Array.isArray(campaign.vessels)) campaign.vessels = [];
    if (typeof campaign.ut !== 'number' || !isFinite(campaign.ut)) campaign.ut = 0;
    return {
      version: 1,
      crafts: Array.isArray(d.crafts) ? d.crafts : [],
      campaign,
      settings: { ...base.settings, ...(d.settings ?? {}) },
      lastCraft: d.lastCraft ?? null,
    };
  } catch {
    return defaultSave();
  }
}

export function writeSave(s: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — progress simply isn't persisted */
  }
}
