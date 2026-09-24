/**
 * LEARNING NOTE: Rocket exhaust plumes
 *
 * A plume's look is set by chemistry and by the pressure of the surrounding air:
 *
 *  • At sea level the exhaust leaves the nozzle close to ambient pressure; the
 *    flow repeatedly over- and under-expands, forming standing shock waves —
 *    "Mach diamonds" — along a tight, bright column.
 *  • Climbing, ambient pressure drops and the jet balloons outward; in vacuum it
 *    becomes a huge, faint cone.
 *  • Kerosene burns sooty yellow-orange, hydrogen is almost invisible (pale blue,
 *    diamonds visible), methane burns blue-violet, solid motors are blinding white
 *    with thick smoke, hypergolics a faint orange-pink.
 *
 * We draw each plume as a cylinder whose radius is widened in the VERTEX shader
 * (so one mesh serves all altitudes). The fragment shader combines a hot core, a
 * view-dependent thickness term (a cylinder looks denser through its middle), Mach
 * diamonds, scrolling noise for turbulence, and a colour ramp — rendered with
 * ADDITIVE blending because hot gas emits light rather than blocking it.
 *
 * Key concepts: additive blending, vertex displacement, procedural animation,
 * shock diamonds, HDR emissive colours
 */
import { AddEquation, CustomBlending, CylinderGeometry, DoubleSide, Mesh, OneFactor, ShaderMaterial, Vector3, ZeroFactor } from 'three';
import type { PlumeStyle } from '../../parts/PartCatalog';
import { NOISE, glsl } from '../shaders/chunks';
import { EFFECT_FOG_GLSL, EFFECT_UNIFORMS, LAYER_TRANSPARENT } from '../post/SharedUniforms';

interface PlumeLook {
  core: [number, number, number];
  mid: [number, number, number];
  tail: [number, number, number];
  diamonds: [number, number, number];
  brightness: number;
  length: number;
  opacity: number;
}

const LOOKS: Record<PlumeStyle, PlumeLook> = {
  kerolox: { core: [1.0, 0.88, 0.6], mid: [1.0, 0.5, 0.16], tail: [0.8, 0.22, 0.05], diamonds: [1.0, 0.8, 0.5], brightness: 10, length: 11, opacity: 1 },
  hydrolox: { core: [0.8, 0.86, 1.0], mid: [0.55, 0.6, 1.0], tail: [0.35, 0.25, 0.6], diamonds: [1.0, 0.6, 0.85], brightness: 4, length: 8, opacity: 0.55 },
  methalox: { core: [0.7, 0.72, 1.0], mid: [0.42, 0.34, 1.0], tail: [0.55, 0.25, 0.6], diamonds: [1.0, 0.55, 0.45], brightness: 7, length: 10, opacity: 0.85 },
  solid: { core: [1.0, 0.95, 0.82], mid: [1.0, 0.66, 0.3], tail: [0.9, 0.4, 0.12], diamonds: [1.0, 0.9, 0.7], brightness: 20, length: 13, opacity: 1 },
  hypergolic: { core: [1.0, 0.7, 0.55], mid: [0.95, 0.45, 0.35], tail: [0.6, 0.2, 0.2], diamonds: [1.0, 0.6, 0.5], brightness: 3.5, length: 7, opacity: 0.6 },
};

