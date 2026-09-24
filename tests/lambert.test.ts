/**
 * LEARNING NOTE: Checking Lambert against the textbook
 *
 * Curtis, "Orbital Mechanics for Engineering Students", Example 5.2: a
 * spacecraft goes from r1 to r2 around Earth in one hour. The published
 * velocities let us verify the universal-variable solver to three decimals.
 * A second check confirms that a porkchop search between Earth and Mars finds
 * the classic ~3 km/s departure v∞ with a 6–10 month flight.
 *
 * Key concepts: regression tests against reference solutions
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { porkchop, solveLambert } from '../src/physics/Lambert';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';

describe('Lambert solver', () => {
  it('matches Curtis example 5.2', () => {
    const km = 1000;
    const r1 = new Vector3(5000, 10000, 2100).multiplyScalar(km);
    const r2 = new Vector3(-14600, 2500, 7000).multiplyScalar(km);
    const sol = solveLambert(r1, r2, 3600, 398600e9, new Vector3().crossVectors(r1, r2));
    expect(sol).not.toBeNull();
    const v1 = sol!.v1.clone().multiplyScalar(1 / km);
    const v2 = sol!.v2.clone().multiplyScalar(1 / km);
    expect(v1.x).toBeCloseTo(-5.9925, 3);
    expect(v1.y).toBeCloseTo(1.9254, 3);
    expect(v1.z).toBeCloseTo(3.2456, 3);
    expect(v2.x).toBeCloseTo(-3.3125, 3);
    expect(v2.y).toBeCloseTo(-4.1966, 3);
    expect(v2.z).toBeCloseTo(-0.38529, 3);
  });

  it('finds the late-2026 Earth → Mars window', () => {
    const t0 = utFromDate(new Date(Date.UTC(2026, 8, 24)));
    const sys = new SolarSystem(t0);
    const src = (b: typeof sys.earth) => ({ stateAt: (t: number, r: Vector3, v: Vector3) => b.relativeStateAt(t, r, v) });
    const best = porkchop(t0, 240 * 86400, 150 * 86400, 330 * 86400, sys.sun.mu, src(sys.earth), src(sys.mars));
    expect(best).not.toBeNull();
    const vinf = Math.sqrt(best!.c3);
    const days = (best!.arrive - best!.depart) / 86400;
    const dep = new Date(Date.UTC(2000, 0, 1, 12) + best!.depart * 1000).toISOString().slice(0, 10);
    const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
    if (env?.env.APOGEE_REPORT) env.stderr.write(`Mars window: depart ${dep}, ${days.toFixed(0)} days, v∞ ${vinf.toFixed(0)} m/s, arrival v∞ ${best!.vInfArrive.length().toFixed(0)} m/s\n`);
    expect(vinf).toBeGreaterThan(2500);
    expect(vinf).toBeLessThan(4200);
    expect(days).toBeGreaterThan(150);
    expect(days).toBeLessThan(330);
  });
});
