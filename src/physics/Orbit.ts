/**
 * LEARNING NOTE: Keplerian orbits and the universal variable formulation
 *
 * A spacecraft coasting under the gravity of a single body follows a conic
 * section: an ellipse (bound orbit), a parabola (exactly escape speed) or a
 * hyperbola (escape). Knowing position r and velocity v at one instant fully
 * determines the conic, so we can jump to ANY future time analytically instead of
 * integrating tiny steps. That is what makes 1,000,000x time warp exact.
 *
 * The classic way (solve Kepler's equation E - e sin E = M) needs separate code for
 * ellipses and hyperbolas and breaks for radial trajectories. The "universal
 * variable" χ (chi) unifies all conic types in one equation using the Stumpff
 * functions C(z) and S(z); we solve it with a bracketed Newton iteration.
 *
 * Frame convention: +Y is the body's rotation axis (north). Inclination is measured
 * from the equatorial XZ plane; longitude of the ascending node from +X.
 *
 * Key concepts: orbital elements (a, e, i, Ω, ω, ν), specific energy, angular
 * momentum, universal anomaly, Lagrange f & g coefficients, true anomaly
 * Further reading: Curtis, "Orbital Mechanics for Engineering Students" ch. 3–4;
 * Vallado, "Fundamentals of Astrodynamics and Applications", Algorithm 8.
 */
import { Vector3 } from 'three';
import { TAU } from '../core/constants';

const PARABOLIC_EPS = 1e-7;

export function stumpffC(z: number): number {
  if (z > 1e-3) {
    const s = Math.sqrt(z);
    return (1 - Math.cos(s)) / z;
  }
  if (z < -1e-3) {
    const s = Math.sqrt(-z);
    return (Math.cosh(s) - 1) / -z;
  }
  return 0.5 - z / 24 + (z * z) / 720 - (z * z * z) / 40320;
}

export function stumpffS(z: number): number {
  if (z > 1e-3) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-3) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880;
}

const _tmpA = new Vector3();
const _tmpB = new Vector3();

export class Orbit {
  mu = 1;
  /** Time (universal time, s) at which r0/v0 are valid. */
  epoch = 0;
  readonly r0 = new Vector3();
  readonly v0 = new Vector3();

  // --- derived classical elements -------------------------------------------------
  /** Semi-major axis (m). Negative for hyperbolas, Infinity for parabolas. */
  a = 0;
  e = 0;
  /** Semi-latus rectum p = h²/μ. */
  p = 0;
  inc = 0;
  lan = 0;
  argPe = 0;
  /** True anomaly at epoch. */
  nu0 = 0;
  /** Reciprocal semi-major axis 1/a (0 for parabola) — used by universal variables. */
  alpha = 0;
  energy = 0;
  h = 0;
  period = Infinity;
  meanMotion = 0;
  periapsis = 0;
  apoapsis = Infinity;
  /** Universal time of periapsis passage (nearest to epoch). */
  tPeriapsis = 0;
  /** Radial (rectilinear) trajectory with ~zero angular momentum. */
  degenerate = false;

  /** Perifocal basis: P → periapsis, Q → 90° ahead in the orbit plane, W → orbit normal. */
  readonly P = new Vector3();
  readonly Q = new Vector3();
  readonly W = new Vector3();
  readonly hVec = new Vector3();
  readonly eVec = new Vector3();

  private r0Mag = 0;
  private rdotv0 = 0;
  private sqrtMu = 1;

