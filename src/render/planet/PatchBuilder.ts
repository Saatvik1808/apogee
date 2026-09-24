/**
 * LEARNING NOTE: Cube-sphere terrain patches
 *
 * How do you mesh an entire planet at centimetre detail? Start with a cube, split
 * each face recursively into a quadtree, and "inflate" every vertex onto the
 * sphere. A cube avoids the pinched poles of a latitude/longitude grid. We use
 * the smooth cube→sphere mapping
 *     x' = x·√(1 − y²/2 − z²/2 + y²z²/3)   (and cyclic)
 * which keeps cells far more uniform in area than simply normalising.
 *
 * Every patch is the same 33×33 vertex grid; only its size changes with depth in
 * the quadtree. Vertex positions are stored RELATIVE TO THE PATCH CENTRE so 32-bit
 * GPU floats stay precise (a planet-centred coordinate of 6,371,000 m has only
 * ~0.5 m precision in float32 — visible jitter when landing).
 *
 * SKIRTS: neighbouring patches at different LODs don't share edge vertices, which
 * leaves hairline cracks. A short vertical "skirt" hangs off every edge to hide
 * them — cheap and robust.
 *
 * Key concepts: quadtree LOD, cube-sphere mapping, local coordinates for GPU
 * precision, crack hiding with skirts, finite-difference normals
 */
import { Vector3 } from 'three';

export const PATCH_N = 32;
export const PATCH_VERTS = (PATCH_N + 1) * (PATCH_N + 1);
export const SKIRT_VERTS = 4 * (PATCH_N + 1);
export const TOTAL_VERTS = PATCH_VERTS + SKIRT_VERTS;
/** Detail texture coordinate period (m); detail textures must tile at divisors of this. */
export const DETAIL_PERIOD = 4096;

export interface FaceBasis {
  n: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
}

export const FACES: FaceBasis[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** Face coords (s,t ∈ [−1,1]) → unit sphere direction (body-fixed). */
export function cubeToSphere(face: number, s: number, t: number, out: Vector3): Vector3 {
  const f = FACES[face]!;
  const x = f.n[0] + s * f.u[0] + t * f.v[0];
  const y = f.n[1] + s * f.u[1] + t * f.v[1];
  const z = f.n[2] + s * f.u[2] + t * f.v[2];
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  out.set(
    x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3)),
    y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3)),
    z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3)),
  );
  return out.normalize();
}

export interface PatchRequest {
  id: number;
  body: string;
  face: number;
  /** Face-space origin (lower-left) and size. */
  s0: number;
  t0: number;
  size: number;
  radius: number;
  /** Min wavelength for procedural detail (m). */
  minWavelength: number;
}

export interface PatchResult {
  id: number;
  /** Patch centre (body-fixed, metres). */
  cx: number;
  cy: number;
  cz: number;
  boundRadius: number;
  minH: number;
  maxH: number;
  positions: Float32Array;
  normals: Float32Array;
  dirs: Float32Array;
  heights: Float32Array;
  detail: Float32Array;
  /** Two low-frequency noise fields for land-cover variation (−1..1). */
  macro: Float32Array;
}

export type HeightFn = (dir: Vector3, minWavelength: number) => number;
/** Writes two band-limited macro-variation noise values for a direction. */
export type MacroFn = (dir: Vector3, minWavelength: number, out: [number, number]) => void;
const _macro: [number, number] = [0, 0];

const _d = new Vector3();

/**
 * Build patch vertex data. Heights are evaluated on an (N+3)² grid including a
 * one-vertex border so normals at patch edges match their neighbours.
 */
