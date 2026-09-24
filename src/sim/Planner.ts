/**
 * LEARNING NOTE: Planning transfers by search
 *
 * A Hohmann transfer (an ellipse touching both orbits) gives the ideal burn SIZE
 * for reaching the Moon: Δv = √(μ(2/r₁ − 1/a_t)) − √(μ/r₁), about 3.1 km/s from
 * low Earth orbit. It doesn't say WHEN to burn: the Moon must arrive at the far
 * end of the ellipse at the same moment the spacecraft does, three days later.
 *
 * Instead of solving that geometry in closed form we let the computer try:
 * for many candidate burn times (and sizes) we predict the resulting patched-conic
 * trajectory exactly as the map view does, score it (how close to the Moon? what
 * periapsis altitude?) and keep the best — a coarse scan followed by coordinate
 * descent with shrinking steps. The same idea plans the return: burn from lunar
 * orbit so that, after leaving the Moon's sphere of influence, the path around
 * Earth dips to ~40 km altitude — deep enough to be captured by the atmosphere,
 * shallow enough to survive.
 *
 * Key concepts: Hohmann transfer, phasing, patched conics, numerical
 * optimisation (grid search + coordinate descent), apsis burns
 */
import { Vector3 } from 'three';
import { orbitalFrame, type Orbit } from '../physics/Orbit';
import { TrajectoryPredictor } from '../physics/Trajectory';
import type { CelestialBody } from '../physics/CelestialBody';
import type { FlightSim } from './FlightSim';
import type { ManeuverNode, NodeGuidance } from './Maneuver';

export interface PlanResult {
  ok: boolean;
  message: string;
  node?: ManeuverNode;
}

const pred = new TrajectoryPredictor(3);
const _r = new Vector3();
const _v = new Vector3();
const _v2 = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _rad = new Vector3();

const fail = (message: string): PlanResult => ({ ok: false, message });

