/**
 * LEARNING NOTE: A real night sky
 *
 * The stars are the actual HYG catalogue (15,600 stars down to magnitude 7) placed
 * at their J2000 right ascension/declination — the constellations are real, and
 * because the game frame is aligned to Earth's equator, Polaris sits over the
 * North Pole and Orion rises in the east.
 *
 * Brightness uses the astronomical MAGNITUDE scale: each magnitude step is a
 * factor 10^0.4 ≈ 2.512 in flux, and smaller numbers are brighter (Sirius −1.4,
 * faintest naked-eye stars ≈ +6). Colour comes from the B−V colour index, which
 * maps to surface temperature (Ballesteros' formula) and then to a blackbody RGB.
 *
 * Stars and the Milky Way are drawn first, without writing depth, so every planet
 * and rocket draws in front — and the atmosphere pass later washes them out in
 * daylight exactly as the real sky does.
 *
 * Key concepts: astronomical magnitudes, colour index, blackbody colour,
 * skyboxes rendered "at infinity", point sprites
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Points,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  BackSide,
} from 'three';
import { EQUIRECT, glsl } from '../shaders/chunks';

/** B−V colour index → temperature (K), Ballesteros 2012. */
export function bvToTemperature(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** Blackbody temperature → linear RGB (normalised so max = 1). */
export function temperatureToRgb(t: number): [number, number, number] {
  const k = t / 100;
  let r: number;
  let g: number;
  let b: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => Math.pow(Math.min(255, Math.max(0, v)) / 255, 2.2);
  const out: [number, number, number] = [c(r), c(g), c(b)];
  const m = Math.max(...out);
  return [out[0] / m, out[1] / m, out[2] / m];
}

const starVert = glsl`
attribute float aMag;
attribute vec3 aColor;
attribute float aSeed;
uniform float uPixelRatio;
uniform float uBrightness;
uniform float uTwinkle;
uniform float uTime;
varying vec3 vColor;
void main() {
  float flux = pow(10.0, -0.4 * aMag);
  float tw = 1.0 + uTwinkle * (sin(uTime * (7.0 + aSeed * 11.0) + aSeed * 40.0) * 0.5 + sin(uTime * 17.3 + aSeed * 93.0) * 0.3);
  vColor = aColor * flux * uBrightness * tw;
  float size = clamp(2.6 - 0.28 * aMag, 1.1, 4.8) * uPixelRatio;
  gl_PointSize = size;
  // Normalise energy so small sprites of faint stars aren't dimmer than intended
  vColor *= 4.0 / (size * size / (uPixelRatio * uPixelRatio));
  vec4 p = projectionMatrix * viewMatrix * vec4(position * 1.0e11, 1.0);
  gl_Position = p;
}
`;

const starFrag = glsl`
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  float a = exp(-r2 * 4.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const mwVert = glsl`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * viewMatrix * vec4(position * 1.0e11, 1.0);
}
`;

const mwFrag = glsl`
uniform sampler2D tMilkyWay;
uniform float uIntensity;
varying vec3 vDir;
${EQUIRECT}
void main() {
  vec3 d = normalize(vDir);
  // Equatorial: RA 0 at u = 0, increasing to the right; Dec +90 at the top
  float ra = atan(-d.z, d.x);
  float u1 = fract(ra / (2.0 * APG_PI));
  float u2 = fract(ra / (2.0 * APG_PI) + 0.5) + 0.5;
  float u = fwidth(u1) <= fwidth(u2) + 1e-6 ? u1 : u2;
  float v = asin(clamp(d.y, -1.0, 1.0)) / APG_PI + 0.5;
  vec3 c = texture2D(tMilkyWay, vec2(u, v)).rgb;
  gl_FragColor = vec4(c * uIntensity, 1.0);
}
`;

export class Sky {
  readonly group = new Group();
  private starMat: ShaderMaterial | null = null;
  private mwMat: ShaderMaterial | null = null;

  constructor() {
    this.group.name = 'sky';
    this.group.renderOrder = -1000;
  }

  setStars(buffer: ArrayBuffer): void {
    const f = new Float32Array(buffer);
    const n = Math.floor(f.length / 5);
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = f[i * 5]!;
      pos[i * 3 + 1] = f[i * 5 + 1]!;
      pos[i * 3 + 2] = f[i * 5 + 2]!;
      mag[i] = f[i * 5 + 3]!;
      const [r, g, b] = temperatureToRgb(bvToTemperature(f[i * 5 + 4]!));
      // Slight desaturation: the eye perceives star colours as pastel
      col[i * 3] = 0.35 + 0.65 * r;
      col[i * 3 + 1] = 0.35 + 0.65 * g;
      col[i * 3 + 2] = 0.35 + 0.65 * b;
      seed[i] = (i * 0.6180339887) % 1;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aMag', new BufferAttribute(mag, 1));
    g.setAttribute('aColor', new BufferAttribute(col, 3));
    g.setAttribute('aSeed', new BufferAttribute(seed, 1));
    this.starMat = new ShaderMaterial({
      vertexShader: starVert,
      fragmentShader: starFrag,
      uniforms: {
        uPixelRatio: { value: 1 },
        uBrightness: { value: 1.6 },
        uTwinkle: { value: 0 },
        uTime: { value: 0 },
      },
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      // NOT transparent: a transparent material goes into three's transparent
      // queue, drawn after every opaque object — with depth testing off the stars
      // would then shine through planets and the rocket. Additive blending still
      // applies in the opaque queue, and renderOrder puts the stars first.
      transparent: false,
    });
    const pts = new Points(g, this.starMat);
    pts.frustumCulled = false;
    pts.renderOrder = -999;
    this.group.add(pts);
  }

  setMilkyWay(tex: Texture): void {
    tex.wrapS = RepeatWrapping;
    this.mwMat = new ShaderMaterial({
      vertexShader: mwVert,
      fragmentShader: mwFrag,
      uniforms: { tMilkyWay: { value: tex }, uIntensity: { value: 0.035 } },
      side: BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const m = new Mesh(new SphereGeometry(1, 64, 32), this.mwMat);
    m.frustumCulled = false;
    m.renderOrder = -1000;
    this.group.add(m);
  }

  update(time: number, pixelRatio: number, twinkle: number, brightness: number): void {
    if (this.starMat) {
      const u = this.starMat.uniforms;
      u.uTime!.value = time;
      u.uPixelRatio!.value = pixelRatio;
      u.uTwinkle!.value = twinkle;
      u.uBrightness!.value = 1.6 * brightness;
    }
    if (this.mwMat) this.mwMat.uniforms.uIntensity!.value = 0.035 * brightness;
  }
}