export function buildPatch(req: PatchRequest, heightFn: HeightFn, hasOcean: boolean, macroFn?: MacroFn): PatchResult {
  const N = PATCH_N;
  const G = N + 3; // with border
  const R = req.radius;
  const step = req.size / N;
  const px = new Float64Array(G * G);
  const py = new Float64Array(G * G);
  const pz = new Float64Array(G * G);
  const rawH = new Float32Array(G * G);
  const dx = new Float32Array(G * G);
  const dy = new Float32Array(G * G);
  const dz = new Float32Array(G * G);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const s = req.s0 + (i - 1) * step;
      const t = req.t0 + (j - 1) * step;
      cubeToSphere(req.face, s, t, _d);
      const h = heightFn(_d, req.minWavelength);
      const k = j * G + i;
      rawH[k] = h;
      const rr = R + (hasOcean ? Math.max(0, h) : h);
      px[k] = _d.x * rr;
      py[k] = _d.y * rr;
      pz[k] = _d.z * rr;
      dx[k] = _d.x;
      dy[k] = _d.y;
      dz[k] = _d.z;
    }
  }
  // Patch centre = centre grid vertex
  const ci = ((N / 2 + 1) | 0) * G + ((N / 2 + 1) | 0);
  const cx = px[ci]!;
  const cy = py[ci]!;
  const cz = pz[ci]!;
  const positions = new Float32Array(3 * (PATCH_VERTS + SKIRT_VERTS));
  const normals = new Float32Array(3 * (PATCH_VERTS + SKIRT_VERTS));
  const dirs = new Float32Array(3 * (PATCH_VERTS + SKIRT_VERTS));
  const heights = new Float32Array(PATCH_VERTS + SKIRT_VERTS);
  const detail = new Float32Array(3 * (PATCH_VERTS + SKIRT_VERTS));
  const macro = new Float32Array(2 * (PATCH_VERTS + SKIRT_VERTS));
  const ox = Math.floor(cx / DETAIL_PERIOD) * DETAIL_PERIOD;
  const oy = Math.floor(cy / DETAIL_PERIOD) * DETAIL_PERIOD;
  const oz = Math.floor(cz / DETAIL_PERIOD) * DETAIL_PERIOD;
  let bound = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  let v = 0;
  for (let j = 1; j <= N + 1; j++) {
    for (let i = 1; i <= N + 1; i++) {
      const k = j * G + i;
      const x = px[k]! - cx;
      const y = py[k]! - cy;
      const z = pz[k]! - cz;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      bound = Math.max(bound, x * x + y * y + z * z);
      // Normal from central differences on the displaced grid
      const kl = k - 1;
      const kr = k + 1;
      const kd = k - G;
      const ku = k + G;
      const ax = px[kr]! - px[kl]!;
      const ay = py[kr]! - py[kl]!;
      const az = pz[kr]! - pz[kl]!;
      const bx = px[ku]! - px[kd]!;
      const by = py[ku]! - py[kd]!;
      const bz = pz[ku]! - pz[kd]!;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      // Ensure outward-facing
      if (nx * dx[k]! + ny * dy[k]! + nz * dz[k]! < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      dirs[v * 3] = dx[k]!;
      dirs[v * 3 + 1] = dy[k]!;
      dirs[v * 3 + 2] = dz[k]!;
      const h = rawH[k]!;
      heights[v] = h;
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      detail[v * 3] = px[k]! - ox;
      detail[v * 3 + 1] = py[k]! - oy;
      detail[v * 3 + 2] = pz[k]! - oz;
      if (macroFn) {
        _d.set(dx[k]!, dy[k]!, dz[k]!);
        macroFn(_d, req.minWavelength, _macro);
        macro[v * 2] = _macro[0];
        macro[v * 2 + 1] = _macro[1];
      }
      v++;
    }
  }
  // Skirts: copy edge vertices, pushed toward the planet centre. A crack against a
  // coarser neighbour can't be deeper than this patch's own height range, so the
  // skirt needn't be either (long skirts show up as "fences" on the horizon).
  const skirt = Math.min(req.size * R * 0.012 + 30, maxH - minH + 12);
  const edge = (i: number, j: number) => {
    const src = (j - 1) * (N + 1) + (i - 1);
    const k = j * G + i;
    const x = px[k]!;
    const y = py[k]!;
    const z = pz[k]!;
    positions[v * 3] = x - dx[k]! * skirt - cx;
    positions[v * 3 + 1] = y - dy[k]! * skirt - cy;
    positions[v * 3 + 2] = z - dz[k]! * skirt - cz;
    normals[v * 3] = normals[src * 3]!;
    normals[v * 3 + 1] = normals[src * 3 + 1]!;
    normals[v * 3 + 2] = normals[src * 3 + 2]!;
    dirs[v * 3] = dirs[src * 3]!;
    dirs[v * 3 + 1] = dirs[src * 3 + 1]!;
    dirs[v * 3 + 2] = dirs[src * 3 + 2]!;
    heights[v] = heights[src]!;
    detail[v * 3] = detail[src * 3]!;
    detail[v * 3 + 1] = detail[src * 3 + 1]!;
    detail[v * 3 + 2] = detail[src * 3 + 2]!;
    macro[v * 2] = macro[src * 2]!;
    macro[v * 2 + 1] = macro[src * 2 + 1]!;
    v++;
  };
  for (let i = 1; i <= N + 1; i++) edge(i, 1);
  for (let i = 1; i <= N + 1; i++) edge(i, N + 1);
  for (let j = 1; j <= N + 1; j++) edge(1, j);
  for (let j = 1; j <= N + 1; j++) edge(N + 1, j);
  return {
    id: req.id,
    cx,
    cy,
    cz,
    boundRadius: Math.sqrt(bound) + skirt,
    minH,
    maxH,
    positions,
    normals,
    dirs,
    heights,
    detail,
    macro,
  };
}

/** Shared triangle index list (surface + double-sided skirts). */
export function buildPatchIndices(): Uint16Array {
  const N = PATCH_N;
  const idx: number[] = [];
  const at = (i: number, j: number) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      // Alternate diagonals for more even tessellation
      if ((i + j) % 2 === 0) {
        idx.push(a, b, c, a, c, d);
      } else {
        idx.push(a, b, d, b, c, d);
      }
    }
  }
  const base = PATCH_VERTS;
  const strips: Array<[number, (k: number) => number]> = [
    [0, (k) => at(k, 0)],
    [N + 1, (k) => at(k, N)],
    [2 * (N + 1), (k) => at(0, k)],
    [3 * (N + 1), (k) => at(N, k)],
  ];
  for (const [off, edgeIdx] of strips) {
    for (let k = 0; k < N; k++) {
      const e0 = edgeIdx(k);
      const e1 = edgeIdx(k + 1);
      const s0 = base + off + k;
      const s1 = base + off + k + 1;
      // both windings so the skirt is visible from either side
      idx.push(e0, e1, s1, e0, s1, s0);
      idx.push(e0, s1, e1, e0, s0, s1);
    }
  }
  return new Uint16Array(idx);
}
