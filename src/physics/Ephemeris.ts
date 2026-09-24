/**
 * LEARNING NOTE: Where are the planets right now? (ephemerides)
 *
 * An ephemeris gives the position of a celestial body at a given time. APOGEE starts
 * every game on a real calendar date, so the Sun, the Moon's phase, and Earth's
 * rotation match the real sky for that moment: launch "at 09:30 local time from
 * Cape Canaveral" and the Sun really is in the east.
 *
 * - Earth & Mars use JPL's approximate Keplerian elements (valid 1800–2050).
 * - The Moon uses the low-precision series from the Astronomical Almanac (~0.3°);
 *   we then freeze its orbit as a two-body Kepler ellipse for the patched-conic
 *   simulation so the game's physics stays self-consistent.
 * - Earth's spin uses the IAU rotation model (prime meridian angle W).
 *
 * Frames: "ecliptic" (x→vernal equinox, z→ecliptic pole) is rotated by the obliquity
 * into equatorial J2000, then mapped into the game frame (+Y = celestial north).
 *
 * Key concepts: Julian date, J2000 epoch, ecliptic vs equatorial coordinates,
 * mean anomaly, sidereal time
 * Further reading: https://ssd.jpl.nasa.gov/planets/approx_pos.html
 */
import { Vector3 } from 'three';
import { DEG, J2000_UNIX_MS, OBLIQUITY, SECONDS_PER_DAY, TAU } from '../core/constants';

export function utFromDate(date: Date): number {
  return (date.getTime() - J2000_UNIX_MS) / 1000;
}

export function dateFromUt(ut: number): Date {
  return new Date(J2000_UNIX_MS + ut * 1000);
}

export function julianCenturies(ut: number): number {
  return ut / SECONDS_PER_DAY / 36525;
}

/** Map standard equatorial (x→equinox, z→north) into the game frame (+Y north). */
export function equatorialToGame(x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x, z, -y);
}

/** Map ecliptic coordinates into the game frame. */
export function eclipticToGame(x: number, y: number, z: number, out: Vector3): Vector3 {
  const ce = Math.cos(OBLIQUITY);
  const se = Math.sin(OBLIQUITY);
  const yq = y * ce - z * se;
  const zq = y * se + z * ce;
  return equatorialToGame(x, yq, zq, out);
}

export interface EclipticElements {
  /** semi-major axis (m) */
  a: number;
  e: number;
  /** inclination to ecliptic (rad) */
  i: number;
  /** mean longitude L at J2000 (rad) */
  L: number;
  /** longitude of perihelion ϖ (rad) */
  varpi: number;
  /** longitude of ascending node Ω (rad) */
  node: number;
}

/** Solve Kepler's equation E - e sinE = M for elliptic orbits. */
export function solveKeplerElliptic(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) {
    const f = E - e * Math.sin(E) - M;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

/**
 * Heliocentric state vector from ecliptic mean elements at time ut, converted into
 * the game (equatorial, +Y north) frame.
 */
export function stateFromEclipticElements(el: EclipticElements, mu: number, ut: number, outR: Vector3, outV: Vector3): void {
  const n = Math.sqrt(mu / (el.a * el.a * el.a));
  const M0 = el.L - el.varpi;
  const M = M0 + n * ut;
  const w = el.varpi - el.node;
  const E = solveKeplerElliptic(((M % TAU) + TAU) % TAU, el.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  // Perifocal position/velocity
  const xp = el.a * (cosE - el.e);
  const yp = b * sinE;
  const rdotFactor = n / (1 - el.e * cosE);
  const vxp = -el.a * sinE * rdotFactor;
  const vyp = b * cosE * rdotFactor;
  // Rotate perifocal → ecliptic by (Ω, i, ω)
  const cO = Math.cos(el.node);
  const sO = Math.sin(el.node);
  const ci = Math.cos(el.i);
  const si = Math.sin(el.i);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const r11 = cO * cw - sO * sw * ci;
  const r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci;
  const r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si;
  const r32 = cw * si;
  eclipticToGame(r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp, outR);
  eclipticToGame(r11 * vxp + r12 * vyp, r21 * vxp + r22 * vyp, r31 * vxp + r32 * vyp, outV);
}

export const EARTH_ELEMENTS: EclipticElements = {
  a: 1.00000261 * 1.495978707e11,
  e: 0.01671123,
  i: -0.00001531 * DEG,
  L: 100.46457166 * DEG,
  varpi: 102.93768193 * DEG,
  node: 0,
};

export const MARS_ELEMENTS: EclipticElements = {
  a: 1.52371034 * 1.495978707e11,
  e: 0.0933941,
  i: 1.84969142 * DEG,
  L: -4.55343205 * DEG,
  varpi: -23.94362959 * DEG,
  node: 49.55953891 * DEG,
};

/**
 * Low-precision geocentric Moon position (Astronomical Almanac), game frame, metres.
 */
export function moonGeocentricPosition(ut: number, out: Vector3): Vector3 {
  const T = julianCenturies(ut);
  const d = (deg: number) => deg * DEG;
  const lambda =
    218.32 +
    481267.881 * T +
    6.29 * Math.sin(d(135.0 + 477198.87 * T)) -
    1.27 * Math.sin(d(259.3 - 413335.36 * T)) +
    0.66 * Math.sin(d(235.7 + 890534.22 * T)) +
    0.21 * Math.sin(d(269.9 + 954397.74 * T)) -
    0.19 * Math.sin(d(357.5 + 35999.05 * T)) -
    0.11 * Math.sin(d(186.5 + 966404.03 * T));
  const beta =
    5.13 * Math.sin(d(93.3 + 483202.02 * T)) +
    0.28 * Math.sin(d(228.2 + 960400.89 * T)) -
    0.28 * Math.sin(d(318.3 + 6003.15 * T)) -
    0.17 * Math.sin(d(217.6 - 407332.21 * T));
  const parallax =
    0.9508 +
    0.0518 * Math.cos(d(135.0 + 477198.87 * T)) +
    0.0095 * Math.cos(d(259.3 - 413335.36 * T)) +
    0.0078 * Math.cos(d(235.7 + 890534.22 * T)) +
    0.0028 * Math.cos(d(269.9 + 954397.74 * T));
  const dist = 6378140 / Math.sin(d(parallax));
  const lam = d(lambda);
  const bet = d(beta);
  const x = dist * Math.cos(bet) * Math.cos(lam);
  const y = dist * Math.cos(bet) * Math.sin(lam);
  const z = dist * Math.sin(bet);
  return eclipticToGame(x, y, z, out);
}

export function moonGeocentricState(ut: number, outR: Vector3, outV: Vector3): void {
  const h = 60;
  const a = new Vector3();
  const b = new Vector3();
  moonGeocentricPosition(ut - h, a);
  moonGeocentricPosition(ut + h, b);
  moonGeocentricPosition(ut, outR);
  outV.copy(b).sub(a).multiplyScalar(1 / (2 * h));
}

/** IAU prime-meridian rotation angle for Earth (rad), counted from the equator node at RA 90°. */
export function earthRotationAngle(ut: number): number {
  const days = ut / SECONDS_PER_DAY;
  return (190.147 + 360.9856235 * days) * DEG;
}