const vert = glsl`
uniform float uLength;
uniform float uRadius;
uniform float uExpand;
varying float vS;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec2 vUv2;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  // Base cylinder: y ∈ [0, -1] along the plume axis, radius 1
  float s = -position.y;
  vS = s;
  vUv2 = uv;
  float widen = 1.0 + uExpand * pow(s, 0.7) + 0.12 * s;
  vec3 p = vec3(position.x * uRadius * widen, -s * uLength, position.z * uRadius * widen);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * vec3(position.x, 0.0, position.z));
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const frag = glsl`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uTail;
uniform vec3 uDiamonds;
uniform float uBrightness;
uniform float uThrottle;
uniform float uTime;
uniform float uDiamondStrength;
uniform float uVacuum;
uniform float uOpacity;
uniform float uSeed;
varying float vS;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec2 vUv2;
${NOISE}
${EFFECT_FOG_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(-vViewPos);
  float ndv = abs(dot(normalize(vNormalV), V));
  float thick = pow(ndv, 1.3);
  // Projected distance of this pixel from the plume axis (0 centre, 1 edge)
  float rho = sqrt(max(0.0, 1.0 - ndv * ndv));
  float s = vS;
  // Axial envelope: bright near the exit, fading along the plume
  float env = pow(max(0.0, 1.0 - s), mix(1.6, 3.0, uVacuum)) * smoothstep(0.0, 0.04, s + 0.02);
  float core = exp(-s * mix(6.0, 2.5, uVacuum)) * pow(thick, 3.0);
  // Mach diamonds (sea level): shock cells whose bright core narrows to a point at
  // each shock node — diamond-shaped, on the axis, fading downstream
  float cell = fract(s * 6.5 + 0.35);
  float width = 0.42 * (1.0 - abs(2.0 * cell - 1.0));
  float dia = (1.0 - smoothstep(width * 0.55, width, rho)) * exp(-s * 3.2) * uDiamondStrength;
  // Turbulence
  float n = apgFbm(vec3(vUv2.x * 6.0 + uSeed, s * 7.0 - uTime * 9.0, uTime * 0.7), 4);
  float turb = mix(0.55, 1.35, n);
  vec3 ramp = mix(uCore, uMid, smoothstep(0.02, 0.35, s));
  ramp = mix(ramp, uTail, smoothstep(0.35, 1.0, s));
  vec3 col = ramp * (0.35 * env * thick * turb + 1.8 * core) + uDiamonds * dia * 2.5;
  float vac = mix(1.0, 0.25, uVacuum);
  col *= uBrightness * uThrottle * vac * uOpacity;
  vec3 air;
  float fog = effectFog(length(vViewPos), air);
  // Emitted light: add colour, leave the coverage channel untouched
  gl_FragColor = vec4(col * (1.0 - fog), 0.0);
}
`;

let sharedGeo: CylinderGeometry | null = null;
function plumeGeometry(): CylinderGeometry {
  if (!sharedGeo) {
    // radius 1, height 1, from y=0 down to y=-1, open ended, many length segments
    sharedGeo = new CylinderGeometry(1, 1, 1, 28, 24, true);
    sharedGeo.translate(0, -0.5, 0);
  }
  return sharedGeo;
}

export class Plume {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly look: PlumeLook;
  readonly exitRadius: number;
  /** Current visual length (m) — for smoke emission. */
  length = 0;

  constructor(style: PlumeStyle, exitRadius: number, seed: number) {
    this.look = LOOKS[style];
    this.exitRadius = exitRadius;
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      side: DoubleSide,
      uniforms: {
        ...EFFECT_UNIFORMS,
        uLength: { value: 10 },
        uRadius: { value: exitRadius * 0.95 },
        uExpand: { value: 0.3 },
        uCore: { value: new Vector3(...this.look.core) },
        uMid: { value: new Vector3(...this.look.mid) },
        uTail: { value: new Vector3(...this.look.tail) },
        uDiamonds: { value: new Vector3(...this.look.diamonds) },
        uBrightness: { value: this.look.brightness },
        uThrottle: { value: 0 },
        uTime: { value: 0 },
        uDiamondStrength: { value: 1 },
        uVacuum: { value: 0 },
        uOpacity: { value: this.look.opacity },
        uSeed: { value: seed * 13.37 },
      },
    });
    this.mesh = new Mesh(plumeGeometry(), this.mat);
    this.mesh.layers.set(LAYER_TRANSPARENT);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  /**
   * @param throttle 0..1 current engine output
   * @param pressureRatio ambient / sea-level pressure (0 in vacuum)
   */
  update(throttle: number, pressureRatio: number, time: number): void {
    const u = this.mat.uniforms;
    const on = throttle > 0.01;
    this.mesh.visible = on;
    if (!on) {
      this.length = 0;
      return;
    }
    const p = Math.max(0, Math.min(1, pressureRatio));
    const vac = 1 - Math.pow(p, 0.35);
    // Expansion grows enormously as ambient pressure → 0
    const expand = 0.25 + 9 * vac * vac;
    const len = this.exitRadius * 2 * this.look.length * (0.55 + 0.45 * throttle) * (1 + 1.8 * vac);
    this.length = len;
    u.uLength!.value = len;
    u.uExpand!.value = expand;
    u.uThrottle!.value = 0.35 + 0.65 * throttle;
    u.uTime!.value = time;
    u.uDiamondStrength!.value = Math.max(0, 1 - vac * 2.5);
    u.uVacuum!.value = vac;
  }

  dispose(): void {
    this.mat.dispose();
  }
}