  setFromState(r: Vector3, v: Vector3, mu: number, t: number): this {
    this.mu = mu;
    this.sqrtMu = Math.sqrt(mu);
    this.epoch = t;
    this.r0.copy(r);
    this.v0.copy(v);

    const rMag = r.length();
    const v2 = v.lengthSq();
    const rdotv = r.dot(v);
    this.r0Mag = rMag;
    this.rdotv0 = rdotv;

    this.hVec.crossVectors(r, v);
    this.h = this.hVec.length();
    this.energy = v2 / 2 - mu / rMag;
    this.alpha = 2 / rMag - v2 / mu;

    // Eccentricity vector: ((v² - μ/r) r - (r·v) v) / μ
    this.eVec
      .copy(r)
      .multiplyScalar(v2 - mu / rMag)
      .addScaledVector(v, -rdotv)
      .multiplyScalar(1 / mu);
    this.e = this.eVec.length();
    this.p = (this.h * this.h) / mu;

    const scaleH = this.h / (rMag * Math.sqrt(v2) + 1e-30);
    this.degenerate = scaleH < 1e-9 || this.h < 1e-6;

    if (Math.abs(this.alpha) * rMag < 1e-12) {
      this.a = Infinity;
    } else {
      this.a = 1 / this.alpha;
    }

    // Orbit normal
    if (!this.degenerate) {
      this.W.copy(this.hVec).multiplyScalar(1 / this.h);
    } else {
      // Arbitrary normal perpendicular to r
      _tmpA.copy(r).normalize();
      _tmpB.set(0, 1, 0);
      if (Math.abs(_tmpA.dot(_tmpB)) > 0.9) _tmpB.set(1, 0, 0);
      this.W.crossVectors(_tmpA, _tmpB).normalize();
    }

    this.inc = Math.acos(Math.max(-1, Math.min(1, this.W.y)));
    // Node vector n = NORTH × h = (hz, 0, -hx)
    const nx = this.W.z;
    const nz = -this.W.x;
    const nMag = Math.hypot(nx, nz);
    const equatorial = nMag < 1e-11;
    if (!equatorial) {
      this.lan = Math.atan2(this.W.x, this.W.z);
      if (this.lan < 0) this.lan += TAU;
    } else {
      this.lan = 0;
    }

    // Periapsis direction
    if (this.degenerate) {
      this.P.copy(r).normalize();
    } else if (this.e > 1e-10) {
      this.P.copy(this.eVec).multiplyScalar(1 / this.e);
    } else if (!equatorial) {
      this.P.set(nx / nMag, 0, nz / nMag);
    } else {
      // Circular equatorial: reference is +X projected into the plane
      this.P.set(1, 0, 0).addScaledVector(this.W, -this.W.x).normalize();
    }
    this.Q.crossVectors(this.W, this.P).normalize();

    // Argument of periapsis (measured from ascending node, or +X for equatorial orbits)
    {
      if (!equatorial) _tmpA.set(nx / nMag, 0, nz / nMag);
      else _tmpA.set(1, 0, 0);
      _tmpB.crossVectors(_tmpA, this.P);
      this.argPe = Math.atan2(_tmpB.dot(this.W), _tmpA.dot(this.P));
      if (this.argPe < 0) this.argPe += TAU;
    }

    this.nu0 = Math.atan2(r.dot(this.Q), r.dot(this.P));

    if (this.degenerate) {
      this.periapsis = 0;
      this.apoapsis = this.alpha > 0 ? 2 / this.alpha : Infinity;
    } else {
      this.periapsis = this.p / (1 + this.e);
      this.apoapsis = this.e < 1 ? this.p / (1 - this.e) : Infinity;
    }

    if (this.alpha > 0 && this.e < 1) {
      this.period = TAU * Math.sqrt(1 / (this.alpha * this.alpha * this.alpha) / mu);
      this.meanMotion = TAU / this.period;
    } else if (isFinite(this.a)) {
      this.period = Infinity;
      this.meanMotion = Math.sqrt(mu / Math.pow(-this.a, 3));
    } else {
      this.period = Infinity;
      this.meanMotion = 0;
    }

    this.tPeriapsis = this.degenerate ? t : t - this.timeSincePeriapsis(this.nu0);
    return this;
  }

  copy(o: Orbit): this {
    return this.setFromState(o.r0, o.v0, o.mu, o.epoch);
  }

  clone(): Orbit {
    return new Orbit().copy(this);
  }

  get isElliptic(): boolean {
    return this.alpha > 0 && this.e < 1 - PARABOLIC_EPS && !this.degenerate;
  }

  get isHyperbolic(): boolean {
    return !this.isElliptic;
  }

