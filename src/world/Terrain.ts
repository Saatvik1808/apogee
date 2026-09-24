/**
 * LEARNING NOTE: One terrain function for physics AND graphics
 *
 * A classic bug in games is a mismatch between what you SEE and what you COLLIDE
 * with. Here a single CPU function answers "how high is the ground in direction d?"
 * and it is used both by the terrain mesher (to place vertices) and by the landing
 * physics (to find contact). Its layers:
 *
 *   1. Real elevation data (NASA/NOAA DEMs) sampled with bicubic interpolation so
 *      slopes are smooth between the 5–10 km data points.
 *   2. Coastlines from a land/water mask; oceans sit at sea level for rendering and
 *      are "water" for splashdowns.
 *   3. Procedural detail: fBm noise (Earth, Mars) and multi-scale impact craters
 *      (Moon) generated deterministically from hashed grid cells.
 *   4. Launch pads flattened with a smooth blend.
 *
 * Detail is LEVEL-OF-DETAIL aware: a patch whose vertices are 2 km apart doesn't
 * evaluate 10 m noise (it would alias into sparkle), but the physics near your
 * landing legs gets every octave.
 *
 * Key concepts: DEMs, bicubic interpolation, procedural detail, LOD, determinism
 */
import { Vector3 } from 'three';
import type { TerrainProvider } from '../physics/CelestialBody';
import { SimplexNoise } from './Noise';

