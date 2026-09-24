/**
 * LEARNING NOTE: Quadtree level-of-detail for a whole planet
 *
 * Each frame we walk six quadtrees (one per cube face). A node SPLITS into four
 * children when the camera is closer than a few times the node's size, so detail
 * concentrates where you're looking: metre-scale patches under your landing legs,
 * 500-km patches on the far limb. Nodes far behind the horizon are skipped
 * entirely (horizon culling), and three.js skips nodes outside the view frustum.
 *
 * Patches are built asynchronously in a Web Worker. Until all four children of a
 * node have arrived we keep drawing the parent, so the planet never shows holes —
 * detail simply "sharpens" a moment later.
 *
 * Recently used patches stay cached (LRU) so looking around doesn't regenerate
 * them; old ones are disposed to bound GPU memory.
 *
 * Key concepts: quadtrees, LOD selection metrics, horizon culling, asynchronous
 * streaming, LRU caches
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Sphere,
  Vector3,
  type Material,
} from 'three';
import type { CelestialBody } from '../../physics/CelestialBody';
import { buildPatchIndices, cubeToSphere, type PatchRequest, type PatchResult } from './PatchBuilder';

export interface TerrainWorkerPool {
  request(req: PatchRequest, cb: (res: PatchResult) => void): void;
  cancel(ids: number[]): void;
}

let sharedIndex: BufferAttribute | null = null;
function patchIndex(): BufferAttribute {
  if (!sharedIndex) sharedIndex = new BufferAttribute(buildPatchIndices(), 1);
  return sharedIndex;
}

let nextNodeId = 1;
const _v = new Vector3();
const _c = new Vector3();

class TerrainNode {
  readonly id = nextNodeId++;
  readonly face: number;
  readonly level: number;
  readonly s0: number;
  readonly t0: number;
  readonly size: number;
  readonly centerDir = new Vector3();
  /** Approx. centre in body-fixed metres (before patch data arrives). */
  readonly approxCenter = new Vector3();
  approxRadius: number;
  children: TerrainNode[] | null = null;
  mesh: Mesh | null = null;
  pending = false;
  lastUsed = 0;
  minH = 0;
  maxH = 0;

  constructor(face: number, level: number, s0: number, t0: number, size: number, radius: number) {
    this.face = face;
    this.level = level;
    this.s0 = s0;
    this.t0 = t0;
    this.size = size;
    cubeToSphere(face, s0 + size / 2, t0 + size / 2, this.centerDir);
    this.approxCenter.copy(this.centerDir).multiplyScalar(radius);
    // corner distance → bounding radius estimate
    cubeToSphere(face, s0, t0, _v);
    this.approxRadius = _v.multiplyScalar(radius).distanceTo(this.approxCenter) * 1.05;
  }

  get ready(): boolean {
    return this.mesh !== null;
  }
}

export interface PlanetTerrainOptions {
  maxLevel: number;
  /** Split when distance < boundRadius × splitFactor. */
  splitFactor: number;
  maxCached: number;
  bodyKey: string;
}

export class PlanetTerrain {
  readonly body: CelestialBody;
  /** Rotates with the body; positioned at (body − camera). */
  readonly group = new Group();
  private readonly material: Material;
  private readonly roots: TerrainNode[] = [];
  private readonly pool: TerrainWorkerPool;
  readonly opts: PlanetTerrainOptions;
  private frame = 0;
  private readonly live = new Set<TerrainNode>();
  /** Camera position in the body-fixed frame (metres), updated each frame. */
  private readonly camBF = new Vector3();
  private camDist = 0;
  private inFlight = 0;
  private readonly wanted: TerrainNode[] = [];
  visibleCount = 0;
  maxInFlight = 6;

  constructor(body: CelestialBody, material: Material, pool: TerrainWorkerPool, opts: PlanetTerrainOptions) {
    this.body = body;
    this.material = material;
    this.pool = pool;
    this.opts = opts;
    this.group.name = `terrain-${body.id}`;
    this.group.matrixAutoUpdate = true;
    for (let f = 0; f < 6; f++) this.roots.push(new TerrainNode(f, 0, -1, -1, 2, body.radius));
  }

  /**
   * @param camBodyFixed camera position in the body-fixed frame (metres from centre)
   * @param lodBias multiplier on split distance (quality setting)
   */
  update(camBodyFixed: Vector3, lodBias = 1): void {
    this.frame++;
    this.camBF.copy(camBodyFixed);
    this.camDist = camBodyFixed.length();
    this.wanted.length = 0;
    // Hide only our patches: other objects (launch pads) may be attached to the group
    for (const n of this.live) if (n.mesh) n.mesh.visible = false;
    this.visibleCount = 0;
    for (const r of this.roots) this.visit(r, lodBias);
    // Request missing patches, nearest first
    this.wanted.sort((a, b) => this.distTo(a) - this.distTo(b));
    for (const n of this.wanted) {
      if (this.inFlight >= this.maxInFlight) break;
      this.requestNode(n);
    }
    if (this.frame % 60 === 0) this.evict();
  }

  private distTo(n: TerrainNode): number {
    const c = n.mesh ? _c.set(n.mesh.position.x, n.mesh.position.y, n.mesh.position.z) : n.approxCenter;
    return Math.max(0, c.distanceTo(this.camBF) - n.approxRadius);
  }

