/**
 * LEARNING NOTE: Staging — throwing away mass to go faster
 *
 * The rocket equation Δv = Isp·g0·ln(m0/m1) punishes carrying empty tanks. Staging
 * drops spent structure so the remaining engines push less mass. A decoupler
 * splits the part tree: everything on its far side falls away.
 *
 * We split the craft into SECTIONS — groups of parts connected without crossing a
 * decoupler. A section is also a FUEL GROUP: its engines drink from its tanks.
 * Auto-staging walks the section tree bottom-up:
 *   1. lowest core section lights its engines (plus any radial boosters on it)
 *   2. boosters are released once burnt out
 *   3. the separator above fires while the next section's engines ignite
 *   4. fairings go once the upper stage is running; parachutes come last.
 *
 * Key concepts: staging, fuel crossfeed, connected components, section trees
 */
import type { CraftData, PartLayout } from './Craft';
import { rootPart } from './Craft';

export type SectionKind = 'root' | 'stack-below' | 'stack-above' | 'radial';

export interface Section {
  id: number;
  parts: number[];
  /** Decoupler uid that separates this section from its parent (-1 for root). */
  separator: number;
  parent: Section | null;
  children: Section[];
  kind: SectionKind;
}

export interface SectionMap {
  sections: Section[];
  sectionOf: Map<number, Section>;
}

export function computeSections(c: CraftData, layout: Map<number, PartLayout>): SectionMap {
  const sections: Section[] = [];
  const sectionOf = new Map<number, Section>();
  const root = rootPart(c);
  if (!root) return { sections, sectionOf };
  const rootSec: Section = { id: 0, parts: [], separator: -1, parent: null, children: [], kind: 'root' };
  sections.push(rootSec);
  const visit = (uid: number, sec: Section) => {
    const lay = layout.get(uid);
    if (!lay) return;
    let cur = sec;
    if (lay.def.decoupler && uid !== root.uid) {
      const kind: SectionKind = lay.def.decoupler.radial || lay.part.attach === 'radial'
        ? 'radial'
        : lay.part.attach === 'above'
          ? 'stack-above'
          : 'stack-below';
      cur = { id: sections.length, parts: [], separator: uid, parent: sec, children: [], kind };
      sections.push(cur);
      sec.children.push(cur);
    }
    cur.parts.push(uid);
    sectionOf.set(uid, cur);
    for (const ch of lay.children) visit(ch, cur);
  };
  visit(root.uid, rootSec);
  return { sections, sectionOf };
}

function isEngine(l: PartLayout): boolean {
  return l.def.shape === 'engine' || l.def.shape === 'srb';
}

function allEnginesIn(sec: Section, layout: Map<number, PartLayout>, out: number[]): void {
  for (const u of sec.parts) {
    const l = layout.get(u);
    if (l && isEngine(l)) out.push(u);
  }
  for (const ch of sec.children) allEnginesIn(ch, layout, out);
}

/** Compute the default staging sequence (arrays of part uids in firing order). */
export function planStages(c: CraftData, layout: Map<number, PartLayout>): number[][] {
  const { sections } = computeSections(c, layout);
  const root = sections[0];
  if (!root) return [];
  const plan = (sec: Section): number[][] => {
    const seq: number[][] = [];
    const engines = sec.parts.filter((u) => {
      const l = layout.get(u);
      return !!l && isEngine(l);
    });
    const lowers = sec.children.filter((k) => k.kind === 'stack-below');
    const radials = sec.children.filter((k) => k.kind === 'radial');
    const aboves = sec.children.filter((k) => k.kind === 'stack-above');
    const boosterEngines: number[] = [];
    for (const r of radials) allEnginesIn(r, layout, boosterEngines);
    const ignition = [...engines, ...boosterEngines];
    if (lowers.length) {
      for (const lo of lowers) seq.push(...plan(lo));
      seq.push([...lowers.map((l) => l.separator), ...ignition]);
    } else {
      seq.push(ignition);
    }
    if (radials.length) {
      const seps: number[] = [];
      const inner = (s: Section) => {
        seps.push(s.separator);
        for (const ch of s.children) inner(ch);
      };
      for (const r of radials) inner(r);
      seq.push(seps);
    }
    const fairings = sec.parts.filter((u) => layout.get(u)?.def.fairing);
    if (fairings.length) seq.push(fairings);
    for (const ab of aboves) {
      const abEngines: number[] = [];
      allEnginesIn(ab, layout, abEngines);
      seq.push([ab.separator, ...abEngines]);
    }
    return seq;
  };
  const seq = plan(root);
  const chutes: number[] = [];
  for (const l of layout.values()) if (l.def.parachute) chutes.push(l.uid);
  if (chutes.length) seq.push(chutes);
  return seq.filter((s) => s.length > 0);
}

/** Assign `stage` on every craft part from the automatic plan. */
export function applyAutoStaging(c: CraftData, layout: Map<number, PartLayout>): void {
  const seq = planStages(c, layout);
  for (const p of c.parts) p.stage = -1;
  seq.forEach((uids, i) => {
    for (const u of uids) {
      const p = c.parts.find((q) => q.uid === u);
      if (p) p.stage = i;
    }
  });
}

/** Staging arrays from the stored `stage` fields (compacted, firing order). */
export function stagesFromCraft(c: CraftData): number[][] {
  const max = c.parts.reduce((m, p) => Math.max(m, p.stage), -1);
  const out: number[][] = [];
  for (let i = 0; i <= max; i++) {
    const s = c.parts.filter((p) => p.stage === i).map((p) => p.uid);
    if (s.length) out.push(s);
  }
  return out;
}

/** Parts that participate in staging. */
export function isStageable(l: PartLayout): boolean {
  return isEngine(l) || !!l.def.decoupler || !!l.def.parachute || !!l.def.fairing;
}

/** Ensure every stageable part has a stage and there are no gaps (after manual edits). */
export function normalizeStaging(c: CraftData, layout: Map<number, PartLayout>): void {
  if (!c.manualStaging) {
    applyAutoStaging(c, layout);
    return;
  }
  // Add unassigned stageable parts to a new last stage
  const orphans: number[] = [];
  for (const l of layout.values()) if (isStageable(l) && l.part.stage < 0) orphans.push(l.uid);
  for (const p of c.parts) {
    const l = layout.get(p.uid);
    if (l && !isStageable(l)) p.stage = -1;
  }
  const compact = stagesFromCraft(c);
  compact.forEach((s, i) => s.forEach((u) => (c.parts.find((p) => p.uid === u)!.stage = i)));
  if (orphans.length) {
    const next = compact.length;
    for (const u of orphans) c.parts.find((p) => p.uid === u)!.stage = next;
  }
}