export class HeightGrid {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Float32Array | Uint8Array,
  ) {}

  private at(x: number, y: number): number {
    const w = this.width;
    x = ((x % w) + w) % w;
    y = y < 0 ? 0 : y >= this.height ? this.height - 1 : y;
    return this.data[y * w + x]!;
  }

  /** Catmull–Rom bicubic sample at equirect UV (u wraps, v clamps). */
  sampleBicubic(u: number, v: number): number {
    const x = u * this.width - 0.5;
    const y = v * this.height - 0.5;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const wx0 = ((-0.5 * fx + 1) * fx - 0.5) * fx;
    const wx1 = (1.5 * fx - 2.5) * fx * fx + 1;
    const wx2 = ((-1.5 * fx + 2) * fx + 0.5) * fx;
    const wx3 = (0.5 * fx - 0.5) * fx * fx;
    let sum = 0;
    for (let j = -1; j <= 2; j++) {
      const wy = j === -1 ? ((-0.5 * fy + 1) * fy - 0.5) * fy : j === 0 ? (1.5 * fy - 2.5) * fy * fy + 1 : j === 1 ? ((-1.5 * fy + 2) * fy + 0.5) * fy : (0.5 * fy - 0.5) * fy * fy;
      const yy = iy + j;
      sum += wy * (wx0 * this.at(ix - 1, yy) + wx1 * this.at(ix, yy) + wx2 * this.at(ix + 1, yy) + wx3 * this.at(ix + 2, yy));
    }
    return sum;
  }

  sampleBilinear(u: number, v: number): number {
    const x = u * this.width - 0.5;
    const y = v * this.height - 0.5;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const a = this.at(ix, iy);
    const b = this.at(ix + 1, iy);
    const c = this.at(ix, iy + 1);
    const d = this.at(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}

/** Direction → equirect UV (u: lon −180→180 left→right, v: lat +90 top). */
export function dirToUV(d: Vector3, out: { u: number; v: number }): { u: number; v: number } {
  const lon = Math.atan2(-d.z, d.x);
  const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
  out.u = lon / (2 * Math.PI) + 0.5;
  out.v = 0.5 - lat / Math.PI;
  return out;
}

export interface FlatSite {
  dir: Vector3;
  radius: number;
  blend: number;
  height: number;
  /** Local east/north unit vectors (body-fixed) for coastline shaping. */
  east: Vector3;
  north: Vector3;
  /** Direction (radians from north, clockwise) toward the sea, or NaN if inland. */
  seaBearing: number;
  /** Distance from the pad to the synthetic shoreline (m). */
  coastDistance: number;
}

const _uv = { u: 0, v: 0 };

/** Deterministic integer hash → [0,1). */
function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface CraterLevel {
  /** Typical crater radius (m). */
  radius: number;
  /** Probability a cell holds a crater. */
  density: number;
  /** depth / diameter */
  depthRatio: number;
}

/**
 * Base class: DEM + LOD-limited procedural detail. `minWavelength` = 0 → full detail.
 */
export abstract class BaseTerrain implements TerrainProvider {
  readonly radius: number;
  readonly maxHeight: number;
  readonly minHeight: number;
  protected readonly grid: HeightGrid | null;
  protected readonly noise: SimplexNoise;
  readonly flatSites: FlatSite[] = [];

  constructor(radius: number, grid: HeightGrid | null, minH: number, maxH: number, seed: number) {
    this.radius = radius;
    this.grid = grid;
    this.noise = new SimplexNoise(seed);
    this.minHeight = minH;
    this.maxHeight = maxH;
  }

  addFlatSite(dir: Vector3, radius: number, blend: number, seaBearing = NaN, coastDistance = 0): void {
    const d = dir.clone().normalize();
    const east = new Vector3(d.z, 0, -d.x);
    if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
    east.normalize();
    const north = new Vector3().crossVectors(d, east).normalize();
    const site: FlatSite = { dir: d, radius, blend, height: 3, east, north, seaBearing, coastDistance };
    this.flatSites.push(site);
    site.height = Math.max(this.rawHeight(d, 0), 3);
  }

  heightAt(dir: Vector3): number {
    return this.heightAtLod(dir, 0);
  }

  /**
   * Land-cover variation for the renderer (fields vs forest, soil tone) at 2.6 km
   * and 700 m scales, band-limited like the heights. Evaluated per vertex in the
   * terrain workers, so the pixel shader doesn't have to run noise per pixel.
   */
  macroAt(dir: Vector3, minWavelength: number, out: [number, number]): void {
    const R = this.radius;
    const x = dir.x * R;
    const y = dir.y * R;
    const z = dir.z * R;
    out[0] = this.noise.fbm(x + 5100, y - 3300, z + 1700, 2600, 4, minWavelength) / 1.2;
    out[1] = this.noise.fbm(x - 800, y + 2100, z - 4400, 700, 3, minWavelength) / 1.1;
  }

  heightAtLod(dir: Vector3, minWavelength: number): number {
    let h = this.rawHeight(dir, minWavelength);
    for (const s of this.flatSites) {
      const c = dir.dot(s.dir);
      if (c < 0.99) continue;
      const dist = Math.acos(Math.min(1, c)) * this.radius;
      if (dist < s.radius + s.blend) {
        const t = Math.max(0, (dist - s.radius) / s.blend);
        const k = t * t * (3 - 2 * t);
        h = s.height + (h - s.height) * k;
      }
    }
    return h;
  }

  isWater(dir: Vector3): boolean {
    return this.heightAt(dir) < 0 && this.hasOcean;
  }

  get hasOcean(): boolean {
    return false;
  }

  protected baseHeight(dir: Vector3): number {
    if (!this.grid) return 0;
    dirToUV(dir, _uv);
    return this.grid.sampleBicubic(_uv.u, _uv.v);
  }

  protected abstract rawHeight(dir: Vector3, minWavelength: number): number;

  /** Sum of impact craters over several size classes (cube-face cell hashing). */
  protected craters(dir: Vector3, levels: CraterLevel[], minWavelength: number, seed: number): number {
    const ax = Math.abs(dir.x);
    const ay = Math.abs(dir.y);
    const az = Math.abs(dir.z);
    let face: number;
    let s: number;
    let t: number;
    if (ax >= ay && ax >= az) {
      face = dir.x > 0 ? 0 : 1;
      s = dir.z / ax;
      t = dir.y / ax;
    } else if (ay >= az) {
      face = dir.y > 0 ? 2 : 3;
      s = dir.x / ay;
      t = dir.z / ay;
    } else {
      face = dir.z > 0 ? 4 : 5;
      s = dir.x / az;
      t = dir.y / az;
    }
    const R = this.radius;
    let total = 0;
    for (let li = 0; li < levels.length; li++) {
      const L = levels[li]!;
      if (L.radius * 1.2 < minWavelength) continue;
      const cellsPerFace = Math.max(1, Math.round((Math.PI * 0.5 * R) / (L.radius * 3.2)));
      const cs = 2 / cellsPerFace;
      const ci = Math.floor((s + 1) / cs);
      const cj = Math.floor((t + 1) / cs);
      const fade = minWavelength > 0 ? Math.min(1, (L.radius * 1.2 - minWavelength) / minWavelength) : 1;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= cellsPerFace || j >= cellsPerFace) continue;
          const h0 = hash4(face + seed * 7, i, j, li * 131 + seed);
          if (h0 > L.density) continue;
          const r1 = hash4(i, j, face, li + 1000);
          const r2 = hash4(j, i, face + 11, li + 2000);
          const r3 = hash4(i + 7, j - 3, face, li + 3000);
          const cs0 = -1 + (i + 0.15 + r1 * 0.7) * cs;
          const ct0 = -1 + (j + 0.15 + r2 * 0.7) * cs;
          // Cell-centre direction (gnomonic cube → sphere)
          let cx: number;
          let cy: number;
          let cz: number;
          switch (face) {
            case 0: cx = 1; cy = ct0; cz = cs0; break;
            case 1: cx = -1; cy = ct0; cz = cs0; break;
            case 2: cx = cs0; cy = 1; cz = ct0; break;
            case 3: cx = cs0; cy = -1; cz = ct0; break;
            case 4: cx = cs0; cy = ct0; cz = 1; break;
            default: cx = cs0; cy = ct0; cz = -1; break;
          }
          const inv = 1 / Math.hypot(cx, cy, cz);
          const dot = (dir.x * cx + dir.y * cy + dir.z * cz) * inv;
          const rad = L.radius * (0.45 + r3 * 1.1);
          const ang = Math.acos(Math.min(1, dot));
          const d = (ang * R) / rad;
          if (d > 2.6) continue;
          const depth = 2 * rad * L.depthRatio;
          const rimH = depth * 0.22;
          let h = 0;
          if (d < 1) h -= depth * (1 - d * d) * (d < 0.35 ? 0.92 + 0.08 * (d / 0.35) : 1);
          const rd = (d - 1) / 0.22;
          h += rimH * Math.exp(-rd * rd);
          if (d > 1) h += rimH * 0.35 * Math.exp(-(d - 1) * 2.2);
          total += h * fade;
        }
      }
    }
    return total;
  }
}

