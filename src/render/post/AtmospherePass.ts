/**
 * LEARNING NOTE: Atmosphere as a post-process
 *
 * Instead of giving every object an "atmosphere-aware" shader, we render the scene
 * normally and then run ONE full-screen pass that, for every pixel, reconstructs
 * the view ray and the distance to whatever the pixel shows (from the depth
 * buffer), and adds the light scattered by the air along that ray:
 *
 *     final = scene · T(camera→surface) + inscattered light
 *
 * The same pass therefore produces the blue sky from the ground, the thin glowing
 * limb seen from orbit, and "aerial perspective" (distant mountains fading to
 * blue) — and it also lights the cloud layer, which is a 2-D shell intersected
 * analytically (no geometry → perfectly smooth at any altitude).
 *
 * Depth: we use a LOGARITHMIC depth buffer (depth = log₂(1+w)/log₂(far+1)) so a
 * single frame can hold a bolt 5 cm away and the Moon 384,000 km away. Inverting
 * that formula gives the true distance per pixel.
 *
 * Performance: ray marching every pixel is the most expensive thing in the frame,
 * but scattered light varies smoothly, so we march at HALF resolution and store
 * only the in-scattered light (rgb) plus the cloud occlusion (a). A full-resolution
 * pass then rebuilds each pixel with a DEPTH-AWARE upsample (neighbours at a very
 * different depth — sky behind a rocket — are rejected, so no halos), and computes
 * the exact per-channel transmittance with two lookups into the precomputed
 * transmittance table: T(a→b) = T(a→top) / T(b→top).
 *
 * Key concepts: deferred / screen-space effects, depth reconstruction,
 * ray–sphere intersection, ray marching, compositing with transmittance,
 * mixed-resolution rendering, bilateral (depth-aware) upsampling
 */
import { Matrix3, ShaderMaterial, Texture, Vector2, Vector3, Vector4, type PerspectiveCamera } from 'three';
import type { AtmosphereLUTs } from '../atmosphere/AtmosphereModel';
import { ATMOSPHERE_FUNCS, ATMOSPHERE_UNIFORMS, DEPTH_FUNCS, EQUIRECT, NOISE, glsl } from '../shaders/chunks';

const vertexShader = glsl`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = glsl`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2 uFullSize;
uniform float uScale;
uniform mat3 uCamToWorld;
${DEPTH_FUNCS}
uniform vec3 uPlanetCenter;
uniform float uCamAlt;
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform float uAtmEnabled;
uniform int uSteps;
uniform float uSkyExposureBoost;
// clouds
uniform sampler2D tClouds;
uniform mat3 uWorldToBody;
uniform float uCloudAlt;
uniform float uCloudOpacity;
uniform float uCloudsEnabled;
uniform float uTime;
${ATMOSPHERE_UNIFORMS}
${ATMOSPHERE_FUNCS}
${EQUIRECT}
${NOISE}

void integrate(vec3 dir, vec3 C, float tA, float tB, int steps, float expo, float phR, float phM, inout vec3 L, inout vec3 T) {
  float seg = tB - tA;
  if (seg <= 0.0) return;
  float tPrev = tA;
  for (int i = 0; i < 48; i++) {
    if (i >= steps) break;
    float f = pow((float(i) + 1.0) / float(steps), expo);
    float t1 = tA + seg * f;
    float dt = t1 - tPrev;
    float tm = tPrev + 0.5 * dt;
    vec3 p = dir * tm - C;
    float r = length(p);
    float h = r - uAtmBottom;
    float muS = dot(p / r, uSunDir);
    float hc = max(h, 0.0);
    float dR = exp(-hc / uRayleighScale);
    float dM = exp(-hc / uMieScale);
    float dO = max(0.0, 1.0 - abs(h - uAbsCenter) / uAbsWidth);
    vec3 sR = uRayleigh * dR;
    vec3 sM = uMieScat * dM;
    vec3 ext = sR + uMieExt * dM + uAbsorption * dO;
    vec3 Ts = atmSunTransmittance(r, muS);
    vec3 S = Ts * (sR * phR + sM * phM) + (sR + sM) * atmMS(h, muS);
    vec3 stepT = exp(-ext * dt);
    L += T * (S - S * stepT) / max(ext, vec3(1e-12));
    T *= stepT;
    tPrev = t1;
  }
}

