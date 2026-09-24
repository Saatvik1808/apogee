/**
 * LEARNING NOTE: A rocket is a tree
 *
 * Each part hangs off exactly one parent: stacked below it, stacked above it, or
 * mounted radially on its side. Storing *relative* attachments (not absolute
 * coordinates) means that when you lengthen a tank, everything below slides down
 * automatically — we just re-run the layout pass from the root.
 *
 * Layout rules (vessel frame: +Y is the nose, origin at the root part's centre):
 *   below  : child.top meets parent.bottom  → y -= (hp + hc) / 2
 *   above  : child.bottom meets parent.top  → y += (hp + hc) / 2
 *   radial : rotate by `angle` about the parent's axis, then push outwards by the
 *            parent's surface radius plus the child's own inner offset.
 *
 * Symmetry groups tie radially mounted copies together so edits apply to all.
 *
 * Key concepts: scene trees, relative transforms, symmetry, serialisation
 */
import { Quaternion, Vector3 } from 'three';
import {
  computePartStats,
  defaultConfig,
  getPartDef,
  surfaceRadiusAt,
  type PartConfig,
  type PartDef,
  type PartStats,
} from './PartCatalog';

export type AttachKind = 'root' | 'below' | 'above' | 'radial';

export interface CraftPart {
  uid: number;
  defId: string;
  /** Parent uid, or -1 for the root. */
  parent: number;
  attach: AttachKind;
  /** Radial: angle around the parent axis (rad). */
  angle: number;
  /** Radial: offset along the parent axis from its centre (m). */
  offsetY: number;
  /** Symmetry group id (0 = none). */
  symmetry: number;
  config: PartConfig;
  /** Activation stage index in firing order (-1 = not staged). */
  stage: number;
}

export interface CraftData {
  version: 1;
  name: string;
  description: string;
  parts: CraftPart[];
  nextUid: number;
  nextSymmetry: number;
  /** True when the player edited staging manually (auto-staging disabled). */
  manualStaging: boolean;
}

export interface PartLayout {
  uid: number;
  part: CraftPart;
  def: PartDef;
  stats: PartStats;
  /** Centre position in the vessel frame. */
  position: Vector3;
  rotation: Quaternion;
  children: number[];
  /** Radius of the parent surface used for radial mounting (for UI gizmos). */
  depth: number;
}

export function createEmptyCraft(name = 'Untitled Rocket'): CraftData {
  return { version: 1, name, description: '', parts: [], nextUid: 1, nextSymmetry: 1, manualStaging: false };
}

export function cloneCraft(c: CraftData): CraftData {
  return JSON.parse(JSON.stringify(c)) as CraftData;
}

export function findPart(c: CraftData, uid: number): CraftPart | undefined {
  return c.parts.find((p) => p.uid === uid);
}

export function rootPart(c: CraftData): CraftPart | undefined {
  return c.parts.find((p) => p.parent === -1);
}

export function childrenOf(c: CraftData, uid: number): CraftPart[] {
  return c.parts.filter((p) => p.parent === uid);
}

/** uid and all descendants. */
export function subtreeUids(c: CraftData, uid: number): number[] {
  const out: number[] = [];
  const stack = [uid];
  while (stack.length) {
    const u = stack.pop()!;
    out.push(u);
    for (const p of c.parts) if (p.parent === u) stack.push(p.uid);
  }
  return out;
}

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);

/** Distance from a radially mounted part's centre to the surface it sits on. */
export function radialInnerOffset(def: PartDef, stats: PartStats): number {
  switch (def.shape) {
    case 'fin':
    case 'solar':
      return 0.02;
    case 'leg':
      return 0.18;
    case 'radial-decoupler':
      return 0.2;
    case 'radial-chute':
      return def.diameter / 2;
    case 'engine':
      return Math.max(stats.diameterTop, stats.diameterBottom) / 2;
    default:
      return Math.max(stats.diameterTop, stats.diameterBottom) / 2;
  }
}

