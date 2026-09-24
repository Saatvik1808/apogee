/**
 * LEARNING NOTE: Testing encounter prediction with a Hohmann-style lunar transfer
 *
 * We aim a transfer ellipse from low Earth orbit at the point where the Moon will
 * be when we arrive (≈5 days later, the Moon having moved ~66°). The predictor
 * must detect the SOI entry, re-base the orbit around the Moon, and report a
 * hyperbolic flyby (or impact) patch.
 *
 * Key concepts: Hohmann transfer, time of flight, lead angle
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SolarSystem } from '../src/physics/SolarSystem';
import { TrajectoryPredictor } from '../src/physics/Trajectory';
import { utFromDate } from '../src/physics/Ephemeris';

describe('TrajectoryPredictor', () => {
  it('detects a lunar SOI encounter from a trans-lunar injection', () => {
    const t0 = utFromDate(new Date(Date.UTC(2026, 8, 24, 12, 0, 0)));
    const sys = new SolarSystem(t0);
    const earth = sys.earth;
    const moon = sys.moon;
    const mu = earth.mu;
    const rp = earth.radius + 200e3;
    const ra = 3.9e8;
    const a = (rp + ra) / 2;
    const tof = Math.PI * Math.sqrt((a * a * a) / mu);
    const moonArr = new Vector3();
    moon.orbit!.getStateAt(t0 + tof, moonArr);
    const W = moon.orbit!.W.clone();
    // Periapsis opposite to the Moon's arrival position, projected into the Moon plane
    const pDir = moonArr.clone().normalize().negate();
    pDir.addScaledVector(W, -pDir.dot(W)).normalize();
    const r = pDir.clone().multiplyScalar(rp);
    const vp = Math.sqrt(mu * (2 / rp - 1 / a));
    const v = new Vector3().crossVectors(W, pDir).normalize().multiplyScalar(vp);
    const pred = new TrajectoryPredictor();
    const n = pred.predict(earth, r, v, t0, { maxPatches: 4, target: moon });
    expect(n).toBeGreaterThanOrEqual(2);
    const p0 = pred.patches[0]!;
    expect(p0.endReason).toBe('soi-enter');
    expect(p0.nextBody).toBe(moon);
    expect(p0.endTime - t0).toBeGreaterThan(3 * 86400);
    expect(p0.endTime - t0).toBeLessThan(6 * 86400);
    const p1 = pred.patches[1]!;
    expect(p1.body).toBe(moon);
    expect(p1.orbit.e).toBeGreaterThan(1);
    // Entry state must lie on the SOI sphere
    const entry = new Vector3();
    p1.orbit.getStateAt(p1.startTime, entry);
    expect(Math.abs(entry.length() - moon.soiRadius) / moon.soiRadius).toBeLessThan(1e-3);
  });

  it('reports no encounter and a closed orbit for LEO', () => {
    const t0 = utFromDate(new Date(Date.UTC(2026, 8, 24, 12, 0, 0)));
    const sys = new SolarSystem(t0);
    const rp = sys.earth.radius + 300e3;
    const r = new Vector3(rp, 0, 0);
    const v = new Vector3(0, 0, -Math.sqrt(sys.earth.mu / rp));
    const pred = new TrajectoryPredictor();
    const n = pred.predict(sys.earth, r, v, t0, { maxPatches: 4, target: sys.moon });
    expect(n).toBe(1);
    expect(pred.patches[0]!.endReason).toBe('none');
    expect(pred.patches[0]!.closestApproachDistance).toBeGreaterThan(3e8);
  });

  it('detects suborbital impact', () => {
    const t0 = 0;
    const sys = new SolarSystem(t0);
    const R = sys.earth.radius;
    const r = new Vector3(R + 50e3, 0, 0);
    const v = new Vector3(1500, 0, -2000);
    const pred = new TrajectoryPredictor();
    pred.predict(sys.earth, r, v, t0, { maxPatches: 3, target: null });
    const p = pred.patches[0]!;
    expect(p.endReason).toBe('impact');
    const out = new Vector3();
    p.orbit.getStateAt(p.endTime, out);
    expect(Math.abs(out.length() - R)).toBeLessThan(1);
  });
});