/** Earth: land elevation (m) + land/water mask + fBm detail. */
export class EarthTerrain extends BaseTerrain {
  private readonly mask: CoastSdf | null;

  constructor(radius: number, heights: HeightGrid | null, mask: CoastSdf | null) {
    super(radius, heights, -120, 8900, 424242);
    this.mask = mask;
  }

  override get hasOcean(): boolean {
    return true;
  }

  override isWater(dir: Vector3): boolean {
    return this.heightAt(dir) < 0;
  }

  protected rawHeight(dir: Vector3, minWl: number): number {
    const R = this.radius;
    const px = dir.x * R;
    const py = dir.y * R;
    const pz = dir.z * R;
    const n = this.noise;
    let land = this.baseHeight(dir);
    // Signed distance to the coast (m): + inland, − at sea
    let d = 50_000;
    if (this.mask) {
      dirToUV(dir, _uv);
      d = this.mask.sample(_uv.u, _uv.v);
      // coastal wiggles below the data resolution (bays, spits, headlands)
      if (Math.abs(d) < 12_000) d += n.fbm(px, py, pz, 9_000, 8, minWl * 2) * 1_400;
    }
    // Inland lakes are stored flat at their surface elevation: keep them as land
    if (land >= 2) d = Math.max(d, 3_000);
    // Launch sites: a synthetic, high-resolution shoreline replaces the coarse data
    for (const s of this.flatSites) {
      const c = dir.dot(s.dir);
      if (c < 0.99998) continue; // ~40 km
      const ex = (dir.x - s.dir.x) * R;
      const ey = (dir.y - s.dir.y) * R;
      const ez = (dir.z - s.dir.z) * R;
      const e = ex * s.east.x + ey * s.east.y + ez * s.east.z;
      const nn = ex * s.north.x + ey * s.north.y + ez * s.north.z;
      const dist = Math.hypot(e, nn);
      const w = 1 - Math.min(1, Math.max(0, (dist - 15_000) / 25_000));
      if (w <= 0) continue;
      let dSite = 20_000;
      if (!isNaN(s.seaBearing)) {
        const toSea = e * Math.sin(s.seaBearing) + nn * Math.cos(s.seaBearing);
        const wobble = n.fbm(px, py, pz, 3_000, 6, minWl * 2) * 600;
        dSite = s.coastDistance - toSea + wobble;
      }
      d = d + (dSite - d) * w;
      if (dSite > 0) land = Math.max(land, 2 + Math.max(0, n.fbm(px, py, pz, 4_000, 4, minWl) * 3));
    }
    // Detail: flat lowlands stay flat, mountains get rugged
    const rough = 2 + Math.max(0, land) * 0.1;
    const detail = n.fbm(px, py, pz, 18_000, 11, minWl, 0.48) * rough + n.ridged(px, py, pz, 6_000, 6, minWl) * rough * 0.8;
    land = Math.max(1.0, land + detail * Math.min(1, Math.max(0, land) / 150 + 0.25));
    // Beach profile: sea floor −60 m offshore, rising to land height over ~500 m
    const coast = Math.min(1, Math.max(0, (d + 150) / 500));
    const k = coast * coast * (3 - 2 * coast);
    return -60 + (land + 60) * k;
  }
}