// Output: rgb = light scattered towards the camera (already × sun radiance),
//         a   = fraction of the background NOT hidden by clouds.
void main() {
  // This low-res texel stands for full-res pixel i·F (the upsampler relies on it)
  ivec2 fp = min(ivec2(gl_FragCoord.xy) * int(uScale), ivec2(uFullSize) - 1);
  vec2 uv = (vec2(fp) + 0.5) / uFullSize;
  float depth = texelFetch(tDepth, fp, 0).r;
  vec3 dirView = viewRay(uv);
  vec3 dir = normalize(uCamToWorld * dirView);
  float cosFwd = max(1e-4, -dirView.z);
  bool sky = depthIsSky(depth);
  float sceneDist = sky ? 1e30 : depthToViewZ(depth) / cosFwd;

  float nu = dot(dir, uSunDir);
  if (uAtmEnabled < 0.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 C = uPlanetCenter;
  float rc = uAtmBottom + uCamAlt;
  float b = -dot(dir, C);
  float cTop = (rc - uAtmTop) * (rc + uAtmTop);
  float discTop = b * b - cTop;
  if (discTop <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float sq = sqrt(discTop);
  float t0 = max(0.0, -b - sq);
  float t1 = -b + sq;
  float cG = uCamAlt * (2.0 * uAtmBottom + uCamAlt);
  float discG = b * b - cG;
  float tGround = 1e30;
  if (discG > 0.0) {
    float tg = -b - sqrt(discG);
    if (tg > 0.0) tGround = tg;
  }
  float tEnd = min(t1, tGround);
  if (!sky) tEnd = min(tEnd, sceneDist);
  if (t0 >= tEnd) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float phR = phaseRayleigh(nu);
  float phM = phaseMie(nu, uMieG);
  float inside = 1.0 - smoothstep(0.0, uAtmTop - uAtmBottom, uCamAlt);
  float expo = mix(1.0, 2.2, inside);

  // --- clouds: analytic shell ---
  float tc = -1.0;
  float cloudA = 0.0;
  vec3 cloudCol = vec3(0.0);
  if (uCloudsEnabled > 0.5) {
    float rCl = uAtmBottom + uCloudAlt;
    float cC = (rc - rCl) * (rc + rCl);
    float discC = b * b - cC;
    if (discC > 0.0) {
      float sc = sqrt(discC);
      float ta = -b - sc;
      float tb = -b + sc;
      float tHit = rc < rCl ? tb : (ta > 0.0 ? ta : -1.0);
      if (tHit > t0 && tHit < tEnd) {
        vec3 pc = dir * tHit - C;
        vec3 upc = normalize(pc);
        vec3 bd = uWorldToBody * upc;
        vec2 cuv = dirToEquirect(bd);
        float cov = texture2D(tClouds, cuv).r;
        // Close-range detail breaks up the blurry global texture
        float near = 1.0 - smoothstep(20000.0, 180000.0, tHit);
        if (near > 0.0) {
          vec3 q = bd * (uAtmBottom / 2500.0) + vec3(uTime * 0.02, 0.0, uTime * 0.013);
          float n = apgFbm(q, 5);
          cov = mix(cov, cov * (0.55 + 0.9 * n), near);
        }
        float dens = smoothstep(0.12, 0.72, cov);
        // slab path length grows at grazing angles
        float mu = abs(dot(dir, upc));
        float a = 1.0 - pow(1.0 - clamp(dens, 0.0, 0.995), 1.0 / max(mu, 0.06));
        cloudA = clamp(a * uCloudOpacity, 0.0, 1.0);
        if (cloudA > 0.002) {
          float muSc = dot(upc, uSunDir);
          vec3 sunC = atmSunTransmittance(rCl, muSc) * uSunRadiance;
          // Self-shadowing: coverage sampled toward the sun
          vec3 toSun = normalize(uSunDir - upc * muSc);
          vec2 cuv2 = dirToEquirect(uWorldToBody * normalize(upc + toSun * 0.004));
          float occl = texture2D(tClouds, cuv2).r;
          float shade = 1.0 - 0.55 * smoothstep(0.2, 0.9, occl);
          float lit = clamp(muSc * 1.4 + 0.25, 0.0, 1.0);
          float below = rc < rCl ? 1.0 : 0.0;
          float base = mix(1.0, 0.45 + 0.4 * (1.0 - dens), below);
          float silver = 0.7 + 1.6 * phaseHG(nu, 0.6) * 4.0 * 3.14159265 * 0.25;
          vec3 amb = atmAmbient(muSc) * uSunRadiance * 0.6 + atmMS(uCloudAlt, muSc) * uSunRadiance * 2.0;
          cloudCol = 0.92 * (sunC * lit * shade * base * silver / 3.14159265 + amb);
          tc = tHit;
        }
      }
    }
  }

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  if (tc > 0.0) {
    int sA = max(4, int(float(uSteps) * 0.6));
    int sB = max(4, uSteps - sA);
    integrate(dir, C, t0, tc, sA, expo, phR, phM, L, T);
    vec3 LB = vec3(0.0);
    vec3 TB = vec3(1.0);
    integrate(dir, C, tc, tEnd, sB, 1.0, phR, phM, LB, TB);
    // total = L·E + T·((1−a)·(L_B·E + T_B·scene) + a·cloud); the scene term
    // T·T_B·(1−a) is rebuilt at full resolution, so only (1−a) is stored.
    vec3 Lt = L * uSunRadiance + T * ((1.0 - cloudA) * LB * uSunRadiance + cloudA * cloudCol);
    gl_FragColor = vec4(Lt, 1.0 - cloudA);
  } else {
    integrate(dir, C, t0, tEnd, uSteps, expo, phR, phM, L, T);
    gl_FragColor = vec4(L * uSunRadiance * uSkyExposureBoost, 1.0);
  }
}
`;

/** Full-resolution pass: depth-aware upsample of the low-res scattering + exact transmittance. */
const combineShader = glsl`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tAtm;
uniform sampler2D tTrans;
uniform vec2 uFullSize;
uniform vec2 uLowSize;
uniform float uScale;
uniform mat3 uCamToWorld;
${DEPTH_FUNCS}
uniform vec3 uPlanetCenter;
uniform float uCamAlt;
uniform vec3 uSunDir;
uniform float uAtmEnabled;
uniform vec3 uSunDisc;
uniform float uSunCosRadius;
${ATMOSPHERE_UNIFORMS}
${ATMOSPHERE_FUNCS}

// log2 of view distance; sky maps to a huge value so it never matches geometry
float logDist(float d) { return depthIsSky(d) ? 60.0 : log2(max(depthToViewZ(d), 1e-3)); }

// Per-channel transmittance from the camera to distance sceneDist along dir
vec3 viewTransmittance(vec3 dir, float sceneDist, bool sky) {
  vec3 C = uPlanetCenter;
  float rc = uAtmBottom + uCamAlt;
  float b = -dot(dir, C);
  float discTop = b * b - (rc - uAtmTop) * (rc + uAtmTop);
  if (discTop <= 0.0) return vec3(1.0);
  float sq = sqrt(discTop);
  float t0 = max(0.0, -b - sq);
  float t1 = -b + sq;
  if (t1 <= 0.0) return vec3(1.0);
  float discG = b * b - uCamAlt * (2.0 * uAtmBottom + uCamAlt);
  bool hitsGround = false;
  float tG = 1e30;
  if (discG > 0.0) {
    float tg = -b - sqrt(discG);
    if (tg > 0.0) {
      tG = tg;
      hitsGround = true;
    }
  }
  if (sky && hitsGround) return vec3(0.0);
  float tEnd = min(t1, tG);
  if (!sky) tEnd = min(tEnd, sceneDist);
  if (tEnd <= t0) return vec3(1.0);
  float r0 = t0 > 0.0 ? uAtmTop : rc;
  float mu0 = clamp((b + t0) / r0, -1.0, 1.0);
  if (!hitsGround && tEnd >= t1 - 1.0) return atmTransmittance(r0, mu0);
  float r1 = sqrt(max(0.0, tEnd * tEnd + 2.0 * b * tEnd + rc * rc));
  float mu1 = clamp((b + tEnd) / max(r1, 1.0), -1.0, 1.0);
  if (hitsGround) return min(atmTransmittance(r1, -mu1) / max(atmTransmittance(r0, -mu0), vec3(1e-6)), vec3(1.0));
  return min(atmTransmittance(r0, mu0) / max(atmTransmittance(r1, mu1), vec3(1e-6)), vec3(1.0));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 scene = texelFetch(tScene, p, 0).rgb;
  float depth = texelFetch(tDepth, p, 0).r;
  vec2 uv = (vec2(p) + 0.5) / uFullSize;
  vec3 dirView = viewRay(uv);
  vec3 dir = normalize(uCamToWorld * dirView);
  bool sky = depthIsSky(depth);
  float nu = dot(dir, uSunDir);
  if (sky && nu > uSunCosRadius) {
    // Sun disc with limb darkening
    float x = clamp((1.0 - nu) / (1.0 - uSunCosRadius), 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - x));
    scene += uSunDisc * limb;
  }
  vec4 trans = texelFetch(tTrans, p, 0);
  if (uAtmEnabled < 0.5) {
    gl_FragColor = vec4(scene * (1.0 - trans.a) + trans.rgb, 1.0);
    return;
  }

  // Depth-aware upsample: low-res texel i was computed for full-res pixel i·F
  float myLog = logDist(depth);
  int F = int(uScale);
  vec2 lf = vec2(p) / uScale;
  ivec2 i0 = ivec2(floor(lf));
  vec2 f = lf - vec2(i0);
  ivec2 lmax = ivec2(uLowSize) - 1;
  ivec2 fmax = ivec2(uFullSize) - 1;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  float maxDiff = 0.0;
  float bestDiff = 1e9;
  vec4 best = vec4(0.0, 0.0, 0.0, 1.0);
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    if (w <= 0.0) continue;
    ivec2 li = min(i0 + o, lmax);
    float d = texelFetch(tDepth, min(li * F, fmax), 0).r;
    vec4 a = texelFetch(tAtm, li, 0);
    // Compare log distances so the test is scale-free (sky counts as "infinitely far")
    float diff = abs(logDist(d) - myLog);
    maxDiff = max(maxDiff, diff);
    acc += a * w;
    wsum += w;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = a;
    }
  }
  vec4 atm = maxDiff < 0.06 ? acc / max(wsum, 1e-6) : best;

  float cosFwd = max(1e-4, -dirView.z);
  float sceneDist = sky ? 1e30 : depthToViewZ(depth) / cosFwd;
  vec3 T = viewTransmittance(dir, sceneDist, sky);
  vec3 col = atm.rgb + scene * T * atm.a;
  // Transparent effects layer (premultiplied colour, alpha = coverage)
  gl_FragColor = vec4(col * (1.0 - trans.a) + trans.rgb, 1.0);
}
`;

export interface AtmosphereFrame {
  enabled: boolean;
  /** Scattering tables of the planet whose atmosphere is drawn (Earth or Mars). */
  luts: AtmosphereLUTs;
  planetCenter: Vector3;
  cameraAltitude: number;
  sunDir: Vector3;
  sunRadiance: Vector3;
  worldToBody: Matrix3;
  cloudsEnabled: boolean;
  cloudAltitude: number;
  cloudOpacity: number;
  time: number;
}

const _camToWorld = new Matrix3();

export class AtmospherePass {
  /** Low-resolution ray march (writes scattered light + cloud occlusion). */
  readonly material: ShaderMaterial;
  /** Full-resolution depth-aware upsample and composite over the scene. */
  readonly combine: ShaderMaterial;
  private luts: AtmosphereLUTs;

  constructor(luts: AtmosphereLUTs, clouds: Texture | null) {
    this.luts = luts;
    const atmUniforms = () => {
      const p = luts.params;
      return {
        uAtmBottom: { value: p.bottomRadius },
        uAtmTop: { value: p.topRadius },
        uRayleigh: { value: new Vector3(...p.rayleighScattering) },
        uRayleighScale: { value: p.rayleighScale },
        uMieScat: { value: new Vector3(...p.mieScattering) },
        uMieExt: { value: new Vector3(...p.mieExtinction) },
        uMieScale: { value: p.mieScale },
        uMieG: { value: p.mieG },
        uAbsorption: { value: new Vector3(...p.absorption) },
        uAbsCenter: { value: p.absorptionCenter },
        uAbsWidth: { value: p.absorptionWidth },
        tTransmittance: { value: luts.transmittanceTexture },
        tMultiScatter: { value: luts.multiScatteringTexture },
        tAmbient: { value: luts.ambientTexture },
      };
    };
    const shared = () => ({
      tDepth: { value: null as Texture | null },
      uFullSize: { value: new Vector2(1, 1) },
      uScale: { value: 2 },
      uCamToWorld: { value: new Matrix3() },
      uReversedZ: { value: 0 },
      uNear: { value: 0.1 },
      uFar: { value: 1 },
      uLogFar: { value: 1 },
      uProj: { value: new Vector4(1, 1, 0, 0) },
      uPlanetCenter: { value: new Vector3() },
      uCamAlt: { value: 0 },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uAtmEnabled: { value: 1 },
    });
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...shared(),
        ...atmUniforms(),
        uSunRadiance: { value: new Vector3(20, 20, 20) },
        uSteps: { value: 24 },
        uSkyExposureBoost: { value: 1 },
        tClouds: { value: clouds },
        uWorldToBody: { value: new Matrix3() },
        uCloudAlt: { value: 6500 },
        uCloudOpacity: { value: 0.95 },
        uCloudsEnabled: { value: clouds ? 1 : 0 },
        uTime: { value: 0 },
      },
    });
    this.combine = new ShaderMaterial({
      vertexShader,
      fragmentShader: combineShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...shared(),
        ...atmUniforms(),
        tScene: { value: null },
        tAtm: { value: null },
        tTrans: { value: null },
        uLowSize: { value: new Vector2(1, 1) },
        uSunDisc: { value: new Vector3(4e4, 3.9e4, 3.7e4) },
        uSunCosRadius: { value: Math.cos(0.00465) },
      },
    });
  }

  setLUTs(luts: AtmosphereLUTs): void {
    this.luts = luts;
    const p = luts.params;
    for (const m of [this.material, this.combine]) {
      const u = m.uniforms;
      u.uAtmBottom!.value = p.bottomRadius;
      u.uAtmTop!.value = p.topRadius;
      (u.uRayleigh!.value as Vector3).set(...p.rayleighScattering);
      u.uRayleighScale!.value = p.rayleighScale;
      (u.uMieScat!.value as Vector3).set(...p.mieScattering);
      (u.uMieExt!.value as Vector3).set(...p.mieExtinction);
      u.uMieScale!.value = p.mieScale;
      u.uMieG!.value = p.mieG;
      (u.uAbsorption!.value as Vector3).set(...p.absorption);
      u.uAbsCenter!.value = p.absorptionCenter;
      u.uAbsWidth!.value = p.absorptionWidth;
      u.tTransmittance!.value = luts.transmittanceTexture;
      u.tMultiScatter!.value = luts.multiScatteringTexture;
      u.tAmbient!.value = luts.ambientTexture;
    }
  }

  /**
   * @param reversedZ depth buffer encoding (reversed-Z float vs logarithmic)
   * @param fullW full-resolution width in pixels (fullH likewise)
   * @param scale integer downscale factor of the ray-march target (1 or 2)
   */
  update(frame: AtmosphereFrame, camera: PerspectiveCamera, reversedZ: boolean, fullW: number, fullH: number, scale: number): void {
    if (frame.luts !== this.luts) this.setLUTs(frame.luts);
    _camToWorld.setFromMatrix4(camera.matrixWorld);
    const pe = camera.projectionMatrix.elements;
    for (const m of [this.material, this.combine]) {
      const u = m.uniforms;
      u.uAtmEnabled!.value = frame.enabled ? 1 : 0;
      (u.uPlanetCenter!.value as Vector3).copy(frame.planetCenter);
      u.uCamAlt!.value = frame.cameraAltitude;
      (u.uSunDir!.value as Vector3).copy(frame.sunDir);
      (u.uCamToWorld!.value as Matrix3).copy(_camToWorld);
      u.uReversedZ!.value = reversedZ ? 1 : 0;
      u.uNear!.value = camera.near;
      u.uFar!.value = camera.far;
      u.uLogFar!.value = Math.log2(camera.far + 1);
      (u.uProj!.value as Vector4).set(pe[0]!, pe[5]!, pe[8]!, pe[9]!);
      (u.uFullSize!.value as Vector2).set(fullW, fullH);
      u.uScale!.value = scale;
    }
    const u = this.material.uniforms;
    (u.uSunRadiance!.value as Vector3).copy(frame.sunRadiance);
    (u.uWorldToBody!.value as Matrix3).copy(frame.worldToBody);
    u.uCloudsEnabled!.value = frame.cloudsEnabled && u.tClouds!.value ? 1 : 0;
    u.uCloudAlt!.value = frame.cloudAltitude;
    u.uCloudOpacity!.value = frame.cloudOpacity;
    u.uTime!.value = frame.time;
    (this.combine.uniforms.uLowSize!.value as Vector2).set(Math.ceil(fullW / scale), Math.ceil(fullH / scale));
  }

  dispose(): void {
    this.material.dispose();
    this.combine.dispose();
  }
}
