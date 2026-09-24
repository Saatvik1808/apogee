/**
 * LEARNING NOTE: Sharing designs as text
 *
 * A rocket design is a small tree of parts, so it serialises to a few kilobytes
 * of JSON. To paste it into a chat message we compress it (DEFLATE — the same
 * algorithm as ZIP files, built into browsers as `CompressionStream`) and encode
 * the bytes as base64url text: three bytes become four characters from a
 * 64-letter alphabet that survives copy-paste anywhere. A short prefix records
 * the format version, so older codes stay readable when the format changes.
 *
 * Anything pasted in is UNTRUSTED input. It is rebuilt field by field into a
 * fresh object (unknown keys dropped, every number range-checked — a cluster of
 * thirty million engines or a stage number of two billion would freeze the
 * game), checked structurally (known parts, one root, every parent present, no
 * cycles) and finally laid out and analysed once inside try/catch. Only a design
 * that survives all of that reaches the editor — a bad code must never crash the
 * game, and must never end up saved as the "last design" that reopens next time.
 *
 * Key concepts: serialisation, lossless compression, base64, input validation,
 * allow-listing, defence in depth
 */
import { layoutCraft, type AttachKind, type CraftData, type CraftPart } from '../parts/Craft';
import { analyzeStages, simPartsFromLayout } from '../parts/DeltaV';
import { PART_MAP, type PartConfig } from '../parts/PartCatalog';
import { LIQUID_PROPELLANTS, type PropellantId } from '../parts/Propellants';

/** DEFLATE-compressed JSON, base64url. */
const PREFIX_Z = 'APG1:';
/** Plain JSON, base64url (browsers without CompressionStream). */
const PREFIX_J = 'APG0:';
const MAX_PARTS = 1000;
const MAX_UID = 1_000_000;
const MAX_CODE_LENGTH = 2_000_000;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function transform(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const isNum = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const isVec3 = (x: unknown, lim: number): x is [number, number, number] => Array.isArray(x) && x.length === 3 && x.every((v) => isNum(v, -lim, lim));

/** A clean copy of a part configuration (unknown keys dropped), or null if a field is invalid. */
function cleanConfig(raw: unknown): PartConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const out: PartConfig = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(c, k) && c[k] !== undefined && c[k] !== null;
  if (has('diameter')) {
    if (!isNum(c.diameter, 0.1, 20)) return null;
    out.diameter = c.diameter;
  }
  if (has('diameterBottom')) {
    if (!isNum(c.diameterBottom, 0.1, 20)) return null;
    out.diameterBottom = c.diameterBottom;
  }
  if (has('length')) {
    if (!isNum(c.length, 0.1, 200)) return null;
    out.length = c.length;
  }
  if (has('propellant')) {
    const p = c.propellant;
    if (typeof p !== 'string' || !(LIQUID_PROPELLANTS as string[]).includes(p)) return null;
    out.propellant = p as PropellantId;
  }
  if (has('cluster')) {
    if (!isInt(c.cluster, 1, 32)) return null;
    out.cluster = c.cluster;
  }
  if (has('thrustLimit')) {
    if (!isNum(c.thrustLimit, 0, 1)) return null;
    out.thrustLimit = c.thrustLimit;
  }
  if (has('canopies')) {
    if (!isInt(c.canopies, 1, 8)) return null;
    out.canopies = c.canopies;
  }
  if (has('fill')) {
    if (!isNum(c.fill, 0, 1)) return null;
    out.fill = c.fill;
  }
  if (has('gimbalLock')) {
    if (typeof c.gimbalLock !== 'boolean') return null;
    out.gimbalLock = c.gimbalLock;
  }
  if (has('deployAlt')) {
    if (!isNum(c.deployAlt, 0, 100_000)) return null;
    out.deployAlt = c.deployAlt;
  }
  if (has('groups')) {
    const g = c.groups;
    if (!Array.isArray(g) || g.length > 10 || !g.every((n) => isInt(n, 1, 10))) return null;
    out.groups = [...new Set(g as number[])].sort((a, b) => a - b);
  }
  if (has('crossfeed')) {
    if (typeof c.crossfeed !== 'boolean') return null;
    out.crossfeed = c.crossfeed;
  }
  if (has('offset')) {
    if (!isVec3(c.offset, 100)) return null;
    out.offset = [c.offset[0], c.offset[1], c.offset[2]];
  }
  if (has('rot')) {
    if (!isVec3(c.rot, 360)) return null;
    out.rot = [c.rot[0], c.rot[1], c.rot[2]];
  }
  return out;
}

