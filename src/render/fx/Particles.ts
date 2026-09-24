/**
 * LEARNING NOTE: Particle systems at planetary scale
 *
 * Smoke, steam, sparks and fireballs are thousands of small textured quads
 * ("billboards") that always face the camera. We draw ALL of them in a single draw
 * call with GPU instancing: one quad geometry + per-instance attributes (position,
 * size, colour, opacity).
 *
 * Particles are simulated on the CPU in 64-bit coordinates in the ROTATING frame of
 * the nearest planet — a smoke puff left at the launch pad must stay put (and drift
 * with the wind) while the Earth spins at 465 m/s and orbits the Sun at 30 km/s.
 * Drag therefore slows particles relative to the air, not relative to the Sun.
 * Each frame we rotate into the inertial frame, subtract the camera position
 * (floating origin) and upload small float32 offsets. Semi-transparent smoke must be drawn back-to-front, so we sort by
 * distance every frame (a few thousand floats — cheap).
 *
 * Smoke is lit like a soft sphere: a wrapped Lambert term toward the Sun, sky
 * ambient, and an emissive term for fire and for smoke lit by the plume at night.
 *
 * Key concepts: billboarding, instanced rendering, CPU particle simulation,
 * back-to-front sorting, soft lighting of volumes
 */
import {
  AddEquation,
  Color,
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  OneFactor,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  ZeroFactor,
} from 'three';
import type { CelestialBody } from '../../physics/CelestialBody';
import { glsl } from '../shaders/chunks';
import { EFFECT_FOG_GLSL, EFFECT_UNIFORMS, LAYER_TRANSPARENT } from '../post/SharedUniforms';

export type ParticleKind = 'smoke' | 'steam' | 'fire' | 'spark' | 'plasma' | 'dust';

const vert = glsl`
attribute vec3 iOffset;
attribute vec4 iColor;
attribute vec3 iParams; // size, rotation, emissive
varying vec2 vUv;
varying vec4 vColor;
varying float vEmissive;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vColor = iColor;
  vEmissive = iParams.z;
  float c = cos(iParams.y);
  float s = sin(iParams.y);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iParams.x;
  vec4 mv = viewMatrix * vec4(iOffset, 1.0);
  mv.xy += q;
  vView = mv.xyz;
  // Camera-space right/up in world space for lighting
  vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const frag = glsl`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uAdditive;
