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

export interface Settings {
  quality: 'low' | 'medium' | 'high' | 'ultra';
  master: number;
  music: number;
  sfx: number;
  voice: boolean;
  clouds: boolean;
  bloom: boolean;
  grain: boolean;
  showFps: boolean;
}

export interface CampaignProgress {
  completed: string[];
  /** Best score per mission id. */
  scores: Record<string, number>;
  funds: number;
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
    campaign: { completed: [], scores: {}, funds: 0 },
    settings: {
      quality: 'high',
      master: 0.8,
      music: 0.45,
      sfx: 0.9,
      voice: true,
      clouds: true,
      bloom: true,
      grain: true,
      showFps: false,
    },
    lastCraft: null,
  };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const d = JSON.parse(raw) as Partial<SaveData>;
    const base = defaultSave();
    return {
      version: 1,
      crafts: Array.isArray(d.crafts) ? d.crafts : [],
      campaign: { ...base.campaign, ...(d.campaign ?? {}) },
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
