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
import { MARS_ARRIVAL_WEIGHT, MARS_TOF_MAX, MARS_TOF_MIN, porkchop, solveLambert } from '../physics/Lambert';
import { energyDirection, estimateBurnTime, type ManeuverNode, type NodeGuidance } from './Maneuver';
import { analyzeStages } from '../parts/DeltaV';
import { G0 } from '../core/constants';

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

/**
 * Fly an energy-guided burn numerically, exactly as the autopilot does it:
 * thrust along the current velocity (tilted out of plane by `tilt`), throttle
 * easing off near the end, cut-off when the orbit's specific energy reaches
 * `epsT`. RK4 with 1 s steps; the mass falls as propellant burns. Returns the
 * burn duration and leaves the final state in outR/outV.
 */
interface BurnStage {
  startMass: number;
  endMass: number;
  thrust: number;
  mdot: number;
}

/** The vessel's remaining powered stages in firing order (current fuel levels). */
export function burnStages(sim: FlightSim): BurnStage[] {
  const v = sim.active;
  const out: BurnStage[] = [];
  // Same convention as the HUD: the running stage is nextStage − 1
  const all = analyzeStages(v.toSimParts(), v.nextStage, G0).filter((x) => x.stage >= v.nextStage - 1).sort((a, b) => a.stage - b.stage);
  for (const st of all) {
    if (st.dvVac <= 1 || st.burnTime <= 0 || st.thrustVac <= 0) continue;
    out.push({ startMass: st.startMass, endMass: st.endMass, thrust: st.thrustVac, mdot: (st.startMass - st.endMass) / st.burnTime });
  }
  return out;
}

export function simulateEnergyBurn(mu: number, r0: Vector3, v0: Vector3, stages: BurnStage[], epsT: number, tilt: number, outR: Vector3, outV: Vector3): number {
  const r = outR.copy(r0);
  const v = outV.copy(v0);
  let si = 0;
  let m = stages[0]!.startMass;
  let thrust = stages[0]!.thrust;
  let mdot = stages[0]!.mdot;
  const dt = 1;
  const eps0 = v.lengthSq() / 2 - mu / r.length();
  const sign = Math.sign(epsT - eps0) || 1;
  const acc = (pr: Vector3, out: Vector3, thrustAcc: Vector3) => {
    const rl = pr.length();
    return out.copy(pr).multiplyScalar(-mu / (rl * rl * rl)).add(thrustAcc);
  };
  let t = 0;
  for (let i = 0; i < 16000; i++) {
    const speed = v.length();
    const eps = (speed * speed) / 2 - mu / r.length();
    const d = (epsT - eps) / Math.max(speed, 1);
    if (sign * d <= 0.08) break;
    if (m <= stages[si]!.endMass) {
      // Stage burnt out: drop it and light the next (as auto-staging does)
      si++;
      if (si >= stages.length) break;
      m = stages[si]!.startMass;
      thrust = stages[si]!.thrust;
      mdot = stages[si]!.mdot;
    }
    const aMax = thrust / m;
    const throttle = Math.min(1, Math.max(0.02, Math.abs(d) / (aMax * 1.2)));
    energyDirection(r, v, tilt, _fd).multiplyScalar(sign * aMax * throttle);
    // RK4 (thrust held constant over the step)
    _k1r.copy(v);
    acc(r, _k1v, _fd);
    _tr.copy(r).addScaledVector(_k1r, dt / 2);
    _k2r.copy(v).addScaledVector(_k1v, dt / 2);
    acc(_tr, _k2v, _fd);
    _tr.copy(r).addScaledVector(_k2r, dt / 2);
    _k3r.copy(v).addScaledVector(_k2v, dt / 2);
    acc(_tr, _k3v, _fd);
    _tr.copy(r).addScaledVector(_k3r, dt);
    _k4r.copy(v).addScaledVector(_k3v, dt);
    acc(_tr, _k4v, _fd);
    r.addScaledVector(_k1r, dt / 6).addScaledVector(_k2r, dt / 3).addScaledVector(_k3r, dt / 3).addScaledVector(_k4r, dt / 6);
    v.addScaledVector(_k1v, dt / 6).addScaledVector(_k2v, dt / 3).addScaledVector(_k3v, dt / 3).addScaledVector(_k4v, dt / 6);
    m -= mdot * throttle * dt;
    t += dt;
  }
  return t;
}

const _fd = new Vector3();
const _k1r = new Vector3();
const _k1v = new Vector3();
const _k2r = new Vector3();
const _k2v = new Vector3();
const _k3r = new Vector3();
const _k3v = new Vector3();
const _k4r = new Vector3();
const _k4v = new Vector3();
const _tr = new Vector3();
const _fr = new Vector3();
const _fv = new Vector3();

