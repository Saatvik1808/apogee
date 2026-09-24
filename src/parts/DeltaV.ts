/**
 * LEARNING NOTE: Delta-v budgets and the Tsiolkovsky rocket equation
 *
 *     Δv = Isp · g0 · ln(m0 / m1)
 *
 * Δv ("delta-vee") is the currency of spaceflight: every manoeuvre costs a known
 * amount (≈9.4 km/s to low Earth orbit including gravity & drag losses, ≈3.1 km/s
 * more for trans-lunar injection, ≈1.7 km/s to land on the Moon...).
 *
 * With several engines of different Isp burning at once (boosters + core), the
 * effective Isp is total thrust / total mass-flow. Engines run dry at different
 * times, so we simulate each stage as a series of constant-flow SEGMENTS between
 * flame-outs, applying the rocket equation to each segment exactly.
 *
 * TWR (thrust-to-weight ratio) must exceed 1 at liftoff or the rocket never leaves
 * the pad; ~1.2–1.5 is typical — on the body you are launching from: the same
 * lander that barely hovers on Earth leaps off the Moon (g = 1.62 m/s²).
 *
 * Crossfeed (asparagus staging): boosters that feed the core through crossfeed
 * decouplers share one propellant pool, drained deepest-first. A stage then ends
 * when the tanks it is about to drop run dry — not when its engines flame out.
 * Canted engines only push along the axis with cos(cant), so they lose Δv.
 *
 * Which side of a decoupler falls away? In flight, control follows the command
 * module, so the analysis keeps the side that carries one — a rocket whose root
 * part sits at the bottom still drops its spent LOWER stage.
 *
 * Key concepts: rocket equation, effective exhaust velocity, mass flow, TWR,
 * gravity losses, stage segments, cosine losses, crossfeed
 */
import { Vector3 } from 'three';
import { G0 } from '../core/constants';
import type { CraftData, PartLayout } from './Craft';
import { loadedPropellant } from './PartCatalog';
import type { PropellantId } from './Propellants';

export interface SimEngine {
  thrustVac: number;
  thrustSL: number;
  ispVac: number;
  ispSL: number;
  propellant: PropellantId;
  solid: boolean;
  /** Fraction of the thrust along the vessel axis (cosine of the cant angle). */
  axial?: number;
}

export interface SimPart {
  uid: number;
  parent: number;
  dryMass: number;
  fuel: number;
  propellant: PropellantId | null;
  /** Fuel group id (crossfeed decouplers do not split groups). */
  group: number;
  /** Flow priority inside the group: deeper tanks drain first. */
  depth?: number;
  /** Command pod / probe core (the side of a separation that keeps flying). */
  command?: boolean;
  /** Decoupler that splits at another part (see FlightSim.separationPoint). */
  sepAt?: number;
  engine: SimEngine | null;
  stage: number;
  decoupler: boolean;
  ignited: boolean;
}

export interface StageInfo {
  stage: number;
  dvVac: number;
  dvSL: number;
  twrVac: number;
  twrSL: number;
  burnTime: number;
  startMass: number;
  endMass: number;
  thrustVac: number;
  thrustSL: number;
}

/** Fuel groups and flow depth for a laid-out craft (mirrors Vessel.computeGroups). */
function fuelGroups(layout: Map<number, PartLayout>): Map<number, { group: number; depth: number }> {
  const out = new Map<number, { group: number; depth: number }>();
  let root: PartLayout | undefined;
  for (const l of layout.values()) if (l.part.parent === -1) root = l;
  if (!root) return out;
  let next = 0;
  const visit = (uid: number, group: number, depth: number) => {
    out.set(uid, { group, depth });
    const l = layout.get(uid);
    if (!l) return;
    for (const ch of l.children) {
      const cl = layout.get(ch);
      if (!cl) continue;
      if (!cl.def.decoupler) visit(ch, group, depth);
      else if (cl.part.config.crossfeed) visit(ch, group, depth + 1);
      else visit(ch, ++next, 0);
    }
  };
  visit(root.uid, 0, 0);
  return out;
}

const _axis = new Vector3();

/** Propellant below this (kg) counts as empty: rounding crumbs must not stall the analysis. */
const FUEL_EPS = 1e-6;

