/**
 * LEARNING NOTE: Image-based lighting from a procedural sky
 *
 * Metals have no diffuse colour — they only REFLECT their surroundings. Without an
 * environment map a steel tank renders black. We render a tiny cube map (six 64×64
 * views) of an analytic environment around the vessel — sky gradient from the
 * atmosphere model, the planet below as a bright disc filling the right angle for
 * the current altitude, and black space above — then pre-filter it with PMREM
 * (Prefiltered, Mipmapped Radiance Environment Map) so rough surfaces sample
 * blurrier mips. On the pad the rocket reflects blue sky; in orbit it reflects
 * the Earth below and black space above.
 *
 * Key concepts: image-based lighting (IBL), cube maps, PMREM, roughness-dependent
 * blurring, analytic environments
 */
import {
  BackSide,
  CubeCamera,
  HalfFloatType,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLCubeRenderTarget,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { glsl } from './shaders/chunks';

const frag = glsl`
uniform vec3 uUp;
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uGround;
uniform vec3 uSun;
uniform float uHorizonCos;
uniform float uSpace;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float mu = dot(d, uUp);
  vec3 col;
  if (mu < uHorizonCos) {
    // Planet: brighter toward the sub-solar side
    float lit = clamp(dot(uSunDir, uUp) * 0.5 + 0.6, 0.0, 1.0);
    col = uGround * lit;
    col = mix(uSkyHorizon, col, smoothstep(uHorizonCos, uHorizonCos - 0.08, mu));
  } else {
    float t = clamp((mu - uHorizonCos) / (1.0 - uHorizonCos), 0.0, 1.0);
    col = mix(uSkyHorizon, uSkyZenith, pow(t, 0.45));
    col *= 1.0 - uSpace * smoothstep(0.0, 0.3, t);
  }
  float s = max(0.0, dot(d, uSunDir));
  col += uSun * (pow(s, 900.0) * 40.0 + pow(s, 12.0) * 0.08 * (1.0 - uSpace));
  gl_FragColor = vec4(col, 1.0);
}
`;

const vert = glsl`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export interface EnvParams {
  up: Vector3;
  sunDir: Vector3;
  skyZenith: Vector3;
  skyHorizon: Vector3;
  ground: Vector3;
  sun: Vector3;
  /** cos of the angle from zenith at which the planet's limb sits (−1 = flat ground at infinity…). */
  horizonCos: number;
  /** 0 on the ground, 1 in space (black sky). */
  space: number;
}

export class EnvironmentProbe {
  private readonly scene = new Scene();
  private readonly mat: ShaderMaterial;
  private readonly cubeRT: WebGLCubeRenderTarget;
  private readonly cubeCam: CubeCamera;
  private readonly pmrem: PMREMGenerator;
  private pmremRT: WebGLRenderTarget | null = null;
  private timer = 0;

  constructor(private readonly renderer: WebGLRenderer) {
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      side: BackSide,
      depthWrite: false,
      // A skybox needs no depth test — and with autoClear off the cube target's
      // depth is never cleared in the logarithmic-depth fallback, which would
      // reject every sky pixel and leave the environment map black
      depthTest: false,
      uniforms: {
        uUp: { value: new Vector3(0, 1, 0) },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSkyZenith: { value: new Vector3(0.1, 0.2, 0.5) },
        uSkyHorizon: { value: new Vector3(0.5, 0.6, 0.8) },
        uGround: { value: new Vector3(0.1, 0.1, 0.1) },
        uSun: { value: new Vector3(1, 1, 1) },
        uHorizonCos: { value: 0 },
        uSpace: { value: 0 },
      },
    });
    this.scene.add(new Mesh(new SphereGeometry(10, 32, 16), this.mat));
    this.cubeRT = new WebGLCubeRenderTarget(64, { type: HalfFloatType, generateMipmaps: false });
    this.cubeCam = new CubeCamera(0.1, 100, this.cubeRT);
    this.pmrem = new PMREMGenerator(renderer);
  }

  /**
   * Advance the refresh timer; true when the probe wants re-rendering (at most
   * every `interval` seconds, and always until the first render has happened).
   * Callers compute the (allocation-heavy) environment parameters only then.
   */
  due(dt: number, interval = 0.4): boolean {
    this.timer -= dt;
    if (this.timer > 0 && this.pmremRT) return false;
    this.timer = interval;
    return true;
  }

  /** Re-render at most every `interval` seconds. Returns the current env texture. */
  update(p: EnvParams, dt: number, interval = 0.4): Texture | null {
    if (!this.due(dt, interval)) return this.pmremRT ? this.pmremRT.texture : null;
    return this.render(p);
  }

  /** Render the six faces and pre-filter them now. */
  render(p: EnvParams): Texture {
    const u = this.mat.uniforms;
    (u.uUp!.value as Vector3).copy(p.up);
    (u.uSunDir!.value as Vector3).copy(p.sunDir);
    (u.uSkyZenith!.value as Vector3).copy(p.skyZenith);
    (u.uSkyHorizon!.value as Vector3).copy(p.skyHorizon);
    (u.uGround!.value as Vector3).copy(p.ground);
    (u.uSun!.value as Vector3).copy(p.sun);
    u.uHorizonCos!.value = p.horizonCos;
    u.uSpace!.value = p.space;
    const prevTarget = this.renderer.getRenderTarget();
    this.cubeCam.update(this.renderer, this.scene);
    const next = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT ?? undefined);
    this.pmremRT = next;
    this.renderer.setRenderTarget(prevTarget);
    return next.texture;
  }

  get texture(): Texture | null {
    return this.pmremRT ? this.pmremRT.texture : null;
  }

  dispose(): void {
    this.cubeRT.dispose();
    this.pmremRT?.dispose();
    this.pmrem.dispose();
    this.mat.dispose();
  }
}
