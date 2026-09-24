/**
 * LEARNING NOTE: Reusable GLSL building blocks
 *
 * Shaders are small programs that run on the GPU once per vertex or per pixel.
 * Several of ours need the same maths — atmosphere lookups, noise, mapping a 3D
 * direction onto an equirectangular (latitude/longitude) texture — so we keep them
 * as string "chunks" concatenated into each shader, like #include in C.
 *
 * The equirectangular lookup uses Tarini's trick: at the ±180° seam the longitude
 * coordinate jumps from 1 back to 0, which makes the GPU think the texture is
 * minified hugely and pick the blurriest mip level (a visible line). We compute
 * two versions of u (wrapping at 0/1 and at ±0.5) and pick whichever has the
 * smaller screen-space derivative.
 *
 * Key concepts: GLSL, uniforms, texture lookups, mipmapping seams, value noise,
 * Henyey–Greenstein phase function
 */

export const glsl = (s: TemplateStringsArray, ...v: Array<string | number>): string =>
  s.reduce((acc, str, i) => acc + str + (i < v.length ? String(v[i]) : ''), '');

export const EQUIRECT = glsl`
const float APG_PI = 3.14159265358979;
vec2 dirToEquirect(vec3 d) {
  // Game body-fixed frame: lon = atan2(-z, x), lat = asin(y)
  float lon = atan(-d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  // u1 wraps at lon = ±180°, u2 (same texel, +1 period) wraps at lon = 0°.
  // Texture must use RepeatWrapping on S.
  float u1 = fract(lon / (2.0 * APG_PI) + 0.5);
  float u2 = fract(lon / (2.0 * APG_PI)) + 0.5;
  float u = fwidth(u1) <= fwidth(u2) + 1e-6 ? u1 : u2;
  return vec2(u, lat / APG_PI + 0.5);
}
`;

export const NOISE = glsl`
float apgHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float apgNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(apgHash(i + vec3(0, 0, 0)), apgHash(i + vec3(1, 0, 0)), f.x),
                 mix(apgHash(i + vec3(0, 1, 0)), apgHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(apgHash(i + vec3(0, 0, 1)), apgHash(i + vec3(1, 0, 1)), f.x),
                 mix(apgHash(i + vec3(0, 1, 1)), apgHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float apgFbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * apgNoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    a *= 0.5;
  }
  return s;
}
float apgHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Depth-buffer decoding shared by screen-space passes. Works for both depth
 * modes: reversed-Z (depth = near/viewZ roughly, 0 = infinity) and logarithmic
 * (depth = log2(1+w)/log2(far+1), 1 = infinity).
 */
export const DEPTH_FUNCS = glsl`
uniform float uReversedZ;
uniform float uNear;
uniform float uFar;
uniform float uLogFar;
uniform vec4 uProj; // (P00, P11, P20, P21) of the camera projection
bool depthIsSky(float d) { return uReversedZ > 0.5 ? d <= 0.0 : d >= 0.9999999; }
// Distance along the camera's forward axis to the surface stored in the depth buffer
float depthToViewZ(float d) {
  return uReversedZ > 0.5 ? (uNear * uFar) / (d * (uFar - uNear) + uNear) : exp2(d * uLogFar) - 1.0;
}
// View-space ray through a screen UV
vec3 viewRay(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(vec3((ndc.x + uProj.z) / uProj.x, (ndc.y + uProj.w) / uProj.y, -1.0));
}
`;

export const ATMOSPHERE_UNIFORMS = glsl`
uniform float uAtmBottom;
uniform float uAtmTop;
uniform vec3 uRayleigh;
uniform float uRayleighScale;
uniform vec3 uMieScat;
uniform vec3 uMieExt;
uniform float uMieScale;
uniform float uMieG;
uniform vec3 uAbsorption;
uniform float uAbsCenter;
uniform float uAbsWidth;
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScatter;
uniform sampler2D tAmbient;
`;

export const ATMOSPHERE_FUNCS = glsl`
const float TRANS_W = 256.0;
const float TRANS_H = 64.0;
const float MS_N = 32.0;
const float AMB_N = 64.0;

float atmCoord(float x, float size) { return 0.5 / size + x * (1.0 - 1.0 / size); }

vec3 atmTransmittance(float r, float mu) {
  float H = sqrt(max(0.0, uAtmTop * uAtmTop - uAtmBottom * uAtmBottom));
  float rho = sqrt(max(0.0, r * r - uAtmBottom * uAtmBottom));
  float disc = r * r * (mu * mu - 1.0) + uAtmTop * uAtmTop;
  float d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  float dMin = uAtmTop - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / max(1e-3, dMax - dMin);
  float xR = rho / H;
  return texture2D(tTransmittance, vec2(atmCoord(clamp(xMu, 0.0, 1.0), TRANS_W), atmCoord(clamp(xR, 0.0, 1.0), TRANS_H))).rgb;
}

// Sunlight reaching radius r with sun zenith cosine muS (soft planet shadow)
vec3 atmSunTransmittance(float r, float muS) {
  r = max(r, uAtmBottom + 1.0);
  float sinH = uAtmBottom / r;
  float cosH = -sqrt(max(0.0, 1.0 - sinH * sinH));
  vec3 t = atmTransmittance(r, max(muS, cosH + 1e-4));
  return t * clamp((muS - cosH) / 0.0093 + 0.5, 0.0, 1.0);
}

vec3 atmMS(float h, float muS) {
  vec2 uv = vec2(atmCoord(clamp(muS * 0.5 + 0.5, 0.0, 1.0), MS_N), atmCoord(clamp(h / (uAtmTop - uAtmBottom), 0.0, 1.0), MS_N));
  return texture2D(tMultiScatter, uv).rgb;
}

vec3 atmAmbient(float muS) {
  float x = clamp((muS + 0.35) / 1.35, 0.0, 1.0);
  return texture2D(tAmbient, vec2(atmCoord(x, AMB_N), 0.5)).rgb;
}

float phaseRayleigh(float nu) { return 3.0 / (16.0 * 3.14159265) * (1.0 + nu * nu); }
float phaseMie(float nu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * 3.14159265) * ((1.0 - g2) * (1.0 + nu * nu)) / ((2.0 + g2) * pow(max(1e-4, 1.0 + g2 - 2.0 * g * nu), 1.5));
}
float phaseHG(float nu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1e-4, 1.0 + g2 - 2.0 * g * nu), 1.5));
}
`;

/** Converts sRGB-encoded texture samples to linear. */
export const COLOR = glsl`
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;