  /** Propagate to universal time t. Works for every conic, including radial. */
  getStateAt(t: number, outR: Vector3, outV?: Vector3): void {
    let dt = t - this.epoch;
    if (this.alpha > 0 && isFinite(this.period) && Math.abs(dt) > this.period) {
      dt %= this.period;
    }
    if (dt === 0) {
      outR.copy(this.r0);
      if (outV) outV.copy(this.v0);
      return;
    }

    const sqrtMu = this.sqrtMu;
    const r0 = this.r0Mag;
    const alpha = this.alpha;
    const k1 = this.rdotv0 / sqrtMu;
    const k2 = 1 - alpha * r0;
    const target = sqrtMu * dt;

    // Initial guess
    let chi: number;
    if (alpha * r0 > 1e-9) {
      chi = sqrtMu * dt * alpha;
    } else if (alpha * r0 < -1e-9) {
      const a = 1 / alpha;
      const sgn = dt > 0 ? 1 : -1;
      const num = -2 * this.mu * alpha * dt;
      const den = this.rdotv0 + sgn * Math.sqrt(-this.mu * a) * (1 - r0 * alpha);
      const arg = num / den;
      chi = arg > 0 ? sgn * Math.sqrt(-a) * Math.log(arg) : (sqrtMu * dt) / r0;
    } else {
      chi = (sqrtMu * dt) / r0;
    }
    if (!isFinite(chi) || chi === 0) chi = (sqrtMu * dt) / r0;

    // Bracketed Newton: F(χ) is strictly increasing (dF/dχ = r > 0)
    let lo = dt > 0 ? 0 : -Infinity;
    let hi = dt > 0 ? Infinity : 0;
    let z = 0;
    let c = 0.5;
    let s = 1 / 6;
    let rMag = r0;
    for (let iter = 0; iter < 80; iter++) {
      z = alpha * chi * chi;
      if (z < -5e5) z = -5e5; // overflow guard for absurd hyperbolic times
      c = stumpffC(z);
      s = stumpffS(z);
      const chi2 = chi * chi;
      const F = k1 * chi2 * c + k2 * chi2 * chi * s + r0 * chi - target;
      rMag = k1 * chi * (1 - z * s) + k2 * chi2 * c + r0;
      if (F < 0) lo = Math.max(lo, chi);
      else hi = Math.min(hi, chi);
      let next = chi - F / rMag;
      if (!(next > lo && next < hi)) {
        if (isFinite(lo) && isFinite(hi)) next = 0.5 * (lo + hi);
        else if (!isFinite(hi)) next = chi > 0 ? chi * 2 : 1;
        else next = chi < 0 ? chi * 2 : -1;
      }
      const delta = Math.abs(next - chi);
      chi = next;
      if (delta <= 1e-12 * (Math.abs(chi) + 1)) break;
    }
    z = alpha * chi * chi;
    c = stumpffC(z);
    s = stumpffS(z);
    const chi2 = chi * chi;

    const f = 1 - (chi2 / r0) * c;
    const g = dt - (chi2 * chi * s) / sqrtMu;
    outR.copy(this.r0).multiplyScalar(f).addScaledVector(this.v0, g);
    if (outV) {
      const r = outR.length();
      const fdot = (sqrtMu / (r * r0)) * chi * (z * s - 1);
      const gdot = 1 - (chi2 / r) * c;
      outV.copy(this.r0).multiplyScalar(fdot).addScaledVector(this.v0, gdot);
    }
  }

  radiusAtTrueAnomaly(nu: number): number {
    return this.p / (1 + this.e * Math.cos(nu));
  }

  positionAtTrueAnomaly(nu: number, out: Vector3): Vector3 {
    const r = this.radiusAtTrueAnomaly(nu);
    const cn = Math.cos(nu);
    const sn = Math.sin(nu);
    return out.copy(this.P).multiplyScalar(r * cn).addScaledVector(this.Q, r * sn);
  }

  velocityAtTrueAnomaly(nu: number, out: Vector3): Vector3 {
    const k = Math.sqrt(this.mu / this.p);
    return out
      .copy(this.P)
      .multiplyScalar(-k * Math.sin(nu))
      .addScaledVector(this.Q, k * (this.e + Math.cos(nu)));
  }

  /** Asymptotic true anomaly limit for hyperbolic orbits (π for ellipses). */
  get maxTrueAnomaly(): number {
    if (this.e < 1) return Math.PI;
    return Math.acos(-1 / this.e);
  }

