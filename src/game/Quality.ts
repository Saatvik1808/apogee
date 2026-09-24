/**
 * LEARNING NOTE: Quality presets
 *
 * The most expensive thing in this renderer is per-pixel work: the atmosphere pass
 * marches ~24 samples per pixel (at half resolution below Ultra). Rendering at a
 * lower internal resolution (and upscaling) is the single biggest performance
 * lever; after that come atmosphere sample count, terrain detail and bloom.
 *
 * Key concepts: resolution scaling, performance budgets, presets
 */
import type { GameContext } from './GameContext';

export function applyQuality(ctx: GameContext): void {
  const s = ctx.save.settings;
  const dpr = window.devicePixelRatio || 1;
  const post = ctx.post.settings;
  const space = ctx.space;
  let pixelCap = 1.5;
  switch (s.quality) {
    case 'low':
      pixelCap = 0.75;
      post.atmosphereSteps = 12;
      space.quality.lodBias = 0.6;
      break;
    case 'medium':
      pixelCap = 1.0;
      post.atmosphereSteps = 16;
      space.quality.lodBias = 0.8;
      break;
    case 'high':
      pixelCap = 1.5;
      post.atmosphereSteps = 24;
      space.quality.lodBias = 1.0;
      break;
    case 'ultra':
      pixelCap = 2.0;
      post.atmosphereSteps = 32;
      space.quality.lodBias = 1.35;
      break;
  }
  ctx.renderer.setResolutionScale(Math.min(dpr, pixelCap) / Math.min(dpr, 2));
  ctx.post.setAtmosphereScale(s.quality === 'ultra' ? 1 : 2);
  post.bloom = s.bloom && s.quality !== 'low';
  post.grain = s.grain ? 0.022 : 0;
  post.aberration = s.quality === 'low' ? 0 : 0.004;
  space.quality.clouds = s.clouds;
  const a = ctx.audio.settings;
  a.master = s.master;
  a.music = s.music;
  a.sfx = s.sfx;
  a.voice = s.voice;
  ctx.audio.applySettings();
}
