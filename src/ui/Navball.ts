/**
 * LEARNING NOTE: The navball (attitude indicator)
 *
 * Pilots read attitude from a ball painted with the sky (blue, upper half), ground
 * (brown) and a grid of pitch/heading lines. The point of the ball under the
 * centre reticle is where the nose points. Orbital-mechanics markers
 * (prograde, retrograde, normal, radial, target, maneuver) sit on the ball at their
 * directions, so "point the nose at the green marker" becomes a matter of
 * steering the reticle onto it.
 *
 * Instead of rotating a textured sphere, the shader computes, for each pixel of a
 * disc, which world direction it represents: s = (x, y, √(1−x²−y²)) in screen
 * axes → d = x·right + y·dorsal + z·nose (the vessel's axes in the local
 * East-North-Up frame) → heading/pitch → texture lookup. This is a mirror mapping
 * (like a real navball, where things to your right appear on the right).
 *
 * Key concepts: attitude indicators, per-pixel ray reconstruction, ENU frames,
 * viewport/scissor rendering
 */
import {
  CanvasTexture,
  LinearFilter,
  Matrix3,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { glsl } from '../render/shaders/chunks';

function drawBallTexture(): CanvasTexture {
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // Sky (top half) and ground (bottom half)
  const sky = g.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#0f3f86');
  sky.addColorStop(1, '#3f8fe0');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H / 2);
  const gr = g.createLinearGradient(0, H / 2, 0, H);
  gr.addColorStop(0, '#b8742f');
  gr.addColorStop(1, '#5a3412');
  g.fillStyle = gr;
  g.fillRect(0, H / 2, W, H / 2);
  // Pitch lines every 10°, labels every 30°
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let p = -80; p <= 80; p += 10) {
    const y = H / 2 - (p / 180) * H;
    g.strokeStyle = p === 0 ? '#ffffff' : 'rgba(255,255,255,0.55)';
    g.lineWidth = p === 0 ? 5 : p % 30 === 0 ? 3 : 1.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    if (p !== 0 && p % 30 === 0) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = 'bold 30px Rajdhani, Inter, sans-serif';
      for (let hdg = 45; hdg < 360; hdg += 90) g.fillText(String(Math.abs(p)), (hdg / 360) * W, y - 18);
    }
  }
  // Heading lines
  for (let hd = 0; hd < 360; hd += 15) {
    const x = (hd / 360) * W;
    g.strokeStyle = hd % 90 === 0 ? 'rgba(255,255,255,0.9)' : hd % 45 === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)';
    g.lineWidth = hd % 90 === 0 ? 4 : 2;
    g.beginPath();
    g.moveTo(x, H * 0.06);
    g.lineTo(x, H * 0.94);
    g.stroke();
    const label = hd === 0 ? 'N' : hd === 90 ? 'E' : hd === 180 ? 'S' : hd === 270 ? 'W' : hd % 45 === 0 ? String(hd) : '';
    if (label) {
      g.font = hd % 90 === 0 ? 'bold 46px Rajdhani, Inter, sans-serif' : 'bold 30px Rajdhani, Inter, sans-serif';
      g.fillStyle = hd % 90 === 0 ? '#ffffff' : 'rgba(255,255,255,0.8)';
      g.fillText(label, x, H / 2 - 30);
      g.fillText(label, x, H / 2 + 34);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.wrapS = RepeatWrapping;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const vert = glsl`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const frag = glsl`
uniform sampler2D tBall;
uniform mat3 uBasis;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  vec3 s = vec3(p.x, p.y, sqrt(1.0 - r2));
  vec3 d = normalize(uBasis * s); // (east, north, up)
  float heading = atan(d.x, d.y);
  float pitch = asin(clamp(d.z, -1.0, 1.0));
  vec2 uv = vec2(fract(heading / 6.2831853), pitch / 3.14159265 + 0.5);
  vec3 c = texture2D(tBall, uv).rgb;
  float shade = 0.55 + 0.45 * pow(s.z, 0.6);
  float spec = pow(max(0.0, dot(normalize(s), normalize(vec3(-0.4, 0.55, 1.0)))), 40.0) * 0.25;
  float rim = smoothstep(0.86, 1.0, sqrt(r2));
  c = c * shade + spec;
  c = mix(c, c * 0.35, rim);
  gl_FragColor = vec4(c, 1.0);
}
`;

const _size = new Vector2();
const _right = new Vector3();
const _dorsal = new Vector3();
const _nose = new Vector3();

export class Navball {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: ShaderMaterial;
  private readonly quad: Mesh;
  /** Vessel axes in world space (right, dorsal, nose), updated each frame. */
  readonly right = new Vector3(1, 0, 0);
  readonly dorsal = new Vector3(0, 0, 1);
  readonly nose = new Vector3(0, 1, 0);

  constructor() {
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { tBall: { value: drawBallTexture() }, uBasis: { value: new Matrix3() } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Free the 2048×1024 ball texture and the quad (one navball is built per flight). */
  dispose(): void {
    (this.mat.uniforms.tBall!.value as CanvasTexture).dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }

  /**
   * @param qVessel vessel orientation (vessel → world)
   * @param up/east/north local frame at the vessel (world)
   */
  setAttitude(right: Vector3, dorsal: Vector3, nose: Vector3, east: Vector3, north: Vector3, up: Vector3): void {
    this.right.copy(right);
    this.dorsal.copy(dorsal);
    this.nose.copy(nose);
    // Columns: screen axes expressed in ENU coordinates
    _right.set(right.dot(east), right.dot(north), right.dot(up));
    _dorsal.set(dorsal.dot(east), dorsal.dot(north), dorsal.dot(up));
    _nose.set(nose.dot(east), nose.dot(north), nose.dot(up));
    (this.mat.uniforms.uBasis!.value as Matrix3).set(
      _right.x, _dorsal.x, _nose.x,
      _right.y, _dorsal.y, _nose.y,
      _right.z, _dorsal.z, _nose.z,
    );
  }

  /** Project a world direction onto the ball: returns (x, y, visible) in [-1,1]. */
  project(dir: Vector3, out: { x: number; y: number; front: boolean }): void {
    const len = dir.length() || 1;
    const x = dir.dot(this.right) / len;
    const y = dir.dot(this.dorsal) / len;
    const z = dir.dot(this.nose) / len;
    out.x = x;
    out.y = y;
    out.front = z > 0;
  }

  /** Render into a square viewport (device pixels, origin bottom-left). */
  render(renderer: WebGLRenderer, x: number, y: number, size: number): void {
    const prevScissor = renderer.getScissorTest();
    renderer.setRenderTarget(null);
    renderer.setViewport(x, y, size, size);
    renderer.setScissor(x, y, size, size);
    renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(prevScissor);
    renderer.getSize(_size);
    renderer.setViewport(0, 0, _size.x, _size.y);
  }
}