export function layoutCraft(c: CraftData): Map<number, PartLayout> {
  const out = new Map<number, PartLayout>();
  const root = rootPart(c);
  if (!root) return out;
  const byParent = new Map<number, CraftPart[]>();
  for (const p of c.parts) {
    const arr = byParent.get(p.parent);
    if (arr) arr.push(p);
    else byParent.set(p.parent, [p]);
  }
  const place = (p: CraftPart, parent: PartLayout | null, depth: number) => {
    const def = getPartDef(p.defId);
    const stats = computePartStats(def, p.config);
    const position = new Vector3();
    const rotation = new Quaternion();
    if (parent) {
      const ph = parent.stats.height;
      const ch = stats.height;
      if (p.attach === 'below') {
        rotation.copy(parent.rotation);
        position.set(0, -(ph + ch) / 2, 0).applyQuaternion(parent.rotation).add(parent.position);
      } else if (p.attach === 'above') {
        rotation.copy(parent.rotation);
        position.set(0, (ph + ch) / 2, 0).applyQuaternion(parent.rotation).add(parent.position);
      } else {
        const qa = new Quaternion().setFromAxisAngle(Y, p.angle);
        rotation.copy(parent.rotation).multiply(qa);
        const outward = X.clone().applyQuaternion(rotation);
        const pr = surfaceRadiusAt(parent.def, parent.stats, p.offsetY);
        position
          .set(0, p.offsetY, 0)
          .applyQuaternion(parent.rotation)
          .add(parent.position)
          .addScaledVector(outward, pr + radialInnerOffset(def, stats));
      }
    }
    const lay: PartLayout = { uid: p.uid, part: p, def, stats, position, rotation, children: [], depth };
    out.set(p.uid, lay);
    if (parent) parent.children.push(p.uid);
    for (const ch of byParent.get(p.uid) ?? []) place(ch, lay, depth + 1);
  };
  place(root, null, 0);
  return out;
}

/** Axis-aligned bounds of the laid-out craft (vessel frame). */
export function craftBounds(layout: Map<number, PartLayout>): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const l of layout.values()) {
    const r = Math.max(l.stats.diameterTop, l.stats.diameterBottom, 0.3) / 2;
    const h = l.stats.height / 2;
    let ext = r;
    if (l.def.shape === 'fin' && l.def.fin) ext = l.def.fin.span;
    if (l.def.shape === 'leg' && l.def.legs) ext = l.def.legs.length * 0.6;
    min.x = Math.min(min.x, l.position.x - ext);
    min.y = Math.min(min.y, l.position.y - h - (l.def.shape === 'leg' ? l.def.legs!.length * 0.4 : 0));
    min.z = Math.min(min.z, l.position.z - ext);
    max.x = Math.max(max.x, l.position.x + ext);
    max.y = Math.max(max.y, l.position.y + h);
    max.z = Math.max(max.z, l.position.z + ext);
  }
  if (!isFinite(min.x)) {
    min.set(-1, -1, -1);
    max.set(1, 1, 1);
  }
  return { min, max };
}

export function newPart(c: CraftData, defId: string, parent: number, attach: AttachKind, cfg?: PartConfig): CraftPart {
  const def = getPartDef(defId);
  const part: CraftPart = {
    uid: c.nextUid++,
    defId,
    parent,
    attach,
    angle: 0,
    offsetY: 0,
    symmetry: 0,
    config: cfg ? { ...cfg } : defaultConfig(def),
    stage: -1,
  };
  return part;
}

/** Deep-copy a subtree with fresh uids, re-parented to `newParent`. Returns the new root uid. */
export function duplicateSubtree(c: CraftData, uid: number, newParent: number, symmetry = 0): number {
  const ids = subtreeUids(c, uid);
  const map = new Map<number, number>();
  for (const id of ids) map.set(id, c.nextUid++);
  const created: CraftPart[] = [];
  for (const id of ids) {
    const src = findPart(c, id)!;
    const copy: CraftPart = JSON.parse(JSON.stringify(src)) as CraftPart;
    copy.uid = map.get(id)!;
    copy.parent = id === uid ? newParent : map.get(src.parent)!;
    if (id === uid && symmetry) copy.symmetry = symmetry;
    created.push(copy);
  }
  c.parts.push(...created);
  return map.get(uid)!;
}

export function removeSubtree(c: CraftData, uid: number): CraftPart[] {
  const ids = new Set(subtreeUids(c, uid));
  const removed = c.parts.filter((p) => ids.has(p.uid));
  c.parts = c.parts.filter((p) => !ids.has(p.uid));
  return removed;
}

/** Other members of a part's symmetry group. */
export function symmetryCounterparts(c: CraftData, part: CraftPart): CraftPart[] {
  if (!part.symmetry) return [];
  return c.parts.filter((p) => p.symmetry === part.symmetry && p.uid !== part.uid);
}

export function totalCost(layout: Map<number, PartLayout>): number {
  let cost = 0;
  for (const l of layout.values()) cost += l.stats.cost;
  return cost;
}

export function serializeCraft(c: CraftData): string {
  return JSON.stringify(c);
}

export function deserializeCraft(s: string): CraftData | null {
  try {
    const d = JSON.parse(s) as CraftData;
    if (d.version !== 1 || !Array.isArray(d.parts)) return null;
    for (const p of d.parts) getPartDef(p.defId);
    return d;
  } catch {
    return null;
  }
}
