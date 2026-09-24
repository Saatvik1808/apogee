/**
 * LEARNING NOTE: Rendering UI icons with the game engine
 *
 * Instead of drawing 40 part icons by hand, we photograph the real 3D models:
 * each part is built, framed by a camera fitted to its bounding sphere, rendered
 * into an off-screen HDR render target, then tone-mapped and gamma-encoded on the
 * CPU into a small PNG (a data: URL the catalog <img> tags can show). The icons
 * therefore always match the in-game models, lighting included.
 *
 * Key concepts: render-to-texture, readback, tone mapping, sRGB encoding,
 * camera framing with bounding spheres, caching
 */
import {
  Box3,
  DirectionalLight,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { computePartStats, defaultConfig, type PartDef } from '../../parts/PartCatalog';
import { buildPartVisual, disposeObject } from '../../render/vessel/PartMeshes';

const SIZE = 160;
const cache = new Map<string, string>();

function halfToFloat(h: number): number {
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  if (e === 0) return s * (f / 1024) * 6.103515625e-5;
  if (e === 31) return f ? 0 : s * 65504;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** ACES filmic fit (same curve as the in-game composite). */
function aces(x: number): number {
  const a = x * (x + 0.0245786) - 0.000090537;
  const b = x * (0.983729 * x + 0.432951) + 0.238081;
  return Math.max(0, Math.min(1, a / b));
}

function toSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function thumbnailFor(def: PartDef): string | undefined {
  return cache.get(def.id);
}

/** Render icons for all given parts that aren't cached yet. */
export function renderThumbnails(renderer: WebGLRenderer, env: Texture | null, defs: PartDef[]): void {
  const todo = defs.filter((d) => !cache.has(d.id));
  if (!todo.length) return;
  const scene = new Scene();
  scene.environment = env;
  scene.environmentIntensity = 1.2;
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const cam = new PerspectiveCamera(30, 1, 0.05, 1000);
  const rt = new WebGLRenderTarget(SIZE, SIZE, { type: HalfFloatType, samples: 4 });
  const buf = new Uint16Array(SIZE * SIZE * 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx2d = canvas.getContext('2d')!;
  const img = ctx2d.createImageData(SIZE, SIZE);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearAlpha();
  const box = new Box3();
  const sphere = new Sphere();
  const dir = new Vector3(1, 0.42, 1.25).normalize();
  for (const def of todo) {
    const cfg = defaultConfig(def);
    const stats = computePartStats(def, cfg);
    const vis = buildPartVisual(def, stats, cfg, { parentBottomDiameter: 0, topAttached: false, bottomAttached: false });
    scene.add(vis.root);
    vis.root.updateMatrixWorld(true);
    box.setFromObject(vis.root);
    box.getBoundingSphere(sphere);
    const dist = (sphere.radius / Math.sin(((cam.fov / 2) * Math.PI) / 180)) * 1.02;
    cam.position.copy(sphere.center).addScaledVector(dir, dist);
    cam.near = Math.max(0.01, dist - sphere.radius * 2);
    cam.far = dist + sphere.radius * 2;
    cam.lookAt(sphere.center);
    cam.updateProjectionMatrix();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
    const exposure = 1.1;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const si = ((SIZE - 1 - y) * SIZE + x) * 4; // flip vertically
        const di = (y * SIZE + x) * 4;
        const a = Math.max(0, Math.min(1, halfToFloat(buf[si + 3]!)));
        for (let c = 0; c < 3; c++) {
          // Anti-aliased edges are blended over the transparent clear: un-premultiply
          const lin = (halfToFloat(buf[si + c]!) / Math.max(a, 1e-3)) * exposure;
          img.data[di + c] = Math.round(toSrgb(aces(lin)) * 255);
        }
        img.data[di + 3] = Math.round(a * 255);
      }
    }
    ctx2d.putImageData(img, 0, 0);
    cache.set(def.id, canvas.toDataURL('image/png'));
    scene.remove(vis.root);
    disposeObject(vis.root);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(0x000000, prevClear);
  rt.dispose();
}