/** Moon: LOLA topography + impact craters from 25 km down to metres. */
export class MoonTerrain extends BaseTerrain {
  private static readonly LEVELS: CraterLevel[] = [
    { radius: 22_000, density: 0.25, depthRatio: 0.06 },
    { radius: 6_000, density: 0.45, depthRatio: 0.1 },
    { radius: 1_500, density: 0.55, depthRatio: 0.15 },
    { radius: 380, density: 0.6, depthRatio: 0.18 },
    { radius: 90, density: 0.6, depthRatio: 0.2 },
    { radius: 22, density: 0.55, depthRatio: 0.2 },
  ];

  constructor(radius: number, heights: HeightGrid | null) {
    super(radius, heights, -9200, 10_800, 1969);
  }

  protected rawHeight(dir: Vector3, minWl: number): number {
    const R = this.radius;
    const base = this.baseHeight(dir);
    const px = dir.x * R;
    const py = dir.y * R;
    const pz = dir.z * R;
    const rolling = this.noise.fbm(px, py, pz, 9_000, 10, minWl, 0.5) * 70;
    return base + rolling + this.craters(dir, MoonTerrain.LEVELS, minWl, 3);
  }
}

/** Mars: MOLA topography + fBm + sparse craters. */
export class MarsTerrain extends BaseTerrain {
  private static readonly LEVELS: CraterLevel[] = [
    { radius: 8_000, density: 0.25, depthRatio: 0.07 },
    { radius: 1_500, density: 0.35, depthRatio: 0.12 },
    { radius: 300, density: 0.35, depthRatio: 0.15 },
    { radius: 60, density: 0.35, depthRatio: 0.15 },
  ];

  constructor(radius: number, heights: HeightGrid | null) {
    super(radius, heights, -8500, 21_300, 1976);
  }

  protected rawHeight(dir: Vector3, minWl: number): number {
    const R = this.radius;
    const base = this.baseHeight(dir);
    const px = dir.x * R;
    const py = dir.y * R;
    const pz = dir.z * R;
    const n = this.noise;
    const detail = n.fbm(px, py, pz, 14_000, 11, minWl, 0.5) * 90 + n.ridged(px, py, pz, 5_000, 6, minWl) * 60;
    return base + detail + this.craters(dir, MarsTerrain.LEVELS, minWl, 5);
  }
}

// ---------------------------------------------------------------------------
// Loading (browser)
// ---------------------------------------------------------------------------

async function loadPixels(url: string): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { w: img.width, h: img.height, data: img.data };
}