export function simPartsFromLayout(_c: CraftData, layout: Map<number, PartLayout>): SimPart[] {
  const groups = fuelGroups(layout);
  const out: SimPart[] = [];
  for (const l of layout.values()) {
    const s = l.stats;
    const isEngine = l.def.shape === 'engine' || l.def.shape === 'srb';
    const fg = groups.get(l.uid);
    out.push({
      uid: l.uid,
      parent: l.part.parent,
      dryMass: s.dryMass,
      fuel: loadedPropellant(s, l.part.config),
      propellant: s.propellant && s.propellantCapacity > 0 ? s.propellant : null,
      group: fg?.group ?? 0,
      depth: fg?.depth ?? 0,
      command: !!l.def.command,
      engine: isEngine
        ? {
            thrustVac: s.thrustVac,
            thrustSL: s.thrustSL,
            ispVac: s.ispVac,
            ispSL: s.ispSL,
            propellant: s.propellant ?? 'kerolox',
            solid: l.def.shape === 'srb',
            axial: Math.abs(_axis.set(0, 1, 0).applyQuaternion(l.rotation).y),
          }
        : null,
      stage: l.part.stage,
      decoupler: !!l.def.decoupler,
      sepAt: l.def.decoupler && !l.def.decoupler.radial && l.part.attach === 'above' ? l.children.find((u) => layout.get(u)?.part.attach === 'above') : undefined,
      ignited: false,
    });
  }
  return out;
}

/**
 * Stage-by-stage Δv analysis.
 * @param nextStage index of the next stage to activate (0 on the pad)
 * @param gSurface gravity for TWR (m/s²)
 * @param ambient outside pressure for the "SL" figures as a fraction of Earth's
 *   sea level (1 Earth, ≈0.006 Mars, 0 Moon)
 */
