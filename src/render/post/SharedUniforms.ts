/**
 * LEARNING NOTE: Compositing transparent effects over a post-processed atmosphere
 *
 * Smoke, exhaust plumes and map lines don't write depth. If they were drawn
 * together with the opaque world, the atmosphere pass would think those pixels
 * show empty sky and would pile a full sky's worth of haze on top — a grey smoke
 * column against a blue sky simply vanishes. So transparent objects live on their
 * own render LAYER and are drawn after the atmosphere is ray-marched, into a
 * separate buffer that is depth-tested against the opaque scene. Its alpha channel
 * accumulates coverage, and the final combine does
 *     colour = background · (1 − coverage) + transparent colour.
 *
 * These shared uniforms let particle/plume shaders fade into the air: they read
 * the scattered light of the background at their pixel and blend towards it with
 * distance (aerial perspective for effects).
 *
 * Key concepts: render layers, order-dependent transparency, premultiplied alpha,
 * aerial perspective
 */
import { Texture, Vector2 } from 'three';

/** three.js layer used for transparent effects drawn after the atmosphere pass. */
export const LAYER_TRANSPARENT = 1;

export const EFFECT_UNIFORMS = {
  /** Low-resolution in-scattered light towards the background (rgb). */
  tAtm: { value: null as Texture | null },
  /** Full-resolution pixel size of the frame. */
  uAtmFullSize: { value: new Vector2(1, 1) },
  /** Downscale factor of tAtm. */
  uAtmScale: { value: 2 },
  /** Extinction coefficient for effect fog (1/m) at the camera's altitude. */
  uFogDensity: { value: 0 },
};

/** GLSL to declare in effect shaders using EFFECT_UNIFORMS. */
export const EFFECT_FOG_GLSL = `
uniform sampler2D tAtm;
uniform vec2 uAtmFullSize;
uniform float uAtmScale;
uniform float uFogDensity;
// Returns fog amount for a fragment at view distance d, and the air light to blend to
float effectFog(float d, out vec3 airLight) {
  ivec2 lp = min(ivec2(gl_FragCoord.xy / uAtmScale), ivec2(uAtmFullSize / uAtmScale) - 1);
  airLight = texelFetch(tAtm, lp, 0).rgb;
  return 1.0 - exp(-d * uFogDensity);
}
`;