/** 16-bit packed height PNG: u16 = round((h + 10000) / 0.5), R = hi byte, G = lo byte. */
export async function loadPackedHeight(url: string): Promise<HeightGrid> {
  const { w, h, data } = await loadPixels(url);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const u16 = data[i * 4]! * 256 + data[i * 4 + 1]!;
    out[i] = u16 * 0.5 - 10_000;
  }
  return new HeightGrid(w, h, out);
}

/** Decode table for the sqrt-encoded coast SDF (metres, + land / − sea). */
const SDF_DMAX = 60_000;
export const SDF_DECODE = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const t = (v - 128) / 127;
  SDF_DECODE[v] = Math.sign(t) * t * t * SDF_DMAX;
}

/**
 * Coastline signed-distance field (see tools/assets/build_coast_sdf.py). Distances
 * vary smoothly across the coast, so interpolation yields curved shorelines with
 * sub-pixel accuracy instead of the stair-steps a binary mask produces.
 */
export class CoastSdf {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Uint8Array,
  ) {}

  /** Bilinear sample of decoded distance (m). u wraps, v clamps. */
  sample(u: number, v: number): number {
    const w = this.width;
    const h = this.height;
    const x = u * w - 0.5;
    const y = v * h - 0.5;
    let ix = Math.floor(x);
    let iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    ix = ((ix % w) + w) % w;
    const ix1 = (ix + 1) % w;
    const iy0 = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
    const iy1 = iy + 1 < 0 ? 0 : iy + 1 >= h ? h - 1 : iy + 1;
    const d = this.data;
    const a = SDF_DECODE[d[iy0 * w + ix]!]!;
    const b = SDF_DECODE[d[iy0 * w + ix1]!]!;
    const c = SDF_DECODE[d[iy1 * w + ix]!]!;
    const e = SDF_DECODE[d[iy1 * w + ix1]!]!;
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  }
}

export async function loadCoastSdf(url: string): Promise<CoastSdf> {
  const { w, h, data } = await loadPixels(url);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4]!;
  return new CoastSdf(w, h, out);
}

export interface TerrainUrls {
  earthHeight?: string;
  earthMask?: string;
  moonHeight?: string;
  marsHeight?: string;
}

export interface FlatSiteSpec {
  body: 'earth' | 'moon' | 'mars';
  lat: number;
  lon: number;
  radius: number;
  blend: number;
  /** Bearing to the sea in degrees (clockwise from north); omit for inland sites. */
  seaBearing?: number;
  coastDistance?: number;
}

export interface TerrainSet {
  earth: EarthTerrain;
  moon: MoonTerrain;
  mars: MarsTerrain;
}

/** Load every body's terrain (usable from the main thread and from workers). */
export async function loadTerrains(urls: TerrainUrls, radii: { earth: number; moon: number; mars: number }, sites: FlatSiteSpec[]): Promise<TerrainSet> {
  const safe = async (u: string | undefined, f: (u: string) => Promise<HeightGrid>) => {
    if (!u) return null;
    try {
      return await f(u);
    } catch {
      return null;
    }
  };
  const safeSdf = async (u: string | undefined) => {
    if (!u) return null;
    try {
      return await loadCoastSdf(u);
    } catch {
      return null;
    }
  };
  const [eh, em, mh, mah] = await Promise.all([
    safe(urls.earthHeight, loadPackedHeight),
    safeSdf(urls.earthMask),
    safe(urls.moonHeight, loadPackedHeight),
    safe(urls.marsHeight, loadPackedHeight),
  ]);
  const set: TerrainSet = {
    earth: new EarthTerrain(radii.earth, eh, em),
    moon: new MoonTerrain(radii.moon, mh),
    mars: new MarsTerrain(radii.mars, mah),
  };
  for (const s of sites) {
    const lat = (s.lat * Math.PI) / 180;
    const lon = (s.lon * Math.PI) / 180;
    const dir = new Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    set[s.body].addFlatSite(dir, s.radius, s.blend, s.seaBearing === undefined ? NaN : (s.seaBearing * Math.PI) / 180, s.coastDistance ?? 0);
  }
  return set;
}
