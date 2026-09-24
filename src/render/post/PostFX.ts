/**
 * LEARNING NOTE: The post-processing chain ("the film look")
 *
 * The scene is rendered in HDR — pixel values can exceed 1.0 (the Sun is tens of
 * thousands of times brighter than a painted rocket). A chain of full-screen passes
 * then turns that physical light into a displayable image:
 *
 *   1. Scene        → half-float colour + float depth
 *   2. Atmosphere   → sky, aerial perspective, clouds, sun disc
 *   3. Bloom        → very bright pixels bleed light into neighbours (lens glow)
 *   4. Composite    → exposure, lens flare, ACES filmic tone mapping (HDR → 0..1),
 *                     colour grading, vignette, film grain, dithering, sRGB encode
 *   5. FXAA         → fast anti-aliasing of jagged edges
 *
 * Tone mapping is what makes a bright sunlit rocket against black space look like
 * a photograph instead of a flat cartoon: highlights roll off gently instead of
 * clipping to white.
 *
 * Key concepts: HDR rendering, render targets, full-screen passes, bloom, tone
 * mapping (ACES), exposure, sRGB encoding, FXAA
 */
import {
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { AtmospherePass, type AtmosphereFrame } from './AtmospherePass';
import { EFFECT_UNIFORMS, LAYER_TRANSPARENT } from './SharedUniforms';
import type { AtmosphereLUTs } from '../atmosphere/AtmosphereModel';
import { COLOR, glsl } from '../shaders/chunks';

const compositeFrag = glsl`
precision highp float;
varying vec2 vUv;
uniform sampler2D tHDR;
uniform sampler2D tDepth;
uniform float uExposure;
uniform vec2 uSunUV;
uniform float uSunOnScreen;
uniform float uFlare;
uniform vec3 uFlareTint;
uniform float uAspect;
uniform float uTime;
uniform float uVignette;
uniform float uGrain;
uniform float uAberration;
uniform float uSaturation;
uniform float uContrast;
uniform float uFade;
${COLOR}

vec3 acesFitted(vec3 c) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = inM * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0.0, 1.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 flare(vec2 uv) {
  if (uFlare <= 0.0) return vec3(0.0);
  vec2 c = vec2(0.5);
  vec2 axis = uSunUV - c;
  vec3 acc = vec3(0.0);
  vec2 aspect = vec2(uAspect, 1.0);
  // Glare / starburst around the sun
  vec2 d = (uv - uSunUV) * aspect;
  float r = length(d);
  float ang = atan(d.y, d.x);
  float streaks = pow(abs(cos(ang * 3.0)), 60.0) + pow(abs(cos(ang * 3.0 + 1.0472)), 90.0) * 0.6;
  acc += uFlareTint * (0.02 / (r * r * 60.0 + 0.02)) * 0.35;
  acc += uFlareTint * streaks * exp(-r * 9.0) * 0.5;
  acc += vec3(1.0, 0.9, 0.8) * smoothstep(0.14, 0.12, abs(r - 0.28)) * 0.012;
  // Ghosts along the flare axis
  const int N = 6;
  float ks[6] = float[6](-0.45, -0.22, 0.35, 0.62, -0.95, 1.35);
  float sz[6] = float[6](0.05, 0.028, 0.09, 0.035, 0.16, 0.06);
  vec3 col[6] = vec3[6](vec3(0.4, 0.8, 1.0), vec3(1.0, 0.6, 0.3), vec3(0.5, 1.0, 0.6), vec3(1.0, 0.4, 0.8), vec3(0.3, 0.5, 1.0), vec3(1.0, 0.85, 0.5));
  for (int i = 0; i < N; i++) {
    vec2 gp = c + axis * ks[i];
    float gr = length((uv - gp) * aspect);
    float g = smoothstep(sz[i], sz[i] * 0.6, gr) * 0.05 + smoothstep(sz[i] * 1.05, sz[i], gr) * smoothstep(sz[i] * 0.85, sz[i], gr) * 0.05;
    acc += col[i] * g;
  }
  return acc * uFlare;
}

void main() {
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  float r2 = dot(dc, dc);
  vec3 col;
  if (uAberration > 0.0) {
    vec2 off = dc * uAberration * r2;
    col.r = texture2D(tHDR, uv - off).r;
    col.g = texture2D(tHDR, uv).g;
    col.b = texture2D(tHDR, uv + off).b;
  } else {
    col = texture2D(tHDR, uv).rgb;
  }
  col = max(col, vec3(0.0));
  col *= uExposure;
  col += flare(uv);
  col = acesFitted(col);
  // Grade: contrast around mid-grey, saturation
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = clamp((col - 0.18) * uContrast + 0.18, 0.0, 1.0);
  // Vignette
  float vig = 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 1.9);
  col *= vig;
  vec3 srgb = linearToSrgb(col);
  // Film grain + dithering (applied in display space)
  float n = hash(uv * vec2(1920.0, 1080.0) + fract(uTime * 13.7) * 311.0) - 0.5;
  srgb += n * uGrain + (hash(uv * 4096.0 + uTime) - 0.5) / 255.0;
  srgb *= uFade;
  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;

const quadVert = glsl`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export interface PostSettings {
  bloom: boolean;
  bloomStrength: number;
  fxaa: boolean;
  atmosphereSteps: number;
  grain: number;
  vignette: number;
  aberration: number;
}

export interface CompositeFrame {
  exposure: number;
  sunUV: Vector2;
  sunOnScreen: boolean;
  flare: number;
  flareTint: Vector3;
  time: number;
  fade: number;
}

export class PostFX {
  readonly renderer: WebGLRenderer;
  readonly sceneRT: WebGLRenderTarget;
  private readonly rtA: WebGLRenderTarget;
  private readonly ldrRT: WebGLRenderTarget;
  /** Reduced-resolution ray-march target (scattered light + cloud occlusion). */
  private readonly atmRT: WebGLRenderTarget;
  /** Transparent effects layer (rgb premultiplied colour, a = coverage), depth-tested against the scene. */
  private readonly transRT: WebGLRenderTarget;
  private atmScale = 2;
  readonly atmosphere: AtmospherePass;
  private readonly bloom: UnrealBloomPass;
  private readonly composite: ShaderMaterial;
  private readonly fxaa: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  readonly settings: PostSettings = {
    bloom: true,
    bloomStrength: 0.45,
    fxaa: true,
    atmosphereSteps: 24,
    grain: 0.025,
    vignette: 0.28,
    aberration: 0.004,
  };
  private width = 1;
  private height = 1;
  /** Depth encoding of the scene target (must match the renderer's). */
  private readonly reversedDepth: boolean;

  constructor(renderer: WebGLRenderer, luts: AtmosphereLUTs, clouds: import('three').Texture | null) {
    this.reversedDepth = renderer.capabilities.reversedDepthBuffer && renderer.state.buffers.depth.getReversed();
    this.renderer = renderer;
    const depthTexture = new DepthTexture(1, 1, FloatType);
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    this.sceneRT = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    this.rtA = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
    this.ldrRT = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
    this.atmRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
    this.transRT = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      depthTexture: this.sceneRT.depthTexture,
    });
    this.ldrRT.texture.colorSpace = NoColorSpace;
    this.atmosphere = new AtmospherePass(luts, clouds);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.45, 0.6, 10);
    // Replace the bloom's bright-pass with a soft-capped one: only the energy above
    // the threshold blooms, and it saturates at uMaxLum. Without the cap the Sun
    // (tens of thousands of times brighter than the sky) floods half the screen.
    const hp = this.bloom.materialHighPassFilter;
    hp.uniforms.uMaxLum = { value: 40 };
    hp.fragmentShader = glsl`
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float uMaxLum;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float v = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float excess = max(v - luminosityThreshold, 0.0);
  float capped = uMaxLum * (1.0 - exp(-excess / uMaxLum));
  gl_FragColor = vec4(c * (capped / max(v, 1e-4)), 1.0);
}
`;
    hp.needsUpdate = true;
    this.composite = new ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: compositeFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tHDR: { value: null },
        tDepth: { value: null },
        uExposure: { value: 1 },
        uSunUV: { value: new Vector2(0.5, 0.5) },
        uSunOnScreen: { value: 0 },
        uFlare: { value: 0 },
        uFlareTint: { value: new Vector3(1, 0.95, 0.85) },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uVignette: { value: 0.28 },
        uGrain: { value: 0.025 },
        uAberration: { value: 0.004 },
        uSaturation: { value: 1.06 },
        uContrast: { value: 1.04 },
        uFade: { value: 1 },
      },
    });
    this.fxaa = new ShaderMaterial({
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.composite);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneRT.setSize(this.width, this.height);
    this.rtA.setSize(this.width, this.height);
    this.ldrRT.setSize(this.width, this.height);
    this.transRT.setSize(this.width, this.height);
    this.resizeAtm();
    this.bloom.setSize(this.width, this.height);
    (this.fxaa.uniforms.resolution!.value as Vector2).set(1 / this.width, 1 / this.height);
    this.composite.uniforms.uAspect!.value = this.width / this.height;
  }

  /** Ray-march resolution divisor: 1 = full resolution (ultra), 2 = half. */
  setAtmosphereScale(scale: 1 | 2): void {
    if (scale === this.atmScale) return;
    this.atmScale = scale;
    this.resizeAtm();
  }

  private resizeAtm(): void {
    this.atmRT.setSize(Math.ceil(this.width / this.atmScale), Math.ceil(this.height / this.atmScale));
  }

  /** Render the full frame to the screen (or current target when toScreen=false). */
  render(scene: Scene, camera: PerspectiveCamera, atm: AtmosphereFrame, comp: CompositeFrame): void {
    const r = this.renderer;
    const s = this.settings;
    // 1. Opaque scene (layer 0)
    camera.layers.set(0);
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    // 2. Atmosphere: ray march at reduced resolution, then upsample over the scene
    const scale = this.atmScale;
    this.atmosphere.update(atm, camera, this.reversedDepth, this.width, this.height, scale);
    const au = this.atmosphere.material.uniforms;
    au.tDepth!.value = this.sceneRT.depthTexture;
    au.uSteps!.value = s.atmosphereSteps;
    this.quad.material = this.atmosphere.material;
    r.setRenderTarget(this.atmRT);
    this.quad.render(r);

    // 3. Transparent effects (layer 1) into their own buffer, depth-tested against the
    //    opaque scene; effect shaders fade towards the air light stored in atmRT.
    const eu = EFFECT_UNIFORMS;
    eu.tAtm.value = this.atmRT.texture;
    eu.uAtmFullSize.value.set(this.width, this.height);
    eu.uAtmScale.value = scale;
    eu.uFogDensity.value = atm.enabled ? Math.exp(-Math.max(0, atm.cameraAltitude) / 8000) / 40000 : 0;
    camera.layers.set(LAYER_TRANSPARENT);
    const autoShadow = r.shadowMap.autoUpdate;
    const background = scene.background;
    r.shadowMap.autoUpdate = false;
    scene.background = null; // already in the opaque pass; here it would cover everything
    r.setRenderTarget(this.transRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(scene, camera);
    r.setClearColor(0x000000, 1);
    scene.background = background;
    r.shadowMap.autoUpdate = autoShadow;
    camera.layers.set(0);

    const cu0 = this.atmosphere.combine.uniforms;
    cu0.tScene!.value = this.sceneRT.texture;
    cu0.tDepth!.value = this.sceneRT.depthTexture;
    cu0.tAtm!.value = this.atmRT.texture;
    cu0.tTrans!.value = this.transRT.texture;
    this.quad.material = this.atmosphere.combine;
    r.setRenderTarget(this.rtA);
    this.quad.render(r);

    // 4. Bloom (adds into rtA)
    if (s.bloom) {
      this.bloom.strength = s.bloomStrength;
      this.bloom.render(r, this.rtA, this.rtA, 0, false);
    }

    // 5. Composite
    const cu = this.composite.uniforms;
    cu.tHDR!.value = this.rtA.texture;
    cu.tDepth!.value = this.sceneRT.depthTexture;
    cu.uExposure!.value = comp.exposure;
    (cu.uSunUV!.value as Vector2).copy(comp.sunUV);
    cu.uSunOnScreen!.value = comp.sunOnScreen ? 1 : 0;
    cu.uFlare!.value = comp.flare;
    (cu.uFlareTint!.value as Vector3).copy(comp.flareTint);
    cu.uTime!.value = comp.time;
    cu.uGrain!.value = s.grain;
    cu.uVignette!.value = s.vignette;
    cu.uAberration!.value = s.aberration;
    cu.uFade!.value = comp.fade;
    this.quad.material = this.composite;
    if (s.fxaa) {
      r.setRenderTarget(this.ldrRT);
      this.quad.render(r);
      this.fxaa.uniforms.tDiffuse!.value = this.ldrRT.texture;
      this.quad.material = this.fxaa;
      r.setRenderTarget(null);
      this.quad.render(r);
    } else {
      r.setRenderTarget(null);
      this.quad.render(r);
    }
  }

  /** Read the depth at a UV to test sun occlusion — done CPU-side via raycast instead. */
  dispose(): void {
    this.sceneRT.dispose();
    this.rtA.dispose();
    this.ldrRT.dispose();
    this.bloom.dispose();
    this.composite.dispose();
    this.fxaa.dispose();
    this.atmRT.dispose();
    this.transRT.dispose();
    this.atmosphere.dispose();
    this.quad.dispose();
  }
}