  /** Signed time from periapsis to true anomaly nu (one revolution window for ellipses). */
  timeSincePeriapsis(nu: number): number {
    const e = this.e;
    if (this.degenerate) return 0;
    if (Math.abs(e - 1) < PARABOLIC_EPS) {
      const D = Math.tan(nu / 2);
      return 0.5 * Math.sqrt((this.p * this.p * this.p) / this.mu) * (D + (D * D * D) / 3);
    }
    if (e < 1) {
      const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
      const M = E - e * Math.sin(E);
      return M / this.meanMotion;
    }
    const x = Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2);
    if (x >= 1) return Infinity;
    if (x <= -1) return -Infinity;
    const H = 2 * Math.atanh(x);
    const M = e * Math.sinh(H) - H;
    return M / this.meanMotion;
  }

  /** True anomaly in [0, π] where the orbit reaches radius R, or NaN if never. */
  trueAnomalyAtRadius(R: number): number {
    if (this.degenerate || this.e < 1e-12) return NaN;
    const cosNu = (this.p / R - 1) / this.e;
    if (cosNu > 1 || cosNu < -1) return NaN;
    return Math.acos(cosNu);
  }

  /** Next universal time (≥ after) at which the orbit passes true anomaly nu. NaN if never. */
  nextTimeAtTrueAnomaly(nu: number, after: number): number {
    if (this.degenerate) return NaN;
    const tsp = this.timeSincePeriapsis(nu);
    if (!isFinite(tsp)) return NaN;
    let t = this.tPeriapsis + tsp;
    if (this.isElliptic) {
      if (t < after) t += Math.ceil((after - t) / this.period) * this.period;
      // Guard against rounding placing t a hair before `after`
      if (t < after - 1e-6) t += this.period;
      return t;
    }
    return t >= after - 1e-9 ? t : NaN;
  }

  trueAnomalyAt(t: number): number {
    this.getStateAt(t, _tmpA);
    return Math.atan2(_tmpA.dot(this.Q), _tmpA.dot(this.P));
  }

  timeToPeriapsis(now: number): number {
    if (this.degenerate) return NaN;
    const t = this.nextTimeAtTrueAnomaly(0, now);
    return t - now;
  }

  timeToApoapsis(now: number): number {
    if (!this.isElliptic) return NaN;
    return this.nextTimeAtTrueAnomaly(Math.PI, now) - now;
  }

  /**
   * Next time the trajectory crosses radius R going inward (decreasing r).
   * Returns NaN if it never does (e.g. periapsis above R).
   */
  nextInboundCrossing(R: number, after: number): number {
    if (this.degenerate) return this.radialCrossing(R, after, -1);
    if (this.periapsis >= R) return NaN;
    const nu = this.trueAnomalyAtRadius(R);
    if (isNaN(nu)) {
      // Entire orbit is below R (apoapsis < R) — never crosses inward
      return NaN;
    }
    return this.nextTimeAtTrueAnomaly(-nu, after);
  }

  /** Next time the trajectory crosses radius R going outward. NaN if never. */
  nextOutboundCrossing(R: number, after: number): number {
    if (this.degenerate) return this.radialCrossing(R, after, 1);
    if (this.isElliptic && this.apoapsis <= R) return NaN;
    const nu = this.trueAnomalyAtRadius(R);
    if (isNaN(nu)) return NaN;
    return this.nextTimeAtTrueAnomaly(nu, after);
  }

  /** Numeric crossing search for radial trajectories. */
  private radialCrossing(R: number, after: number, dir: 1 | -1): number {
    const horizon = isFinite(this.period) ? this.period : 30 * 86400;
    const steps = 400;
    let prevT = after;
    this.getStateAt(prevT, _tmpA);
    let prevR = _tmpA.length();
    for (let i = 1; i <= steps; i++) {
      const t = after + (horizon * i) / steps;
      this.getStateAt(t, _tmpA);
      const r = _tmpA.length();
      if ((dir < 0 && prevR > R && r <= R) || (dir > 0 && prevR < R && r >= R)) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 50; k++) {
          const mid = 0.5 * (lo + hi);
          this.getStateAt(mid, _tmpA);
          const rm = _tmpA.length();
          if ((dir < 0 && rm > R) || (dir > 0 && rm < R)) lo = mid;
          else hi = mid;
        }
        return 0.5 * (lo + hi);
      }
      prevT = t;
      prevR = r;
    }
    return NaN;
  }
}

/** Orbital frame helpers used by maneuver nodes & SAS modes. */
export function orbitalFrame(r: Vector3, v: Vector3, prograde: Vector3, normal: Vector3, radial: Vector3): void {
  prograde.copy(v).normalize();
  normal.crossVectors(r, v);
  if (normal.lengthSq() < 1e-20) {
    normal.set(0, 1, 0).cross(prograde);
    if (normal.lengthSq() < 1e-12) normal.set(1, 0, 0);
  }
  normal.normalize();
  radial.crossVectors(prograde, normal).normalize();
}
