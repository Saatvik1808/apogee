/**
 * LEARNING NOTE: Asset streaming and colour spaces
 *
 * Textures carry either COLOUR (photos: Blue Marble, city lights, the Milky Way)
 * or DATA (normal maps, masks, cloud density). Colour images are stored in the
 * sRGB curve (more precision in darks, as our eyes like); the GPU must convert
 * them back to linear light before lighting maths. Data textures must NOT be
 * converted — a normal map "decoded" as sRGB would bend every surface normal.
 * Tagging each texture's colour space correctly is one of the most common
 * sources of washed-out or overly dark rendering.
 *
 * Raw binary data (the star catalogue, the hangar HDR) ships base64-packed inside
 * JSON: some static hosts only serve web media types, and a .bin or .hdr file
 * would simply 404 there. Base64 costs a third more bytes (less after gzip) and a
 * few milliseconds to decode — cheap insurance for "runs anywhere".
 *
 * Key concepts: sRGB vs linear, mipmaps, anisotropic filtering, async loading,
 * base64 packing
 */
import {
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type DataTexture,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export interface PbrSet {
  diff: Texture;
  nor: Texture;
  rough: Texture;
}

export interface GameAssets {
  earthDay: Texture;
  earthNight: Texture;
  earthClouds: Texture;
  earthNormal: Texture;
  earthMask: Texture;
  moonColor: Texture;
  moonNormal: Texture;
  marsColor: Texture;
  marsNormal: Texture;
  milkyWay: Texture;
  water: Texture;
  stars: ArrayBuffer;
  pbr: Record<'grass' | 'sand' | 'concrete' | 'rock' | 'regolith', PbrSet>;
  vabHdr: DataTexture | null;
}

export type TextureQuality = 'standard' | 'high';

export function assetUrl(path: string): string {
  return new URL(`assets/${path}`, document.baseURI).href;
}

interface PackedBinary {
  bytes: number;
  data: string;
}

function isPackedBinary(v: unknown): v is PackedBinary {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.bytes === 'number' && typeof o.data === 'string';
}

/** Fetches a binary file stored base64-packed in JSON (written by tools/assets/build_assets.py). */
export async function fetchPacked(path: string): Promise<ArrayBuffer> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const doc: unknown = await res.json();
  if (!isPackedBinary(doc)) throw new Error(`${path}: not a packed binary`);
  const bin = atob(doc.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length !== doc.bytes) throw new Error(`${path}: expected ${doc.bytes} bytes, got ${bytes.length}`);
  return bytes.buffer;
}

export async function loadAssets(quality: TextureQuality, maxTextureSize: number, onProgress: (f: number, label: string) => void): Promise<GameAssets> {
  const loader = new TextureLoader();
  const hi = quality === 'high' && maxTextureSize >= 8192;
  const jobs: Array<{ key: string; url: string; srgb: boolean; repeat?: boolean }> = [
    { key: 'earthDay', url: hi ? 'earth/day_8k.jpg' : 'earth/day_4k.jpg', srgb: true },
    { key: 'earthNight', url: 'earth/night_4k.jpg', srgb: true },
    { key: 'earthClouds', url: hi ? 'earth/clouds_8k.jpg' : 'earth/clouds_4k.jpg', srgb: false },
    { key: 'earthNormal', url: 'earth/normal_4k.jpg', srgb: false },
    { key: 'earthMask', url: 'earth/coast_sdf_4k.png', srgb: false },
    { key: 'moonColor', url: 'moon/color_4k.jpg', srgb: true },
    { key: 'moonNormal', url: 'moon/normal_4k.jpg', srgb: false },
    { key: 'marsColor', url: 'mars/color_4k.jpg', srgb: true },
    { key: 'marsNormal', url: 'mars/normal_4k.jpg', srgb: false },
    { key: 'milkyWay', url: 'sky/milkyway_4k.jpg', srgb: true },
    { key: 'water', url: 'water/normal.png', srgb: false, repeat: true },
  ];
  const pbrNames = ['grass', 'sand', 'concrete', 'rock', 'regolith'] as const;
  for (const n of pbrNames) {
    jobs.push({ key: `pbr.${n}.diff`, url: `pbr/${n}_diff.jpg`, srgb: true, repeat: true });
    jobs.push({ key: `pbr.${n}.nor`, url: `pbr/${n}_nor.jpg`, srgb: false, repeat: true });
    jobs.push({ key: `pbr.${n}.rough`, url: `pbr/${n}_rough.jpg`, srgb: false, repeat: true });
  }
  const total = jobs.length + 2;
  let done = 0;
  const tick = (label: string) => {
    done++;
    onProgress(done / total, label);
  };
  const results = new Map<string, Texture>();
  await Promise.all(
    jobs.map(async (j) => {
      const t = await loader.loadAsync(assetUrl(j.url));
      t.colorSpace = j.srgb ? SRGBColorSpace : NoColorSpace;
      t.minFilter = LinearMipmapLinearFilter;
      t.anisotropy = 8;
      t.wrapS = RepeatWrapping;
      if (j.repeat) t.wrapT = RepeatWrapping;
      results.set(j.key, t);
      tick(j.url);
    }),
  );
  const stars = await fetchPacked('sky/stars.json');
  tick('stars');
  let vabHdr: DataTexture | null = null;
  try {
    vabHdr = new HDRLoader().createDataTexture(await fetchPacked('hdri/vab_1k.json'));
  } catch {
    vabHdr = null;
  }
  tick('hdri');
  const g = (k: string) => results.get(k)!;
  const pbr = {} as GameAssets['pbr'];
  for (const n of pbrNames) pbr[n] = { diff: g(`pbr.${n}.diff`), nor: g(`pbr.${n}.nor`), rough: g(`pbr.${n}.rough`) };
  return {
    earthDay: g('earthDay'),
    earthNight: g('earthNight'),
    earthClouds: g('earthClouds'),
    earthNormal: g('earthNormal'),
    earthMask: g('earthMask'),
    moonColor: g('moonColor'),
    moonNormal: g('moonNormal'),
    marsColor: g('marsColor'),
    marsNormal: g('marsNormal'),
    milkyWay: g('milkyWay'),
    water: g('water'),
    stars,
    pbr,
    vabHdr,
  };
}
