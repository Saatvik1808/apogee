/**
 * LEARNING NOTE: Lambert's problem and porkchop plots
 *
 * "Which orbit takes me from point A to point B in exactly Δt seconds?" is
 * Lambert's problem, the core of interplanetary mission design. Given Earth's
 * position on the departure day and Mars's position on the arrival day, the
 * solution is the transfer ellipse around the Sun — and with it the velocity the
 * spacecraft needs at each end.
 *
 * We solve it with UNIVERSAL VARIABLES (Bate, Mueller & White; Curtis Alg. 5.2):
 * a single parameter z describes every conic (z > 0 ellipse, z = 0 parabola,
 * z < 0 hyperbola); the time of flight is a monotonic function of z for one
 * revolution, so a bracketing search finds the root reliably. Stumpff functions
 * C(z) and S(z) replace the sines/cosines (or sinh/cosh) of the conic.
 *
 * Solving Lambert for a grid of departure dates × flight times and colouring the
 * departure energy C3 = v∞² gives the famous PORKCHOP PLOT. Its cheapest valley
 * repeats every synodic period — 780 days for Earth and Mars — which is why Mars
 * missions launch in narrow windows about 26 months apart.
 *
 * Key concepts: Lambert's problem, universal variables, Stumpff functions,
 * hyperbolic excess velocity (v∞), characteristic energy C3, synodic period,
 * porkchop plots
 */
import { Vector3 } from 'three';

function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24 + (z * z) / 720;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

export interface LambertResult {
  v1: Vector3;
  v2: Vector3;
}

const _c = new Vector3();

/**
 * Single-revolution Lambert solution from r1 to r2 in `tof` seconds around a
 * body of gravitational parameter `mu`. `normal` picks the prograde sense (the
 * transfer's angular momentum points along it). Returns null if no solution.
 */
export function solveLambert(r1: Vector3, r2: Vector3, tof: number, mu: number, normal: Vector3): LambertResult | null {
  const R1 = r1.length();
  const R2 = r2.length();
  let cosD = r1.dot(r2) / (R1 * R2);
  cosD = Math.max(-1, Math.min(1, cosD));
  let dTheta = Math.acos(cosD);
  _c.crossVectors(r1, r2);
  if (_c.dot(normal) < 0) dTheta = 2 * Math.PI - dTheta;
  const sinD = Math.sin(dTheta);
  if (Math.abs(1 - cosD) < 1e-12) return null;
  const A = sinD * Math.sqrt((R1 * R2) / (1 - cosD));
  if (Math.abs(A) < 1e-9) return null;
  const sqrtMu = Math.sqrt(mu);
  const y = (z: number) => R1 + R2 + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const F = (z: number) => {
    const yz = y(z);
    if (yz < 0) return NaN;
    return Math.pow(yz / stumpffC(z), 1.5) * stumpffS(z) + A * Math.sqrt(yz) - sqrtMu * tof;
  };
  // Bracket the root: F increases with z on the single-revolution branch
  let lo = -4 * Math.PI * Math.PI;
  const hi0 = 4 * Math.PI * Math.PI - 1e-6;
  // For A > 0 small z can make y negative: move lo up until y ≥ 0
  let guard = 0;
  while ((isNaN(F(lo)) || y(lo) < 0) && guard++ < 200) lo += 0.25;
  let hi = hi0;
  const fLo = F(lo);
  const fHi = F(hi);
  if (isNaN(fLo) || isNaN(fHi) || fLo > 0 || fHi < 0) return null;
  let z = 0;
  for (let it = 0; it < 200; it++) {
    z = 0.5 * (lo + hi);
    const f = F(z);
    if (isNaN(f)) {
      lo = z;
      continue;
    }
    if (Math.abs(f) < 1e-6 * sqrtMu * tof) break;
    if (f > 0) hi = z;
    else lo = z;
    if (hi - lo < 1e-12) break;
  }
  const yz = y(z);
  const f = 1 - yz / R1;
  const g = A * Math.sqrt(yz / mu);
  const gDot = 1 - yz / R2;
  const v1 = new Vector3().copy(r2).addScaledVector(r1, -f).multiplyScalar(1 / g);
  const v2 = new Vector3().copy(r2).multiplyScalar(gDot).sub(r1).multiplyScalar(1 / g);
  return { v1, v2 };
}

/** Earth → Mars flight-time range and arrival-speed weight shared by the window search and the injection planner. */
export const MARS_TOF_MIN = 190 * 86400;
export const MARS_TOF_MAX = 270 * 86400;
export const MARS_ARRIVAL_WEIGHT = 0.25;

export interface TransferOption {
  /** Departure / arrival times (UT seconds). */
  depart: number;
  arrive: number;
  /** Hyperbolic excess velocity leaving the departure planet (heliocentric frame). */
  vInfDepart: Vector3;
  /** Hyperbolic excess velocity arriving at the target planet. */
  vInfArrive: Vector3;
  /** C3 = |v∞|² at departure (m²/s²). */
  c3: number;
}

export interface EphemerisSource {
  /** Heliocentric position & velocity of a planet at time t. */
  stateAt(t: number, r: Vector3, v: Vector3): void;
}

/**
 * Porkchop search: the cheapest departure in [from, from + span] for flight
 * times [tofMin, tofMax]. Cost = departure C3 plus a weighted arrival v∞²
 * (arrival speed must be cancelled by a capture burn or an aeroshell).
 */
export function porkchop(
  from: number,
  span: number,
  tofMin: number,
  tofMax: number,
  mu: number,
  origin: EphemerisSource,
  target: EphemerisSource,
  arrivalWeight = 0.4,
  /** Keep the departure time fixed at `from` (only the flight time is searched). */
  fixedDeparture = false,
): TransferOption | null {
  const r1 = new Vector3();
  const v1p = new Vector3();
  const r2 = new Vector3();
  const v2p = new Vector3();
  const h = new Vector3();
  let best: TransferOption | null = null;
  let bestCost = Infinity;
  const evaluate = (t0: number, tof: number) => {
    origin.stateAt(t0, r1, v1p);
    target.stateAt(t0 + tof, r2, v2p);
    h.crossVectors(r1, v1p);
    const sol = solveLambert(r1, r2, tof, mu, h);
    if (!sol) return;
    const vd = sol.v1.sub(v1p);
    const va = sol.v2.sub(v2p);
    const cost = vd.lengthSq() + arrivalWeight * va.lengthSq();
    if (cost < bestCost) {
      bestCost = cost;
      best = { depart: t0, arrive: t0 + tof, vInfDepart: vd.clone(), vInfArrive: va.clone(), c3: vd.lengthSq() };
    }
  };
  const day = 86400;
  // Coarse grid, then refine around the best cell
  for (let d = 0; d <= span; d += 2 * day) for (let tof = tofMin; tof <= tofMax; tof += 5 * day) evaluate(from + d, tof);
  const coarse = best as TransferOption | null;
  if (coarse) {
    const c = coarse;
    const dSpan = fixedDeparture ? 0 : 2 * day;
    for (let d = -dSpan; d <= dSpan; d += 0.25 * day) {
      for (let tof = c.arrive - c.depart - 5 * day; tof <= c.arrive - c.depart + 5 * day; tof += 0.5 * day) evaluate(c.depart + d, tof);
    }
  }
  return best;
}