/**
 * Turn a finite energy-guided burn (start time, target energy, tilt) into the
 * maneuver node the autopilot will fly: the node sits half the burn's Δv after
 * the start, and its prograde/normal components encode the energy and the tilt.
 */
function finiteBurnNode(sim: FlightSim, o: Orbit, tStart: number, epsT: number, tilt: number): ManeuverNode | null {
  o.getStateAt(tStart, _r, _v);
  const speed = _v.length();
  const eps = (speed * speed) / 2 - o.mu / _r.length();
  const rem = Math.abs(epsT - eps) / Math.max(speed, 1);
  const lead = estimateBurnTime(sim.active, rem / 2);
  const tN = tStart + (isFinite(lead) ? lead : 0);
  o.getStateAt(tN, _r, _v);
  const vN = _v.length();
  const K = 2 * (epsT + o.mu / _r.length());
  const a = 1 + tilt * tilt;
  const disc = 4 * vN * vN - 4 * a * (vN * vN - K);
  const dv = (-2 * vN + Math.sqrt(Math.max(0, disc))) / (2 * a);
  return placeNode(sim, tN, dv, tilt * dv, 0, 'energy');
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

/**
 * Capture into a loose elliptical orbit at the next periapsis: brake just enough
 * that the new apoapsis sits well inside the sphere of influence. Far cheaper
 * than circularising (the Oberth effect favours braking deep in the well).
 */
export function planCapture(sim: FlightSim): PlanResult {
  const cur = currentPatch(sim);
  if (!cur) return fail('No trajectory to plan from');
  const o = cur.orbit;
  const body = cur.body;
  const now = sim.time;
  const t = now + o.timeToPeriapsis(now);
  if (!isFinite(t) || t > cur.end) return fail('The periapsis lies beyond the current sphere of influence');
  o.getStateAt(t, _r, _v);
  const rp = _r.length();
  if (rp < body.radius + (body.atmosphere ? body.atmosphere.ceiling : 5000)) return fail('Periapsis is too low — raise it with a correction burn first');
  const raTarget = Math.min(body.soiRadius * 0.25, body.radius + Math.max(10 * (rp - body.radius), 8 * body.radius));
  const aNew = (rp + Math.max(raTarget, rp)) / 2;
  const vNew = Math.sqrt(body.mu * (2 / rp - 1 / aNew));
  const dv = vNew - _v.length();
  if (dv >= 0) return fail('Already captured — use "Circularise at Pe" to lower the apoapsis');
  const node = placeNode(sim, t, dv, 0, 0, 'energy');
  if (!node) return fail('Could not place the node');
  return { ok: true, message: `Capture: ${Math.abs(dv).toFixed(0)} m/s retrograde at periapsis in ${fmtDt(t - now)} · apoapsis ≈ ${((raTarget - body.radius) / 1000).toFixed(0)} km`, node };
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
function search(t0: number, span: number, dv0: number, dvSpan: number, score: (t: number, dv: number) => Score, nT = 240, dvSteps = 5): { t: number; dv: number; sc: Score } {
  let bestT = t0;
  let bestDv = dv0;
  let best: Score = { s: Infinity, hit: false, pe: NaN };
  const dvs = dvSpan > 0 ? (dvSteps >= 5 ? [dv0 - dvSpan, dv0 - dvSpan / 2, dv0, dv0 + dvSpan / 2, dv0 + dvSpan] : [dv0 - dvSpan, dv0, dv0 + dvSpan]) : [dv0];
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

/**
 * Trans-Mars injection from a parking orbit around Earth. The burn size comes
 * from the departure v∞ of the best Lambert transfer (porkchop search) leaving
 * within a few days; the burn time — where the escape hyperbola's asymptote
 * points the right way — and the fine size come from the patched-conic search,
 * scored by the predicted Mars periapsis.
 */
export function planMarsTransfer(sim: FlightSim, targetAlt = 300_000): PlanResult {
  const cur = currentPatch(sim);
  const sys = sim.system;
  const earth = sys.earth;
  const mars = sys.mars;
  if (!cur || cur.body !== earth) return fail('Plan the transfer from an orbit around Earth');
  const o = cur.orbit;
  if (!o.isElliptic || o.periapsis < earth.radius + 120_000) return fail('Reach a stable parking orbit first');
  const now = sim.time;
  const src = (b: CelestialBody) => ({ stateAt: (t: number, r: Vector3, v: Vector3) => b.relativeStateAt(t, r, v) });
  // Same flight-time range as the launch-window search, so the parking orbit's
  // plane already contains the departure direction this transfer needs
  // Lambert from Earth NOW (departure fixed at the burn, ~1 h ahead; only the
  // flight time varies): its v∞ is the direction the escape asymptote must take
  const tr = porkchop(now + 3600, 0, MARS_TOF_MIN, MARS_TOF_MAX, sys.sun.mu, src(earth), src(mars), MARS_ARRIVAL_WEIGHT, true);
  const vInf = tr ? Math.sqrt(tr.c3) : 3000;
  const r = o.a;
  const dv0 = Math.sqrt(vInf * vInf + (2 * earth.mu) / r) - Math.sqrt(earth.mu / r);
  // Analytic burn for a desired departure v∞ (vector): the asymptote sits
  // θ∞ = acos(−1/e) ahead of perigee, so the burn (perigee) is θ∞ behind the
  // asymptote's projection into the orbit plane; the out-of-plane part of v∞
  // sets the normal push. Returns burn time, prograde and normal Δv.
  const burnFor = (vInfVec: Vector3): { t: number; dv: number; dn: number } => {
    const vi = vInfVec.length();
    o.getStateAt(now, _r, _v);
    const hN = _n.crossVectors(_r, _v).normalize().clone();
    const sHat = vInfVec.clone().normalize();
    const outOfPlane = sHat.dot(hN);
    const sp = sHat.addScaledVector(hN, -outOfPlane).normalize();
    const e = 1 + (r * vi * vi) / earth.mu;
    const thInf = Math.acos(-1 / e);
    const pDir = sp.clone().applyAxisAngle(hN, -thInf);
    const rHat = _r.clone().normalize();
    let ang = Math.atan2(_p.crossVectors(rHat, pDir).dot(hN), rHat.dot(pDir));
    if (ang < 0) ang += Math.PI * 2;
    let t = now + ang / ((Math.PI * 2) / o.period);
    if (t < now + 240) t += o.period;
    const vp = Math.sqrt(vi * vi + (2 * earth.mu) / r);
    return { t, dv: vp - Math.sqrt(earth.mu / r), dn: vp * outOfPlane };
  };
  // Patched-conic targeting: the Lambert arc assumes departure from Earth's
  // centre, but the probe actually enters solar orbit ~925,000 km away and days
  // later. Predict the real solar-orbit start, re-solve Lambert from THERE to
  // Mars's arrival point, and feed the velocity error back into v∞. A few
  // iterations converge on the slow, cheap transfer family.
  let tGuess = NaN;
  let dnGuess = 0;
  let dvGuess = dv0;
  if (tr) {
    const vInfT = tr.vInfDepart.clone();
    const r2 = new Vector3();
    const hSun = new Vector3();
    const rX = new Vector3();
    const vX = new Vector3();
    earth.relativeStateAt(now, _r, _v);
    hSun.crossVectors(_r, _v);
    mars.relativeStateAt(tr.arrive, r2);
    for (let it = 0; it < 8; it++) {
      const g = burnFor(vInfT);
      tGuess = g.t;
      dvGuess = g.dv;
      dnGuess = g.dn;
      o.getStateAt(g.t, _r, _v);
      orbitalFrame(_r, _v, _p, _n, _rad);
      _v2.copy(_v).addScaledVector(_p, g.dv).addScaledVector(_n, g.dn);
      pred.predict(earth, _r, _v2, g.t, { maxPatches: 2, target: null });
      if (pred.count < 2 || pred.patches[0]!.endReason !== 'soi-exit') break;
      const sunPatch = pred.patches[1]!;
      sunPatch.orbit.getStateAt(sunPatch.startTime, rX, vX);
      const sol = solveLambert(rX, r2, tr.arrive - sunPatch.startTime, sys.sun.mu, hSun);
      if (!sol) break;
      const dV = sol.v1.sub(vX);
      vInfT.add(dV);
      if (dV.length() < 0.3) break;
    }
  }
  // Score of a burn at time t with prograde dv and normal dn: predicted Mars
  // periapsis if we get there, otherwise the closest approach (thousands of km)
  let missKm = Infinity;
  // Stay on the Lambert transfer's energy (±80 m/s): straying further finds
  // "hits" on fast trajectories whose arrival speed no lander can capture from
  const dvBand = (dv: number) => Math.max(0, Math.abs(dv - dvGuess) - 80) * 1e4;
  const score3 = (t: number, dv: number, dn: number): Score => {
    const band = dvBand(dv);
    o.getStateAt(t, _r, _v);
    orbitalFrame(_r, _v, _p, _n, _rad);
    _v2.copy(_v).addScaledVector(_p, dv).addScaledVector(_n, dn);
    pred.predict(earth, _r, _v2, t, { maxPatches: 3, target: mars });
    const a = pred.patches[0]!;
    if (a.endReason !== 'soi-exit' || pred.count < 2) return { s: 1e9, hit: false, pe: NaN };
    const b = pred.patches[1]!;
    if (b.endReason === 'soi-enter' && b.nextBody === mars && pred.count > 2) {
      const q = pred.patches[2]!.orbit;
      const pe = q.periapsis - mars.radius;
      const days = (b.endTime - t) / 86400;
      const tofPenalty = Math.max(0, days - MARS_TOF_MAX / 86400 - 10) * 20 + Math.max(0, MARS_TOF_MIN / 86400 - 10 - days) * 20;
      // Total cost: injection Δv plus arrival speed (what capture or entry must kill)
      const vArr = q.a < 0 ? Math.sqrt(mars.mu / -q.a) : 0;
      return { s: Math.abs(pe - targetAlt) / 1000 + tofPenalty + (Math.hypot(dv, dn) + vArr) * 0.5 + band, hit: true, pe };
    }
    return { s: 1e5 + (isFinite(b.closestApproachDistance) ? b.closestApproachDistance / 1000 : 1e7) + Math.abs(dn) * 0.5 + band, hit: false, pe: NaN };
  };
  // Local search around the analytic guess (3-D: time, prograde, normal); fall
  // back to a coarse in-plane scan if the guess is unavailable or misses badly
  let bt = tGuess;
  let bdv = dvGuess;
  let bdn = dnGuess;
  let best: Score = { s: Infinity, hit: false, pe: NaN };
  if (isFinite(tGuess)) {
    for (const dt of [-30, 0, 30]) {
      for (const ddv of [-10, 0, 10]) {
        for (const ddn of [-20, 0, 20]) {
          const sc = score3(tGuess + dt, dvGuess + ddv, dnGuess + ddn);
          if (sc.s < best.s) {
            best = sc;
            bt = tGuess + dt;
            bdv = dvGuess + ddv;
            bdn = dnGuess + ddn;
          }
        }
      }
    }
  }
  if (!(best.s < 1e5 + 5_000_000)) {
    const res = search(now + 180, o.period, dv0, 150, (t, dv) => score3(t, dv, 0), 120, 3);
    if (res.sc.s < best.s) {
      best = res.sc;
      bt = res.t;
      bdv = res.dv;
      bdn = 0;
    }
  }
  for (const [st, sv] of [[60, 20], [15, 4], [3, 0.8], [0.6, 0.15]] as const) {
    for (let it = 0; it < 14; it++) {
      let improved = false;
      for (const [dt, ddv, ddn] of [[st, 0, 0], [-st, 0, 0], [0, sv, 0], [0, -sv, 0], [0, 0, sv], [0, 0, -sv]] as const) {
        const t = bt + dt;
        if (t < now + 120) continue;
        const sc = score3(t, bdv + ddv, bdn + ddn);
        if (sc.s < best.s) {
          best = sc;
          bt = t;
          bdv += ddv;
          bdn += ddn;
          improved = true;
        }
      }
      if (!improved) break;
    }
  }
  if (!best.hit) {
    missKm = best.s - 1e5 - Math.abs(bdn) * 0.5;
    if (!(missKm < 20_000_000)) return fail('No Mars encounter from this orbit. Launch in the Mars window (quick launch → Mars window), then plan again.');
  }
  // A ~7-minute injection sweeps 30° of orbit: re-target by flying the real,
  // finite burn numerically (same guidance law as the autopilot)
  const stages = burnStages(sim);
  let node: ManeuverNode | null = null;
  if (stages.length) {
    o.getStateAt(bt, _r, _v);
    const vN = _v.length();
    let epsT = ((vN + bdv) ** 2 + bdn * bdn) / 2 - earth.mu / _r.length();
    let tilt = bdv !== 0 ? bdn / bdv : 0;
    const rem0 = Math.abs(epsT - (vN * vN / 2 - earth.mu / _r.length())) / vN;
    let tS = bt - (estimateBurnTime(sim.active, rem0 / 2) || 0);
    const eps0 = vN * vN / 2 - earth.mu / _r.length();
    const epsRef = epsT;
    const fscore = (ts: number, e: number, tl: number): Score => {
      const band = Math.max(0, Math.abs(e - epsRef) / vN - 80) * 1e4;
      o.getStateAt(ts, _r, _v);
      const dur = simulateEnergyBurn(earth.mu, _r, _v, stages, e, tl, _fr, _fv);
      pred.predict(earth, _fr, _fv, ts + dur, { maxPatches: 3, target: mars });
      const a = pred.patches[0]!;
      if (a.endReason !== 'soi-exit' || pred.count < 2) return { s: 1e9, hit: false, pe: NaN };
      const b = pred.patches[1]!;
      if (b.endReason === 'soi-enter' && b.nextBody === mars && pred.count > 2) {
        const q = pred.patches[2]!.orbit;
        const pe = q.periapsis - mars.radius;
        const vArr = q.a < 0 ? Math.sqrt(mars.mu / -q.a) : 0;
        return { s: Math.abs(pe - targetAlt) / 1000 + (Math.sqrt(2 * (e - eps0)) + vArr) * 0.5 + Math.abs(tl) * 200 + band, hit: true, pe };
      }
      return { s: 1e5 + (isFinite(b.closestApproachDistance) ? b.closestApproachDistance / 1000 : 1e7) + Math.abs(tl) * 200 + band, hit: false, pe: NaN };
    };
    let fb = fscore(tS, epsT, tilt);
    const eStep = vN; // 1 m/s of Δv ≈ v·1 J/kg of energy
    for (const [st, se, stl] of [[20, 10, 0.006], [5, 2, 0.0015], [1, 0.4, 0.0003], [0.25, 0.08, 0.0001]] as const) {
      for (let it = 0; it < 10; it++) {
        let improved = false;
        for (const [a, b, c] of [[st, 0, 0], [-st, 0, 0], [0, se, 0], [0, -se, 0], [0, 0, stl], [0, 0, -stl]] as const) {
          const ts = tS + a;
          if (ts < now + 60) continue;
          const sc = fscore(ts, epsT + b * eStep, tilt + c);
          if (sc.s < fb.s) {
            fb = sc;
            tS = ts;
            epsT += b * eStep;
            tilt += c;
            improved = true;
          }
        }
        if (!improved) break;
      }
    }
    // The simulated finite burn is the truth; the impulsive score is only a model
    if (fb.s < 1e9) {
      best = fb;
      node = finiteBurnNode(sim, o, tS, epsT, tilt);
      if (node) {
        bt = node.time;
        bdv = node.prograde;
        bdn = node.normal;
      }
    }
  }
  if (!node) node = placeNode(sim, bt, bdv, bdn, 0, 'energy');
  if (!node) return fail('Could not place the node');
  if (!best.hit) missKm = best.s - 1e5;
  const days = tr ? (tr.arrive - tr.depart) / 86400 : 220;
  const arrival = best.hit
    ? `Mars periapsis ${(best.pe / 1000).toFixed(0)} km`
    : `passes ${(missKm / 1e6).toFixed(2)} million km from Mars — plan "Fine-tune" once in solar orbit`;
  return {
    ok: true,
    message: `Trans-Mars injection: ${Math.hypot(bdv, bdn).toFixed(0)} m/s in ${fmtDt(bt - now)} · ~${days.toFixed(0)}-day cruise · ${arrival}.`,
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
export function planCorrection(sim: FlightSim, marsTargetAlt = 300_000): PlanResult {
  const cur = currentPatch(sim);
  if (!cur) return fail('No trajectory to plan from');
  const earth = sim.system.earth;
  const moon = sim.system.moon;
  const mars = sim.system.mars;
  const p0 = sim.predictor.patches[0]!;
  // Destination: Mars when cruising around the Sun (or escaping Earth), the Moon
  // when heading out from Earth, Earth when leaving the Moon
  const toMars = cur.body.id === 'sun' || (cur.body === earth && !cur.orbit.isElliptic && p0.endReason === 'soi-exit');
  const toMoon = !toMars && cur.body === earth && (p0.endReason === 'soi-enter' || cur.orbit.apoapsis > 200_000_000);
  const dest = toMars ? mars : toMoon ? moon : earth;
  const target = toMars ? mars : moon;
  const targetAlt = toMars ? marsTargetAlt : toMoon ? 110_000 : 40_000;
  if (!toMars && !toMoon && cur.body === earth && cur.orbit.apoapsis < 200_000_000) return fail('Nothing to correct: not on a transfer');
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
    pred.predict(cur.body, r0, _v2, t, { maxPatches: 3, target });
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
    // Closest approach to the destination in whichever patch tracks it
    let miss = Infinity;
    for (let i = 0; i < pred.count; i++) miss = Math.min(miss, pred.patches[i]!.closestApproachDistance);
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