  private horizonVisible(n: TerrainNode): boolean {
    const R = this.body.radius;
    const t = this.body.terrain;
    const rMin = R + (t ? Math.min(0, t.minHeight) : 0);
    const rMax = R + (t ? t.maxHeight : 0);
    const D = this.camDist;
    // The occluder is a sphere at the lowest terrain height (or just below the
    // camera when it sits even lower). Terrain beyond the horizon of that sphere
    // cannot be seen, even from inside the height range (e.g. standing on a pad).
    const rOcc = Math.min(rMin, D - 1);
    if (rOcc <= 0) return true;
    const cosAng = n.centerDir.dot(_v.copy(this.camBF).multiplyScalar(1 / D));
    const ang = Math.acos(Math.max(-1, Math.min(1, cosAng)));
    const beta = n.approxRadius / R;
    const horizon = Math.acos(Math.min(1, rOcc / D)) + Math.acos(Math.min(1, rOcc / rMax));
    return ang - beta <= horizon + 0.002;
  }

  private visit(n: TerrainNode, lodBias: number): void {
    n.lastUsed = this.frame;
    if (!this.horizonVisible(n)) return;
    const d = this.distTo(n);
    const split = n.level < this.opts.maxLevel && d < n.approxRadius * this.opts.splitFactor * lodBias;
    if (split) {
      if (!n.children) {
        const h = n.size / 2;
        n.children = [
          new TerrainNode(n.face, n.level + 1, n.s0, n.t0, h, this.body.radius),
          new TerrainNode(n.face, n.level + 1, n.s0 + h, n.t0, h, this.body.radius),
          new TerrainNode(n.face, n.level + 1, n.s0, n.t0 + h, h, this.body.radius),
          new TerrainNode(n.face, n.level + 1, n.s0 + h, n.t0 + h, h, this.body.radius),
        ];
      }
      let allReady = true;
      for (const c of n.children) {
        c.lastUsed = this.frame;
        if (!c.ready) {
          allReady = false;
          if (!c.pending) this.wanted.push(c);
        }
      }
      if (allReady) {
        for (const c of n.children) this.visit(c, lodBias);
        return;
      }
    }
    if (n.mesh) {
      n.mesh.visible = true;
      this.visibleCount++;
    } else if (!n.pending) {
      this.wanted.push(n);
    }
  }

  private requestNode(n: TerrainNode): void {
    if (n.pending || n.mesh) return;
    n.pending = true;
    this.inFlight++;
    const R = this.body.radius;
    // Patch vertex spacing ≈ arc length / 32; don't generate detail finer than 2 samples
    const arc = (Math.PI / 4) * n.size * R;
    const req: PatchRequest = {
      id: n.id,
      body: this.opts.bodyKey,
      face: n.face,
      s0: n.s0,
      t0: n.t0,
      size: n.size,
      radius: R,
      minWavelength: n.level >= this.opts.maxLevel ? 0 : (arc / 32) * 2,
    };
    this.pool.request(req, (res) => {
      this.inFlight--;
      n.pending = false;
      if (n.lastUsed < this.frame - 600) return; // stale
      this.attach(n, res);
    });
  }

  private attach(n: TerrainNode, res: PatchResult): void {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(res.positions, 3));
    g.setAttribute('normal', new BufferAttribute(res.normals, 3));
    g.setAttribute('aDir', new BufferAttribute(res.dirs, 3));
    g.setAttribute('aHeight', new BufferAttribute(res.heights, 1));
    g.setAttribute('aDetail', new BufferAttribute(res.detail, 3));
    g.setAttribute('aMacro', new BufferAttribute(res.macro, 2));
    g.setIndex(patchIndex());
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), res.boundRadius);
    const m = new Mesh(g, this.material);
    m.position.set(res.cx, res.cy, res.cz);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.frustumCulled = true;
    m.visible = false;
    m.name = `patch-${n.face}-${n.level}`;
    n.mesh = m;
    n.minH = res.minH;
    n.maxH = res.maxH;
    n.approxCenter.set(res.cx, res.cy, res.cz);
    n.approxRadius = res.boundRadius;
    this.group.add(m);
    this.live.add(n);
  }

  private evict(): void {
    if (this.live.size <= this.opts.maxCached) return;
    const arr = [...this.live].filter((n) => n.level > 0).sort((a, b) => a.lastUsed - b.lastUsed);
    const excess = this.live.size - this.opts.maxCached;
    for (let i = 0; i < excess && i < arr.length; i++) {
      const n = arr[i]!;
      if (n.lastUsed >= this.frame - 2) break;
      this.disposeNode(n);
    }
  }

  private disposeNode(n: TerrainNode): void {
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    this.live.delete(n);
    // Children are useless without the parent being refined; drop them too
    if (n.children) {
      for (const c of n.children) this.disposeNode(c);
      n.children = null;
    }
  }

  /** True when the six root patches exist (planet renders without holes). */
  get baseReady(): boolean {
    return this.roots.every((r) => r.ready);
  }

  /** Force-request the root patches (at load). */
  prime(): void {
    for (const r of this.roots) this.requestNode(r);
  }

  dispose(): void {
    for (const n of [...this.live]) this.disposeNode(n);
  }
}