/**
 * Rebuild an untrusted design field by field: known parts only, sane numbers,
 * unique uids, exactly one root and every part connected to it without cycles.
 * Returns a fresh, clean object or null.
 */
export function cleanCraft(raw: unknown): CraftData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.version !== 1 || !Array.isArray(d.parts) || d.parts.length === 0 || d.parts.length > MAX_PARTS) return null;
  const parts: CraftPart[] = [];
  const uids = new Set<number>();
  let roots = 0;
  let maxUid = 0;
  let maxSym = 0;
  for (const item of d.parts as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const p = item as Record<string, unknown>;
    const { uid, parent, attach, angle, offsetY, symmetry, stage, defId } = p;
    if (typeof defId !== 'string' || !PART_MAP.has(defId)) return null;
    if (!isInt(uid, 1, MAX_UID) || uids.has(uid)) return null;
    if (!(parent === -1 || isInt(parent, 1, MAX_UID)) || parent === uid) return null;
    if (attach !== 'root' && attach !== 'below' && attach !== 'above' && attach !== 'radial') return null;
    if ((attach === 'root') !== (parent === -1)) return null;
    if (!isNum(angle, -1e3, 1e3) || !isNum(offsetY, -1e3, 1e3) || !isInt(symmetry, 0, MAX_UID) || !isInt(stage, -1, 999)) return null;
    const config = cleanConfig(p.config);
    if (!config) return null;
    uids.add(uid);
    if (parent === -1) roots++;
    maxUid = Math.max(maxUid, uid);
    maxSym = Math.max(maxSym, symmetry);
    parts.push({ uid, defId, parent: parent as number, attach: attach as AttachKind, angle, offsetY, symmetry, config, stage });
  }
  if (roots !== 1) return null;
  // Every parent exists and following parents always reaches the root (no cycles)
  const byUid = new Map(parts.map((p) => [p.uid, p] as const));
  for (const p of parts) {
    let q = p;
    for (let i = 0; q.parent !== -1; i++) {
      const next = byUid.get(q.parent);
      if (!next || i > parts.length) return null;
      q = next;
    }
  }
  const name = typeof d.name === 'string' ? d.name.slice(0, 40).trim() : '';
  return {
    version: 1,
    name: name || 'Imported Rocket',
    description: typeof d.description === 'string' ? d.description.slice(0, 500) : '',
    parts,
    nextUid: maxUid + 1,
    nextSymmetry: maxSym + 1,
    manualStaging: d.manualStaging === true,
  };
}

/** True if a design lays out and analyses without errors (the editor can open it). */
export function craftWorks(c: CraftData): boolean {
  try {
    const lay = layoutCraft(c);
    if (lay.size !== c.parts.length) return false;
    for (const l of lay.values()) if (!Number.isFinite(l.position.x + l.position.y + l.position.z) || !Number.isFinite(l.stats.dryMass)) return false;
    const st = analyzeStages(simPartsFromLayout(c, lay), 0, 9.80665);
    return st.every((x) => Number.isFinite(x.dvVac));
  } catch {
    return false;
  }
}

/** Encode a design as a shareable text code. */
export async function encodeCraft(c: CraftData): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  if (typeof CompressionStream !== 'undefined') {
    try {
      return PREFIX_Z + toBase64Url(await transform(bytes, new CompressionStream('deflate-raw')));
    } catch {
      /* fall through to the uncompressed form */
    }
  }
  return PREFIX_J + toBase64Url(bytes);
}

/** Decode a pasted code (or raw design JSON); null if it is not a valid, working design. */
export async function decodeCraft(code: string): Promise<CraftData | null> {
  if (code.length > MAX_CODE_LENGTH) return null;
  const s = code.replace(/\s+/g, '');
  try {
    let json: string;
    if (s.startsWith(PREFIX_Z)) {
      if (typeof DecompressionStream === 'undefined') return null;
      json = new TextDecoder().decode(await transform(fromBase64Url(s.slice(PREFIX_Z.length)), new DecompressionStream('deflate-raw')));
    } else if (s.startsWith(PREFIX_J)) {
      json = new TextDecoder().decode(fromBase64Url(s.slice(PREFIX_J.length)));
    } else if (code.trim().startsWith('{')) {
      json = code.trim();
    } else return null;
    if (json.length > MAX_CODE_LENGTH * 4) return null;
    const c = cleanCraft(JSON.parse(json) as unknown);
    return c && craftWorks(c) ? c : null;
  } catch {
    return null;
  }
}
