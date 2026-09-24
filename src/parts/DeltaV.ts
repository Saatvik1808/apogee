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
 * the pad; ~1.2–1.5 is typical.
 *
 * Key concepts: rocket equation, effective exhaust velocity, mass flow, TWR,
 * gravity losses, stage segments
 */
import { G0 } from '../core/constants';
import type { CraftData, PartLayout } from './Craft';
import type { PropellantId } from './Propellants';
import { computeSections } from './Staging';

export interface SimEngine {
  thrustVac: number;
  thrustSL: number;
  ispVac: number;
  ispSL: number;
  propellant: PropellantId;
  solid: boolean;
}

export interface SimPart {
  uid: number;
  parent: number;
  dryMass: number;
  fuel: number;
  propellant: PropellantId | null;
  /** Fuel group (section) id. */
  group: number;
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

export function simPartsFromLayout(c: CraftData, layout: Map<number, PartLayout>): SimPart[] {
  const { sectionOf } = computeSections(c, layout);
  const out: SimPart[] = [];
  for (const l of layout.values()) {
    const s = l.stats;
    const isEngine = l.def.shape === 'engine' || l.def.shape === 'srb';
    out.push({
      uid: l.uid,
      parent: l.part.parent,
      dryMass: s.dryMass,
      fuel: s.propellantCapacity,
      propellant: s.propellant && s.propellantCapacity > 0 ? s.propellant : null,
      group: sectionOf.get(l.uid)?.id ?? 0,
      engine: isEngine
        ? {
            thrustVac: s.thrustVac,
            thrustSL: s.thrustSL,
            ispVac: s.ispVac,
            ispSL: s.ispSL,
            propellant: s.propellant ?? 'kerolox',
            solid: l.def.shape === 'srb',
          }
        : null,
      stage: l.part.stage,
      decoupler: !!l.def.decoupler,
      ignited: false,
    });
  }
  return out;
}

/**
 * Stage-by-stage Δv analysis.
 * @param nextStage index of the next stage to activate (0 on the pad)
 * @param gSurface gravity for TWR (m/s²)
 */
export function analyzeStages(parts: SimPart[], nextStage: number, gSurface: number): StageInfo[] {
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

  const detach = (uid: number) => {
    const stack = [uid];
    while (stack.length) {
      const u = stack.pop()!;
      attached.delete(u);
      for (const ch of children.get(u) ?? []) stack.push(ch);
    }
  };
  const subtree = (uid: number, out: Set<number>) => {
    const stack = [uid];
    while (stack.length) {
      const u = stack.pop()!;
      out.add(u);
      for (const ch of children.get(u) ?? []) stack.push(ch);
    }
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
  const fuelAvailable = (p: SimPart): number => {
    if (p.engine!.solid) return fuel.get(p.uid) ?? 0;
    let f = 0;
    for (const u of attached) {
      const q = byUid.get(u)!;
      if (q.group === p.group && q.propellant === p.engine!.propellant && !q.engine?.solid) f += fuel.get(u) ?? 0;
    }
    return f;
  };
  const drain = (p: SimPart, amount: number) => {
    if (p.engine!.solid) {
      fuel.set(p.uid, Math.max(0, (fuel.get(p.uid) ?? 0) - amount));
      return;
    }
    const tanks: SimPart[] = [];
    let total = 0;
    for (const u of attached) {
      const q = byUid.get(u)!;
      if (q.group === p.group && q.propellant === p.engine!.propellant && !q.engine?.solid) {
        const f = fuel.get(u) ?? 0;
        if (f > 0) {
          tanks.push(q);
          total += f;
        }
      }
    }
    if (total <= 0) return;
    for (const q of tanks) {
      const f = fuel.get(q.uid)!;
      fuel.set(q.uid, Math.max(0, f - (amount * f) / total));
    }
  };

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
      if (p.stage === s + 1 && p.decoupler && attached.has(p.uid)) subtree(p.uid, dropNext);
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
      const dropActive = active.some((p) => dropNext.has(p.uid));
      if (dropNext.size && !dropActive && !firstSeg) break;
      if (dropNext.size && !dropActive && firstSeg) {
        // Next stage drops no burning engine — burn everything this stage.
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
        else rates.set(key, { rate: m, fuel: fuelAvailable(p) });
        fVac += e.thrustVac;
        fSL += e.thrustSL;
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
