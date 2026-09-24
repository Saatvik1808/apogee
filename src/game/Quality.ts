/**
 * LEARNING NOTE: Quality presets and dynamic resolution
 *
 * The most expensive thing in this renderer is per-pixel work: the atmosphere pass
 * marches 12–32 samples per pixel, at half (or a third) of the screen resolution.
 * Rendering at a lower INTERNAL resolution and upscaling is the single biggest
 * performance lever; after that come atmosphere samples, terrain detail, shadows
 * and particle counts.
 *
 * A PRESET is just a row in a table that fills in every individual option, tuned
 * separately for desktops and for phones (whose screens pack 2.5–3.5 device pixels
 * into each CSS pixel — "native" resolution there would be 5–10× the pixels of a
 * laptop, on a GPU that also has to protect a battery). Touching any single option
 * switches the preset to "custom" so the player's own mix is preserved.
 *
 * DYNAMIC RESOLUTION watches the frame rate: when frames arrive late for a while
 * the render scale steps down, and it creeps back up when there is headroom.
 * Consoles use the same trick to hold 60 FPS in busy scenes.
 *
 * Key concepts: resolution scaling, performance budgets, presets, mobile GPUs,
 * feedback control (dynamic resolution)
 */
import type { GameContext } from './GameContext';
import type { Level3, Level4, QualityPreset, Settings } from './Save';

export type GraphicsFields = Pick<Settings, 'renderScale' | 'dynamicResolution' | 'frameCap' | 'textures' | 'shadows' | 'atmosphere' | 'terrain' | 'effects' | 'bloom' | 'grain' | 'clouds'>;

const DESKTOP: Record<QualityPreset, GraphicsFields> = {
  low: { renderScale: 0.75, dynamicResolution: true, frameCap: 30, textures: 'standard', shadows: 'off', atmosphere: 'low', terrain: 'low', effects: 'low', bloom: false, grain: false, clouds: true },
  medium: { renderScale: 1, dynamicResolution: true, frameCap: 60, textures: 'standard', shadows: 'low', atmosphere: 'medium', terrain: 'medium', effects: 'medium', bloom: true, grain: true, clouds: true },
  high: { renderScale: 1.5, dynamicResolution: false, frameCap: 0, textures: 'high', shadows: 'high', atmosphere: 'high', terrain: 'high', effects: 'high', bloom: true, grain: true, clouds: true },
  ultra: { renderScale: 2, dynamicResolution: false, frameCap: 0, textures: 'high', shadows: 'high', atmosphere: 'ultra', terrain: 'ultra', effects: 'high', bloom: true, grain: true, clouds: true },
};

const MOBILE: Record<QualityPreset, GraphicsFields> = {
  low: { renderScale: 0.7, dynamicResolution: true, frameCap: 30, textures: 'low', shadows: 'off', atmosphere: 'low', terrain: 'low', effects: 'low', bloom: false, grain: false, clouds: true },
  medium: { renderScale: 0.9, dynamicResolution: true, frameCap: 60, textures: 'low', shadows: 'low', atmosphere: 'medium', terrain: 'medium', effects: 'medium', bloom: true, grain: false, clouds: true },
  high: { renderScale: 1.15, dynamicResolution: true, frameCap: 60, textures: 'low', shadows: 'low', atmosphere: 'high', terrain: 'high', effects: 'high', bloom: true, grain: true, clouds: true },
  ultra: { renderScale: 1.5, dynamicResolution: false, frameCap: 0, textures: 'standard', shadows: 'high', atmosphere: 'ultra', terrain: 'high', effects: 'high', bloom: true, grain: true, clouds: true },
};

export const PRESET_LABELS: Record<QualityPreset | 'custom', { name: string; sub: string }> = {
  low: { name: 'Battery saver', sub: '30 FPS · lowest resolution · longest battery life' },
  medium: { name: 'Balanced', sub: '60 FPS target · good looks on most devices' },
  high: { name: 'High', sub: 'Sharp image, full shadows and effects' },
  ultra: { name: 'Ultra', sub: 'Everything maxed — for powerful GPUs' },
  custom: { name: 'Custom', sub: 'Your own mix of the options below' },
};

export function presetFields(preset: QualityPreset, mobile: boolean): GraphicsFields {
  return { ...(mobile ? MOBILE : DESKTOP)[preset] };
}

/** Copy a preset's values into the settings (no-op for 'custom'). */
export function applyPreset(s: Settings, mobile: boolean): void {
  if (s.quality === 'custom') return;
  Object.assign(s, presetFields(s.quality, mobile));
}

const ATM_STEPS: Record<Level4, number> = { low: 12, medium: 16, high: 24, ultra: 32 };
const TERRAIN_BIAS: Record<Level4, number> = { low: 0.55, medium: 0.8, high: 1.0, ultra: 1.35 };
const EFFECTS: Record<Level3, number> = { low: 0.4, medium: 0.7, high: 1 };

