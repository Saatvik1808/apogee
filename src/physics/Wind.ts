/**
 * LEARNING NOTE: Wind — the atmosphere is not standing still
 *
 * Aerodynamic forces depend on the rocket's velocity relative to the AIR, not
 * the ground: v_air = v_ground − wind. Wind matters most in three places:
 *
 *  • LAUNCH: a crosswind puts the rocket at an angle of attack right when it is
 *    slow and heavy. Launch rules really do scrub for high winds.
 *  • MAX-Q: the jet stream (a river of 30–60 m/s wind at 10–12 km, blowing from
 *    the west at mid-latitudes) hits exactly where dynamic pressure peaks. Real
 *    launches measure upper winds with balloons an hour before liftoff and upload
 *    a steering profile ("day-of-launch wind biasing").
 *  • LANDING: parachutes drift downwind, and a lander's legs don't like sideways
 *    touchdowns.
 *
 * Our model is a smooth vertical profile — surface wind, a jet-stream peak, calm
 * upper air — whose direction veers with height, plus GUSTS: a few sine waves
 * with incommensurate periods, which gives natural-looking turbulence without
 * any random numbers per frame. Each flight rolls its own weather from a seed.
 *
 * Key concepts: air-relative velocity, wind shear, jet stream, gust models,
 * deterministic pseudo-random weather
 */
import { Vector3 } from 'three';
import type { BodyId } from './CelestialBody';

export interface WindReport {
  /** Surface wind speed (m/s) and the direction it blows FROM (degrees). */
  surfaceSpeed: number;
  surfaceFrom: number;
  /** Peak upper-level wind (m/s) and its altitude (m). */
  jetSpeed: number;
  jetAltitude: number;
}

/** Mulberry32: tiny seeded PRNG so each flight's weather is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEG = Math.PI / 180;

export class WindField {
  readonly report: WindReport;
  private readonly surfaceDir: number;
  private readonly jetDir: number;
  private readonly marsSpeed: number;
  private readonly marsDir: number;
  private readonly phases: number[];
  /** Scales every wind (settings / tests can switch weather off). */
  strength = 1;

  constructor(seed: number) {
    const r = rng(seed);
    const surface = 2 + r() * 7;
    const surfaceFrom = r() * 360;
    const jet = 22 + r() * 38;
    const jetAlt = 10_500 + r() * 2_500;
    this.report = { surfaceSpeed: surface, surfaceFrom, jetSpeed: jet, jetAltitude: jetAlt };
    // Directions are stored as the way the air MOVES (from + 180°); jet blows from the west ± 30°
    this.surfaceDir = (surfaceFrom + 180) * DEG;
    this.jetDir = (90 + (r() - 0.5) * 60) * DEG;
    this.marsSpeed = 4 + r() * 10;
    this.marsDir = r() * 360 * DEG;
    this.phases = [r(), r(), r(), r(), r(), r()].map((x) => x * Math.PI * 2);
  }

  /**
   * Wind vector in the local frame (east/north unit vectors given) at `alt` metres
   * above sea level on `body`, at simulation time `t`.
   */
  sample(body: BodyId, alt: number, t: number, east: Vector3, north: Vector3, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    if (this.strength <= 0 || alt < -1000) return out;
    let speed = 0;
    let dir = 0;
    let gustAmp = 0;
    if (body === 'earth') {
      if (alt > 60_000) return out;
      const rep = this.report;
      // Speed: log-ish growth from the surface, jet-stream bump, calm stratosphere
      const s0 = rep.surfaceSpeed * Math.min(1.6, 1 + Math.log1p(Math.max(0, alt) / 200) * 0.12);
      const jet = rep.jetSpeed * Math.exp(-(((alt - rep.jetAltitude) / 4_500) ** 2));
      const strat = 12 * Math.exp(-(((alt - 30_000) / 12_000) ** 2));
      speed = s0 * Math.exp(-alt / 9_000) + jet + strat;
      // Direction veers from the surface wind to the jet with height (Ekman-like)
      const k = Math.min(1, Math.max(0, alt / rep.jetAltitude));
      dir = this.surfaceDir + angleDiff(this.jetDir, this.surfaceDir) * k;
      gustAmp = 0.22 * Math.exp(-alt / 3_000) + 0.1;
    } else if (body === 'mars') {
      if (alt > 40_000) return out;
      speed = this.marsSpeed * (1 + Math.min(1.5, Math.max(0, alt) / 8_000));
      dir = this.marsDir;
      gustAmp = 0.3;
    } else {
      return out;
    }
    // Gusts: incommensurate sines (no per-frame randomness → smooth and repeatable)
    const p = this.phases;
    const g =
      Math.sin(t * 0.37 + p[0]!) * 0.5 +
      Math.sin(t * 1.13 + p[1]!) * 0.3 +
      Math.sin(t * 2.71 + p[2]!) * 0.2;
    const lateral = Math.sin(t * 0.61 + p[3]!) * 0.5 + Math.sin(t * 1.9 + p[4]!) * 0.3;
    speed *= this.strength * (1 + gustAmp * g);
    const d = dir + lateral * gustAmp * 0.8;
    return out.copy(east).multiplyScalar(Math.sin(d) * speed).addScaledVector(north, Math.cos(d) * speed);
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