${EFFECT_FOG_GLSL}
varying vec2 vUv;
varying vec4 vColor;
varying float vEmissive;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vView;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  vec3 air;
  float fog = effectFog(length(vView), air);
  if (uAdditive > 0.5) {
    // Emitted light: adds colour, leaves coverage (alpha) untouched
    float a = exp(-r2 * 3.5);
    gl_FragColor = vec4(vColor.rgb * a * vColor.a * vEmissive * (1.0 - fog), 0.0);
    return;
  }
  // Billowy edge: noise erodes the disc
  float n = n2(vUv * 5.0 + vColor.a * 3.0) * 0.6 + n2(vUv * 11.0) * 0.4;
  float a = smoothstep(1.0, 0.25, r2 + (n - 0.5) * 0.7) * vColor.a;
  if (a < 0.003) discard;
  // Sphere-impostor normal for soft lighting
  vec3 N = normalize(vRight * p.x + vUp * p.y + normalize(-vView) * sqrt(max(0.0, 1.0 - r2)));
  // Wrapped diffuse (light scatters through the puff) + sky irradiance, both /π like
  // any Lambertian surface, so smoke matches the brightness of sunlit paint.
  float wrap = clamp((dot(N, uSunDir) + 0.6) / 1.6, 0.0, 1.0);
  float thick = 0.55 + 0.45 * n;
  vec3 lit = vColor.rgb * (uSunColor * wrap * thick + uAmbient) / 3.14159265 + vColor.rgb * vEmissive;
  lit = mix(lit, air, fog);
  gl_FragColor = vec4(lit * a, a);
}
`;

const MAX = 9000;
const _rel = new Vector3();
const _vel = new Vector3();
const _up = new Vector3();
const _tmp = new Vector3();
const _cam = new Vector3();
const _rot = new Quaternion();

export interface SpawnSpec {
  kind: ParticleKind;
  /** Absolute position (heliocentric metres). */
  pos: Vector3;
  vel: Vector3;
  life: number;
  size0: number;
  size1: number;
  color: Color;
  alpha: number;
  emissive: number;
  /** Linear drag rate (1/s). */
  drag: number;
  /** Upward buoyancy acceleration (m/s²) along `up`. */
  buoyancy: number;
  up: Vector3;
}

export class ParticleSystem {
  readonly smokeMesh: Mesh;
  readonly glowMesh: Mesh;
  private readonly smokeMat: ShaderMaterial;
  private readonly glowMat: ShaderMaterial;
  // Simulation state
  private readonly px = new Float64Array(MAX);
  private readonly py = new Float64Array(MAX);
  private readonly pz = new Float64Array(MAX);
  private readonly vx = new Float32Array(MAX);
  private readonly vy = new Float32Array(MAX);
  private readonly vz = new Float32Array(MAX);
  private readonly ux = new Float32Array(MAX);
  private readonly uy = new Float32Array(MAX);
  private readonly uz = new Float32Array(MAX);
  private readonly age = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly s0 = new Float32Array(MAX);
  private readonly s1 = new Float32Array(MAX);
  private readonly rot = new Float32Array(MAX);
  private readonly rotV = new Float32Array(MAX);
  private readonly cr = new Float32Array(MAX);
  private readonly cg = new Float32Array(MAX);
  private readonly cb = new Float32Array(MAX);
  private readonly a0 = new Float32Array(MAX);
  private readonly em = new Float32Array(MAX);
  private readonly drag = new Float32Array(MAX);
  private readonly buoy = new Float32Array(MAX);
  private readonly additive = new Uint8Array(MAX);
  private readonly alive = new Uint8Array(MAX);
  private readonly free: number[] = [];
  private readonly order = new Uint32Array(MAX);
  private readonly depth = new Float32Array(MAX);
  // GPU buffers
  private readonly smokeOffset: InstancedBufferAttribute;
  private readonly smokeColor: InstancedBufferAttribute;
  private readonly smokeParams: InstancedBufferAttribute;
  private readonly glowOffset: InstancedBufferAttribute;
  private readonly glowColor: InstancedBufferAttribute;
  private readonly glowParams: InstancedBufferAttribute;
  count = 0;
  /** Body whose rotating frame the particles live in. */
  frame: CelestialBody | null = null;

  constructor() {
    for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    const mk = (additive: boolean) => {
      const g = new InstancedBufferGeometry();
      const base = new PlaneGeometry(1, 1);
      g.index = base.index;
      g.setAttribute('position', base.getAttribute('position'));
      g.setAttribute('uv', base.getAttribute('uv'));
      const off = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      const col = new InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
      const par = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      off.setUsage(DynamicDrawUsage);
      col.setUsage(DynamicDrawUsage);
      par.setUsage(DynamicDrawUsage);
      g.setAttribute('iOffset', off);
      g.setAttribute('iColor', col);
      g.setAttribute('iParams', par);
      g.instanceCount = 0;
      const mat = new ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: additive ? CustomBlending : NormalBlending,
        blendEquation: AddEquation,
        blendSrc: OneFactor,
        blendDst: OneFactor,
        blendSrcAlpha: ZeroFactor,
        blendDstAlpha: OneFactor,
        premultipliedAlpha: true,
        uniforms: {
          ...EFFECT_UNIFORMS,
          uSunDir: { value: new Vector3(0, 1, 0) },
          uSunColor: { value: new Vector3(1, 1, 1) },
          uAmbient: { value: new Vector3(0.1, 0.12, 0.15) },
          uAdditive: { value: additive ? 1 : 0 },
        },
      });
      const mesh = new Mesh(g, mat);
      mesh.layers.set(LAYER_TRANSPARENT);
      mesh.frustumCulled = false;
      mesh.renderOrder = additive ? 12 : 11;
      return { mesh, mat, off, col, par };
    };
    const a = mk(false);
    const b = mk(true);
    this.smokeMesh = a.mesh;
    this.smokeMat = a.mat;
    this.smokeOffset = a.off;
    this.smokeColor = a.col;
    this.smokeParams = a.par;
    this.glowMesh = b.mesh;
    this.glowMat = b.mat;
    this.glowOffset = b.off;
    this.glowColor = b.col;
    this.glowParams = b.par;
  }

  /** Switch reference body (clears particles). */
  setFrame(body: CelestialBody): void {
    if (this.frame === body) return;
    this.clear();
    this.frame = body;
  }

  /**
   * Spawn from ABSOLUTE position & velocity; converted into the frame body's
   * rotating (body-fixed) coordinates.
   */
  spawn(s: SpawnSpec): void {
    const b = this.frame;
    if (!b) return;
    let i = this.free.pop();
    if (i === undefined) {
      // Pool exhausted: overwrite a random slot
      i = Math.floor(Math.random() * MAX);
    }
    _rel.copy(s.pos).sub(b.position);
    // velocity relative to the co-rotating surface/air
    _vel.copy(s.vel).sub(b.velocity);
    _tmp.crossVectors(b.angularVelocity, _rel);
    _vel.sub(_tmp);
    _rel.applyQuaternion(b.rotationInverse);
    _vel.applyQuaternion(b.rotationInverse);
    _up.copy(s.up).applyQuaternion(b.rotationInverse);
    this.px[i] = _rel.x;
    this.py[i] = _rel.y;
    this.pz[i] = _rel.z;
    this.vx[i] = _vel.x;
    this.vy[i] = _vel.y;
    this.vz[i] = _vel.z;
    this.ux[i] = _up.x;
    this.uy[i] = _up.y;
    this.uz[i] = _up.z;
    this.age[i] = 0;
    this.life[i] = s.life;
    this.s0[i] = s.size0;
    this.s1[i] = s.size1;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotV[i] = (Math.random() - 0.5) * 0.6;
    this.cr[i] = s.color.r;
    this.cg[i] = s.color.g;
    this.cb[i] = s.color.b;
    this.a0[i] = s.alpha;
    this.em[i] = s.emissive;
    this.drag[i] = s.drag;
    this.buoy[i] = s.buoyancy;
    this.additive[i] = s.kind === 'spark' || s.kind === 'plasma' || s.kind === 'fire' ? 1 : 0;
    if (!this.alive[i]) this.alive[i] = 1;
  }

  /** Advance by dt seconds and rebuild GPU buffers relative to the camera. */
  update(dt: number, camAbs: Vector3, sunDir: Vector3, sunColor: Vector3, ambient: Vector3): void {
    let n = 0;
    const b = this.frame;
    if (!b) return;
    // Camera in body-fixed coordinates, so sorting/offsets can be done per particle
    _cam.copy(camAbs).sub(b.position).applyQuaternion(b.rotationInverse);
    _rot.copy(b.rotation);
    for (let i = 0; i < MAX; i++) {
      if (!this.alive[i]) continue;
      const age = (this.age[i] += dt);
      if (age >= this.life[i]!) {
        this.alive[i] = 0;
        this.free.push(i);
        continue;
      }
      const k = Math.exp(-this.drag[i]! * dt);
      this.vx[i] = this.vx[i]! * k + this.ux[i]! * this.buoy[i]! * dt;
      this.vy[i] = this.vy[i]! * k + this.uy[i]! * this.buoy[i]! * dt;
      this.vz[i] = this.vz[i]! * k + this.uz[i]! * this.buoy[i]! * dt;
      this.px[i] = this.px[i]! + this.vx[i]! * dt;
      this.py[i] = this.py[i]! + this.vy[i]! * dt;
      this.pz[i] = this.pz[i]! + this.vz[i]! * dt;
      this.rot[i] = this.rot[i]! + this.rotV[i]! * dt;
      const dx = this.px[i]! - _cam.x;
      const dy = this.py[i]! - _cam.y;
      const dz = this.pz[i]! - _cam.z;
      this.depth[i] = dx * dx + dy * dy + dz * dz;
      this.order[n++] = i;
    }
    this.count = n;
    // Sort far → near
    const ord = this.order.subarray(0, n);
    const depth = this.depth;
    ord.sort((a, b) => depth[b]! - depth[a]!);
    let ns = 0;
    let ng = 0;
    const so = this.smokeOffset.array as Float32Array;
    const sc = this.smokeColor.array as Float32Array;
    const sp = this.smokeParams.array as Float32Array;
    const go = this.glowOffset.array as Float32Array;
    const gc = this.glowColor.array as Float32Array;
    const gp = this.glowParams.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = ord[k]!;
      const t = this.age[i]! / this.life[i]!;
      const size = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * Math.sqrt(t);
      const fadeIn = Math.min(1, this.age[i]! * 20);
      const fadeOut = 1 - t * t;
      const alpha = this.a0[i]! * fadeIn * fadeOut;
      // body-fixed offset from camera → inertial (camera-relative) via the body rotation
      _tmp.set(this.px[i]! - _cam.x, this.py[i]! - _cam.y, this.pz[i]! - _cam.z).applyQuaternion(_rot);
      const dx = _tmp.x;
      const dy = _tmp.y;
      const dz = _tmp.z;
      if (this.additive[i]) {
        go[ng * 3] = dx;
        go[ng * 3 + 1] = dy;
        go[ng * 3 + 2] = dz;
        gc[ng * 4] = this.cr[i]!;
        gc[ng * 4 + 1] = this.cg[i]!;
        gc[ng * 4 + 2] = this.cb[i]!;
        gc[ng * 4 + 3] = alpha;
        gp[ng * 3] = size;
        gp[ng * 3 + 1] = this.rot[i]!;
        gp[ng * 3 + 2] = this.em[i]! * (1 - t);
        ng++;
      } else {
        so[ns * 3] = dx;
        so[ns * 3 + 1] = dy;
        so[ns * 3 + 2] = dz;
        sc[ns * 4] = this.cr[i]!;
        sc[ns * 4 + 1] = this.cg[i]!;
        sc[ns * 4 + 2] = this.cb[i]!;
        sc[ns * 4 + 3] = alpha;
        sp[ns * 3] = size;
        sp[ns * 3 + 1] = this.rot[i]!;
        sp[ns * 3 + 2] = this.em[i]! * Math.max(0, 1 - t * 3);
        ns++;
      }
    }
    const gs = this.smokeMesh.geometry as InstancedBufferGeometry;
    const gg = this.glowMesh.geometry as InstancedBufferGeometry;
    gs.instanceCount = ns;
    gg.instanceCount = ng;
    // Upload only the instances in use — and nothing at all for an empty
    // category: an update range of length 0 means "the whole buffer" to WebGL,
    // which re-uploaded 360 KB per frame for the (usually empty) glow mesh.
    if (ns > 0) {
      this.smokeOffset.needsUpdate = true;
      this.smokeColor.needsUpdate = true;
      this.smokeParams.needsUpdate = true;
      this.smokeOffset.clearUpdateRanges();
      this.smokeOffset.addUpdateRange(0, ns * 3);
      this.smokeColor.clearUpdateRanges();
      this.smokeColor.addUpdateRange(0, ns * 4);
      this.smokeParams.clearUpdateRanges();
      this.smokeParams.addUpdateRange(0, ns * 3);
    }
    if (ng > 0) {
      this.glowOffset.needsUpdate = true;
      this.glowColor.needsUpdate = true;
      this.glowParams.needsUpdate = true;
      this.glowOffset.clearUpdateRanges();
      this.glowOffset.addUpdateRange(0, ng * 3);
      this.glowColor.clearUpdateRanges();
      this.glowColor.addUpdateRange(0, ng * 4);
      this.glowParams.clearUpdateRanges();
      this.glowParams.addUpdateRange(0, ng * 3);
    }
    const su = this.smokeMat.uniforms;
    (su.uSunDir!.value as Vector3).copy(sunDir);
    (su.uSunColor!.value as Vector3).copy(sunColor);
    (su.uAmbient!.value as Vector3).copy(ambient);
  }

  clear(): void {
    for (let i = 0; i < MAX; i++) {
      if (this.alive[i]) {
        this.alive[i] = 0;
        this.free.push(i);
      }
    }
  }

  get activeCount(): number {
    return this.count;
  }

  dispose(): void {
    this.smokeMat.dispose();
    this.glowMat.dispose();
    this.smokeMesh.geometry.dispose();
    this.glowMesh.geometry.dispose();
  }
}