export function analyzeStages(parts: SimPart[], nextStage: number, gSurface: number, ambient = 1): StageInfo[] {
  const byUid = new Map<number, SimPart>();
  const children = new Map<number, number[]>();
  for (const p of parts) {
    byUid.set(p.uid, p);
    const arr = children.get(p.parent);
    if (arr) arr.push(p.uid);
    else children.set(p.parent, [p.uid]);
  }
  const attached = new Set(parts.map((p) => p.uid));
  const fuel = new Map(parts.map((p) => [p.uid, p.fuel] as const));
  const ignited = new Set(parts.filter((p) => p.ignited && p.engine).map((p) => p.uid));
  const maxStage = parts.reduce((m, p) => Math.max(m, p.stage), -1);

  const subtree = (uid: number, out: Set<number>) => {
    const stack = [uid];
    while (stack.length) {
      const u = stack.pop()!;
      if (attached.has(u)) out.add(u);
      for (const ch of children.get(u) ?? []) stack.push(ch);
    }
  };
  /**
   * Parts a decoupler throws away: normally everything beyond it (away from the
   * root), but if only that side carries a command part, control follows it and
   * the root side is what gets dropped.
   */
  const droppedBy = (uid: number, out: Set<number>) => {
    const beyond = new Set<number>();
    subtree(byUid.get(uid)?.sepAt ?? uid, beyond);
    let beyondCmd = false;
    let restCmd = false;
    for (const u of attached) {
      if (!byUid.get(u)!.command) continue;
      if (beyond.has(u)) beyondCmd = true;
      else restCmd = true;
    }
    if (beyondCmd && !restCmd) {
      for (const u of attached) if (!beyond.has(u)) out.add(u);
    } else for (const u of beyond) out.add(u);
  };
  const detach = (uid: number) => {
    const gone = new Set<number>();
    droppedBy(uid, gone);
    for (const u of gone) attached.delete(u);
  };
  const mass = () => {
    let m = 0;
    for (const u of attached) {
      const p = byUid.get(u)!;
      m += p.dryMass + (fuel.get(u) ?? 0);
    }
    return m;
  };
  const fuelKey = (p: SimPart) => (p.engine!.solid ? `s${p.uid}` : `g${p.group}:${p.engine!.propellant}`);
  /** Attached tanks feeding a liquid engine that still hold propellant. */
  const pool = (p: SimPart): SimPart[] => {
    const out: SimPart[] = [];
    for (const u of attached) {
      const q = byUid.get(u)!;
      if (q.group === p.group && q.propellant === p.engine!.propellant && !q.engine?.solid && (fuel.get(u) ?? 0) > FUEL_EPS) out.push(q);
    }
    return out;
  };
  const fuelAvailable = (p: SimPart): number => {
    if (p.engine!.solid) {
      const f = fuel.get(p.uid) ?? 0;
      return f > FUEL_EPS ? f : 0;
    }
    let f = 0;
    for (const q of pool(p)) f += fuel.get(q.uid) ?? 0;
    return f;
  };
  /** The tanks an engine is draining right now: the deepest non-empty flow level. */
  const topLevel = (p: SimPart): SimPart[] => {
    const tanks = pool(p);
    let deepest = -1;
    for (const q of tanks) deepest = Math.max(deepest, q.depth ?? 0);
    return tanks.filter((q) => (q.depth ?? 0) === deepest);
  };
  const levelFuel = (p: SimPart): number => {
    if (p.engine!.solid) return fuel.get(p.uid) ?? 0;
    let f = 0;
    for (const q of topLevel(p)) f += fuel.get(q.uid) ?? 0;
    return f;
  };
  const drain = (p: SimPart, amount: number) => {
    if (p.engine!.solid) {
      const left = (fuel.get(p.uid) ?? 0) - amount;
      fuel.set(p.uid, left > FUEL_EPS ? left : 0);
      return;
    }
    let need = amount;
    for (let guard = 0; guard < 8 && need > 1e-9; guard++) {
      const tanks = topLevel(p);
      let total = 0;
      for (const q of tanks) total += fuel.get(q.uid) ?? 0;
      if (total <= 0) return;
      const take = Math.min(need, total);
      for (const q of tanks) {
        const f = fuel.get(q.uid)!;
        const left = f - (take * f) / total;
        fuel.set(q.uid, left > FUEL_EPS ? left : 0);
      }
      need -= take;
    }
  };
  /** Is the engine burning propellant that the next stage will throw away? */
  const drawsFrom = (p: SimPart, set: Set<number>): boolean => {
    if (p.engine!.solid) return set.has(p.uid);
    return topLevel(p).some((q) => set.has(q.uid));
  };
  const ispAt = (e: SimEngine) => e.ispVac - (e.ispVac - e.ispSL) * ambient;

  const results: StageInfo[] = [];
  const first = nextStage > 0 ? nextStage - 1 : 0;
  for (let s = first; s <= maxStage; s++) {
    if (s >= nextStage) {
      for (const p of parts) {
        if (p.stage !== s || !attached.has(p.uid)) continue;
        if (p.decoupler) detach(p.uid);
      }
      for (const p of parts) {
        if (p.stage === s && p.engine && attached.has(p.uid)) ignited.add(p.uid);
      }
    }
    // Engines dropped by the NEXT stage's decouplers: burn until they're dry
    const dropNext = new Set<number>();
    for (const p of parts) {
      if (p.stage === s + 1 && p.decoupler && attached.has(p.uid)) droppedBy(p.uid, dropNext);
    }
    const info: StageInfo = {
      stage: s,
      dvVac: 0,
      dvSL: 0,
      twrVac: 0,
      twrSL: 0,
      burnTime: 0,
      startMass: mass(),
      endMass: 0,
      thrustVac: 0,
      thrustSL: 0,
    };
    let firstSeg = true;
    for (let iter = 0; iter < 64; iter++) {
      const active: SimPart[] = [];
      for (const u of ignited) {
        if (!attached.has(u)) continue;
        const p = byUid.get(u)!;
        if (fuelAvailable(p) > 1e-6) active.push(p);
      }
      if (!active.length) break;
      const dropBurning = dropNext.size > 0 && active.some((p) => drawsFrom(p, dropNext));
      if (dropNext.size && !dropBurning && !firstSeg) break;
      if (dropNext.size && !dropBurning && firstSeg) {
        // The next stage drops nothing that is burning — burn everything this stage.
        dropNext.clear();
      }
      const rates = new Map<string, { rate: number; fuel: number }>();
      let fVac = 0;
      let fSL = 0;
      let mdot = 0;
      for (const p of active) {
        const e = p.engine!;
        const m = e.thrustVac / (e.ispVac * G0);
        const key = fuelKey(p);
        const r = rates.get(key);
        if (r) r.rate += m;
        else rates.set(key, { rate: m, fuel: levelFuel(p) });
        const ax = e.axial ?? 1;
        fVac += e.thrustVac * ax;
        fSL += e.thrustVac * (ispAt(e) / e.ispVac) * ax;
        mdot += m;
      }
      let tSeg = Infinity;
      for (const r of rates.values()) tSeg = Math.min(tSeg, r.fuel / r.rate);
      if (!isFinite(tSeg) || tSeg <= 0) break;
      const m0 = mass();
      if (firstSeg) {
        info.twrVac = fVac / (m0 * gSurface);
        info.twrSL = fSL / (m0 * gSurface);
        info.thrustVac = fVac;
        info.thrustSL = fSL;
        firstSeg = false;
      }
      const m1 = m0 - mdot * tSeg;
      if (m1 <= 0) break;
      const lnr = Math.log(m0 / m1);
      info.dvVac += (fVac / mdot) * lnr;
      info.dvSL += (fSL / mdot) * lnr;
      info.burnTime += tSeg;
      for (const p of active) {
        const e = p.engine!;
        drain(p, (e.thrustVac / (e.ispVac * G0)) * tSeg);
      }
    }
    info.endMass = mass();
    results.push(info);
  }
  return results;
}

export function totalDv(stages: StageInfo[], vacuum = true): number {
  return stages.reduce((s, x) => s + (vacuum ? x.dvVac : x.dvSL), 0);
}