export function applyQuality(ctx: GameContext): void {
  const s = ctx.save.settings;
  const mobile = ctx.platform.touchDevice;
  applyPreset(s, mobile);
  const post = ctx.post.settings;
  const space = ctx.space;

  // Atmosphere: sample count + march resolution (phones march at ⅓ resolution)
  post.atmosphereSteps = mobile ? Math.min(20, ATM_STEPS[s.atmosphere] - 2) : ATM_STEPS[s.atmosphere];
  resolution.atmScale = mobile ? (s.atmosphere === 'ultra' ? 2 : 3) : s.atmosphere === 'ultra' ? 1 : 2;
  space.quality.lodBias = TERRAIN_BIAS[s.terrain] * (mobile ? 0.8 : 1);
  space.quality.effects = EFFECTS[s.effects];
  space.quality.clouds = s.clouds;

  ctx.renderer.shadowSize = s.shadows === 'high' ? 2048 : 1024;
  ctx.renderer.shadowsEnabled = s.shadows !== 'off';
  resolution.base = s.renderScale;
  resolution.enabled = s.dynamicResolution;
  resolution.target = s.frameCap || 60;
  resolution.apply(ctx);

  post.bloom = s.bloom;
  // Bloom is a blur: phones run its pyramid at a quarter of the resolution
  post.bloomScale = mobile ? 2 : 1;
  post.grain = s.grain ? 0.022 : 0;
  post.aberration = s.atmosphere === 'low' ? 0 : 0.004;

  ctx.platform.haptics = s.haptics;
  ctx.platform.setTouch(s.touchControls === 'on' || (s.touchControls === 'auto' && ctx.platform.touchDevice));
  const a = ctx.audio.settings;
  a.master = s.master;
  a.music = s.music;
  a.sfx = s.sfx;
  a.voice = s.voice;
  ctx.audio.applySettings();
}

/**
 * Texture tier to load at start-up (changing it needs a restart). The 8k Earth
 * maps are not shipped inside the Android package (they would double its size),
 * so a native build clamps 'high' to 'standard' whatever the save says — an old
 * or hand-edited save must never point the loader at files that do not exist.
 */
export function textureTier(s: Settings, maxTextureSize: number, native = false): 'low' | 'standard' | 'high' {
  if (s.textures === 'high' && (native || maxTextureSize < 8192)) return 'standard';
  return s.textures;
}

/**
 * Dynamic resolution controller. `base` is the player's chosen render scale;
 * `factor` (0.5–1) is trimmed off it when frames arrive late.
 */
export const resolution = {
  base: 1,
  factor: 1,
  enabled: false,
  target: 60,
  /** Preferred atmosphere march downscale (1–3) from the quality settings. */
  atmScale: 2 as 1 | 2 | 3,
  st: { avg: 1 / 60, slow: 0, fast: 0, applied: -1, atm: -1 },

  apply(ctx: GameContext): void {
    const dpr = window.devicePixelRatio || 1;
    const scale = this.base * (this.enabled ? this.factor : 1);
    const px = Math.min(dpr, Math.max(0.35, scale));
    // Renderer.setResolutionScale multiplies min(dpr, 2); convert
    const rs = px / Math.min(dpr, 2);
    if (Math.abs(rs - this.st.applied) > 1e-3) {
      this.st.applied = rs;
      ctx.renderer.setResolutionScale(rs);
    }
    // Never let the atmosphere buffer get coarser than ~90k pixels: when the
    // internal resolution is already low, march at a finer downscale instead
    const r = ctx.renderer;
    const pixels = r.width * r.height * r.pixelRatio * r.pixelRatio;
    let a = this.atmScale;
    while (a > 1 && pixels / (a * a) < 90_000) a = (a - 1) as 1 | 2 | 3;
    if (a !== this.st.atm) {
      this.st.atm = a;
      ctx.post.setAtmosphereScale(a);
    }
  },

  /** Feed one frame's duration (seconds); adjusts the factor occasionally. */
  frame(ctx: GameContext, dt: number, capFps = 0): void {
    if (!this.enabled || dt <= 0 || dt > 0.5) return;
    const p = this.st;
    p.avg += (dt - p.avg) * 0.05;
    const fps = 1 / p.avg;
    // Judge against the frame rate actually allowed right now (menus may be capped)
    const target = capFps > 0 ? Math.min(this.target, capFps) : this.target;
    if (fps < target * 0.88) {
      p.slow += dt;
      p.fast = 0;
    } else if (fps > target * 0.97) {
      p.fast += dt;
      p.slow = 0;
    } else {
      p.slow = 0;
      p.fast = 0;
    }
    if (p.slow > 1.2 && this.factor > 0.5) {
      this.factor = Math.max(0.5, Math.round((this.factor - 0.1) * 20) / 20);
      p.slow = 0;
      this.apply(ctx);
    } else if (p.fast > 5 && this.factor < 1) {
      this.factor = Math.min(1, Math.round((this.factor + 0.05) * 20) / 20);
      p.fast = 0;
      this.apply(ctx);
    }
  },
};