function fmtDt(s: number): string {
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(0)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** The orbit the active vessel is on right now (first predicted patch). */
function currentPatch(sim: FlightSim): { orbit: Orbit; body: CelestialBody; end: number } | null {
  if (sim.predictor.count === 0) return null;
  const p = sim.predictor.patches[0]!;
  return { orbit: p.orbit, body: p.body, end: p.endTime };
}

/** Replace planned nodes with one node carrying the given components. */
function placeNode(sim: FlightSim, t: number, prograde: number, normal: number, radial: number, guidance: NodeGuidance = 'match'): ManeuverNode | null {
  for (const n of [...sim.nodes]) sim.removeNode(n);
  const node = sim.addNode(t);
  if (!node) return null;
  node.prograde = prograde;
  node.normal = normal;
  node.radial = radial;
  node.guidance = guidance;
  sim.editNode(node);
  return node;
}

/** Burn at the next apoapsis (raise periapsis) or periapsis (lower apoapsis) to circularise. */
export function planCircularize(sim: FlightSim, where: 'ap' | 'pe'): PlanResult {
  const cur = currentPatch(sim);
  if (!cur) return fail('No trajectory to plan from');
  const o = cur.orbit;
  const now = sim.time;
  if (where === 'ap' && !o.isElliptic) return fail('Escape trajectory: there is no apoapsis');
  const t = now + (where === 'ap' ? o.timeToApoapsis(now) : o.timeToPeriapsis(now));
  if (!isFinite(t) || t > cur.end) return fail(`The ${where === 'ap' ? 'apoapsis' : 'periapsis'} lies beyond the current sphere of influence`);
  o.getStateAt(t, _r, _v);
  const r = _r.length();
  if (r < cur.body.radius + (cur.body.atmosphere ? cur.body.atmosphere.ceiling : 2000)) return fail('That point is too low for a stable orbit');
  const dv = Math.sqrt(o.mu / r) - _v.length();
  const node = placeNode(sim, t, dv, 0, 0, 'circularize');
  if (!node) return fail('Could not place the node');
  const alt = (r - cur.body.radius) / 1000;
  return { ok: true, message: `Circularise at ${alt.toFixed(0)} km: ${Math.abs(dv).toFixed(0)} m/s ${dv >= 0 ? 'prograde' : 'retrograde'} in ${fmtDt(t - now)}`, node };
}

interface Score {
  s: number;
  hit: boolean;
  pe: number;
}

/**
 * Generic 2-D search over burn time and prograde Δv (with an optional fixed
 * normal component): coarse time scan, then coordinate descent.
 */
function search(t0: number, span: number, dv0: number, dvSpan: number, score: (t: number, dv: number) => Score): { t: number; dv: number; sc: Score } {
  let bestT = t0;
  let bestDv = dv0;
  let best: Score = { s: Infinity, hit: false, pe: NaN };
  const nT = 240;
  const dvs = dvSpan > 0 ? [dv0 - dvSpan, dv0 - dvSpan / 2, dv0, dv0 + dvSpan / 2, dv0 + dvSpan] : [dv0];
  for (const dv of dvs) {
    for (let k = 0; k <= nT; k++) {
      const t = t0 + (k / nT) * span;
      const sc = score(t, dv);
      if (sc.s < best.s) {
        best = sc;
        bestT = t;
        bestDv = dv;
      }
    }
  }
  let stepT = span / nT;
  let stepDv = Math.max(2, dvSpan / 4);
  for (let it = 0; it < 120; it++) {
    let improved = false;
    for (const [dt, ddv] of [
      [stepT, 0],
      [-stepT, 0],
      [0, stepDv],
      [0, -stepDv],
    ] as const) {
      const t = bestT + dt;
      if (t < t0) continue;
      const sc = score(t, bestDv + ddv);
      if (sc.s < best.s) {
        best = sc;
        bestT = t;
        bestDv += ddv;
        improved = true;
      }
    }
    if (!improved) {
      stepT *= 0.5;
      stepDv *= 0.5;
      if (stepT < 0.02 && stepDv < 0.01) break;
    }
  }
  return { t: bestT, dv: bestDv, sc: best };
}

/** Trans-lunar injection from a parking orbit around Earth. */
export function planMoonTransfer(sim: FlightSim, targetAlt = 110_000): PlanResult {
  const cur = currentPatch(sim);
  const earth = sim.system.earth;
  const moon = sim.system.moon;
  if (!cur || cur.body !== earth) return fail('Plan the transfer from an orbit around Earth');
  const o = cur.orbit;
  if (!o.isElliptic || o.periapsis < earth.radius + 120_000) return fail('Reach a stable parking orbit first');
  if (o.apoapsis > 60_000_000) return fail('Already on a high orbit — plan a manual node instead');
  const mu = earth.mu;
  const r1 = o.a;
  const r2 = moon.orbit ? moon.orbit.a : 384_400_000;
  const aT = (r1 + r2) / 2;
  const dvH = Math.sqrt(mu * (2 / r1 - 1 / aT)) - Math.sqrt(mu / r1);
  const now = sim.time;
  const score = (t: number, dv: number): Score => {
    o.getStateAt(t, _r, _v);
    orbitalFrame(_r, _v, _p, _n, _rad);
    _v2.copy(_v).addScaledVector(_p, dv);
    pred.predict(earth, _r, _v2, t, { maxPatches: 2, target: moon });
    const a = pred.patches[0]!;
    if (a.endReason === 'soi-enter' && a.nextBody === moon && pred.count > 1) {
      const pe = pred.patches[1]!.orbit.periapsis - moon.radius;
      // Prefer the requested periapsis and a quick (~3–4 day) coast; the flight
      // time term keeps the search away from slow encounters on a later lap.
      const days = (a.endTime - t) / 86400;
      // Penalise very slow coasts and very energetic (escape-prone) transfers
      const escape = pred.patches[0]!.orbit.isElliptic ? Math.max(0, pred.patches[0]!.orbit.apoapsis - 900_000_000) / 1e7 : 1000;
      return { s: Math.abs(pe - targetAlt) / 1000 + (pe < 20_000 ? 300 : 0) + Math.max(0, days - 4) * 40 + escape, hit: true, pe };
    }
    return { s: 1e5 + (isFinite(a.closestApproachDistance) ? a.closestApproachDistance / 1000 : 1e6), hit: false, pe: NaN };
  };
  const res = search(now + 180, o.period * 1.1, dvH + 30, 40, score);
  if (!res.sc.hit) {
    const miss = res.sc.s - 1e5;
    return fail(`No lunar encounter from this orbit plane (closest ≈ ${(miss / 1000).toFixed(0)} thousand km). Launch in the lunar window for an in-plane parking orbit.`);
  }
  const node = placeNode(sim, res.t, res.dv, 0, 0, 'energy');
  if (!node) return fail('Could not place the node');
  return {
    ok: true,
    message: `Trans-lunar injection: ${res.dv.toFixed(0)} m/s in ${fmtDt(res.t - now)} · lunar periapsis ${(res.sc.pe / 1000).toFixed(0)} km. Fine-tune with a correction burn after the injection.`,
    node,
  };
}

/** Escape the Moon onto a trajectory whose Earth periapsis grazes the upper atmosphere. */
export function planReturnToEarth(sim: FlightSim, targetPeAlt = 40_000): PlanResult {
  const cur = currentPatch(sim);
  const earth = sim.system.earth;
  const moon = sim.system.moon;
  if (!cur || cur.body !== moon) return fail('Plan the return from an orbit around the Moon');
  const o = cur.orbit;
  if (!o.isElliptic || o.periapsis < moon.radius + 5_000) return fail('Reach a stable lunar orbit first');
  const r = o.a;
  const vEsc = Math.sqrt((2 * moon.mu) / r);
  const vCirc = Math.sqrt(moon.mu / r);
  const dv0 = vEsc - vCirc + 180;
  const now = sim.time;
  const score = (t: number, dv: number): Score => {
    o.getStateAt(t, _r, _v);
    orbitalFrame(_r, _v, _p, _n, _rad);
    _v2.copy(_v).addScaledVector(_p, dv);
    pred.predict(moon, _r, _v2, t, { maxPatches: 2, target: null });
    const a = pred.patches[0]!;
    if (a.endReason === 'soi-exit' && pred.count > 1 && pred.patches[1]!.body === earth) {
      const pe = pred.patches[1]!.orbit.periapsis - earth.radius;
      return { s: Math.abs(pe - targetPeAlt) / 1000 + dv * 0.002, hit: true, pe };
    }
    return { s: 1e6 - (a.endReason === 'soi-exit' ? 1 : 0), hit: false, pe: NaN };
  };
  const res = search(now + 120, o.period, dv0, 300, score);
  if (!res.sc.hit) return fail('Could not find an escape towards Earth — try again after one orbit');
  const node = placeNode(sim, res.t, res.dv, 0, 0, 'energy');
  if (!node) return fail('Could not place the node');
  return {
    ok: true,
    message: `Trans-Earth injection: ${res.dv.toFixed(0)} m/s in ${fmtDt(res.t - now)} · Earth periapsis ${(res.sc.pe / 1000).toFixed(0)} km`,
    node,
  };
}

/** Lower the periapsis into the surface (airless bodies) or atmosphere (Earth) for a descent. */
export function planDeorbit(sim: FlightSim): PlanResult {
  const cur = currentPatch(sim);
  if (!cur) return fail('No trajectory to plan from');
  const o = cur.orbit;
  const body = cur.body;
  if (!o.isElliptic) return fail('Not in orbit');
  const now = sim.time;
  // Burn at apoapsis (cheapest), aim the new periapsis a little below the surface
  // (airless) or at 45 km (Earth: aerobraking re-entry).
  const t = now + Math.max(60, o.timeToApoapsis(now));
  o.getStateAt(t, _r, _v);
  const ra = _r.length();
  const rpTarget = body.atmosphere ? body.radius + (body.id === 'earth' ? 45_000 : body.atmosphere.ceiling * 0.4) : body.radius - 8_000;
  const aNew = (ra + rpTarget) / 2;
  const vNew = Math.sqrt(body.mu * (2 / ra - 1 / aNew));
  const dv = vNew - _v.length();
  if (dv >= 0) return fail('Already on a descent trajectory');
  const node = placeNode(sim, t, dv, 0, 0, 'energy');
  if (!node) return fail('Could not place the node');
  return { ok: true, message: `De-orbit burn: ${Math.abs(dv).toFixed(0)} m/s retrograde in ${fmtDt(t - now)}`, node };
}

/**
 * Mid-course correction: a small burn soon, in any direction, that sets the
 * periapsis at the destination (Moon arrival or Earth re-entry) to the target.
 * Far from a planet a few m/s moves the arrival point by thousands of km, so the
 * search starts with small steps and prefers the smallest burn that works.
 */
export function planCorrection(sim: FlightSim): PlanResult {
  const cur = currentPatch(sim);
  if (!cur) return fail('No trajectory to plan from');
  const earth = sim.system.earth;
  const moon = sim.system.moon;
  // Destination: the Moon when heading out from Earth, Earth when leaving the Moon
  const toMoon = cur.body === earth && (sim.predictor.patches[0]!.endReason === 'soi-enter' || cur.orbit.apoapsis > 200_000_000);
  const dest = toMoon ? moon : earth;
  const targetAlt = toMoon ? 110_000 : 40_000;
  if (!toMoon && cur.body === earth && cur.orbit.apoapsis < 200_000_000) return fail('Nothing to correct: not on a transfer');
  const o = cur.orbit;
  const now = sim.time;
  const t = now + 300;
  if (t > cur.end) return fail('Too close to the sphere-of-influence change — wait until after it');
  o.getStateAt(t, _r, _v);
  orbitalFrame(_r, _v, _p, _n, _rad);
  const r0 = _r.clone();
  const v0 = _v.clone();
  const P = _p.clone();
  const N = _n.clone();
  const RAD = _rad.clone();
  const score = (dp: number, dn: number, dr: number): Score => {
    _v2.copy(v0).addScaledVector(P, dp).addScaledVector(N, dn).addScaledVector(RAD, dr);
    pred.predict(cur.body, r0, _v2, t, { maxPatches: 3, target: moon });
    for (let i = 0; i < pred.count; i++) {
      const q = pred.patches[i]!;
      if (q.body !== dest) continue;
      if (i === 0 && dest === earth && cur.body === earth) {
        // Already around Earth, falling back in
        const pe = q.orbit.periapsis - earth.radius;
        return { s: Math.abs(pe - targetAlt) / 1000 + Math.hypot(dp, dn, dr) * 0.02, hit: true, pe };
      }
      if (i > 0) {
        const pe = q.orbit.periapsis - dest.radius;
        return { s: Math.abs(pe - targetAlt) / 1000 + Math.hypot(dp, dn, dr) * 0.02, hit: true, pe };
      }
    }
    const miss = pred.patches[0]!.closestApproachDistance;
    return { s: 1e5 + (isFinite(miss) ? miss / 1000 : 1e6), hit: false, pe: NaN };
  };
  const x = [0, 0, 0];
  let best = score(0, 0, 0);
  for (const step of [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05]) {
    for (let it = 0; it < 60; it++) {
      let improved = false;
      for (let axis = 0; axis < 3; axis++) {
        for (const sgn of [1, -1]) {
          const y = [...x];
          y[axis]! += sgn * step;
          const sc = score(y[0]!, y[1]!, y[2]!);
          if (sc.s < best.s) {
            best = sc;
            x[0] = y[0]!;
            x[1] = y[1]!;
            x[2] = y[2]!;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  }
  if (!best.hit) return fail(`No ${dest.name} encounter reachable with a small correction`);
  const dv = Math.hypot(x[0]!, x[1]!, x[2]!);
  if (dv < 0.05) return { ok: true, message: `Already on target: ${dest.name} periapsis ${(best.pe / 1000).toFixed(0)} km` };
  const node = placeNode(sim, t, x[0]!, x[1]!, x[2]!);
  if (!node) return fail('Could not place the node');
  return { ok: true, message: `Correction: ${dv.toFixed(1)} m/s in 5 min · ${dest.name} periapsis ${(best.pe / 1000).toFixed(0)} km`, node };
}
