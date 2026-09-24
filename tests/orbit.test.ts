/**
 * LEARNING NOTE: Testing physics against ground truth
 *
 * Analytic orbit propagation is only trustworthy if it agrees with brute-force
 * numerical integration (RK4 with tiny steps) and with known astronomy (the Sun's
 * declination at an equinox, the Moon's phase on a known date). These tests pin
 * those facts down so later refactors can't silently break the universe.
 *
 * Key concepts: Runge–Kutta integration as a reference solution, invariants
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Orbit } from '../src/physics/Orbit';
import { SolarSystem } from '../src/physics/SolarSystem';
import { CelestialBody } from '../src/physics/CelestialBody';
import { utFromDate } from '../src/physics/Ephemeris';
import { EarthAtmosphere } from '../src/physics/Atmosphere';
import { createAtmosphereSample } from '../src/physics/Atmosphere';

const MU = 3.986004418e14;

function rk4(r: Vector3, v: Vector3, mu: number, T: number, dt: number): void {
  const acc = (p: Vector3) => {
    const d = p.length();
    return p.clone().multiplyScalar(-mu / (d * d * d));
  };
  let t = 0;
  while (t < T - 1e-12) {
    const h = Math.min(dt, T - t);
    const k1v = acc(r);
    const k1r = v.clone();
    const k2v = acc(r.clone().addScaledVector(k1r, h / 2));
    const k2r = v.clone().addScaledVector(k1v, h / 2);
    const k3v = acc(r.clone().addScaledVector(k2r, h / 2));
    const k3r = v.clone().addScaledVector(k2v, h / 2);
    const k4v = acc(r.clone().addScaledVector(k3r, h));
    const k4r = v.clone().addScaledVector(k3v, h);
    r.addScaledVector(k1r, h / 6).addScaledVector(k2r, h / 3).addScaledVector(k3r, h / 3).addScaledVector(k4r, h / 6);
    v.addScaledVector(k1v, h / 6).addScaledVector(k2v, h / 3).addScaledVector(k3v, h / 3).addScaledVector(k4v, h / 6);
    t += h;
  }
}

describe('Orbit', () => {
  it('circular equatorial orbit has sane elements and closes after one period', () => {
    const r = 7e6;
    const vc = Math.sqrt(MU / r);
    const o = new Orbit().setFromState(new Vector3(r, 0, 0), new Vector3(0, 0, -vc), MU, 100);
    expect(o.e).toBeLessThan(1e-9);
    expect(o.a).toBeCloseTo(r, 0);
    expect(o.inc).toBeLessThan(1e-9);
    const out = new Vector3();
    o.getStateAt(100 + o.period, out);
    expect(out.distanceTo(new Vector3(r, 0, 0))).toBeLessThan(1e-3);
    o.getStateAt(100 + o.period / 4, out);
    expect(out.distanceTo(new Vector3(0, 0, -r))).toBeLessThan(1e-2);
  });

  it('matches RK4 for an inclined ellipse', () => {
    const r0 = new Vector3(7e6, 0, 0);
    const v0 = new Vector3(0, 1500, -8200);
    const o = new Orbit().setFromState(r0, v0, MU, 0);
    const r = r0.clone();
    const v = v0.clone();
    rk4(r, v, MU, 3000, 0.5);
    const out = new Vector3();
    const outV = new Vector3();
    o.getStateAt(3000, out, outV);
    expect(out.distanceTo(r)).toBeLessThan(0.5);
    expect(outV.distanceTo(v)).toBeLessThan(1e-3);
    expect(o.inc).toBeGreaterThan(0.1);
  });

  it('matches RK4 for a hyperbola, forward and backward', () => {
    const r0 = new Vector3(7e6, 0, 0);
    const v0 = new Vector3(0, 800, -12000);
    const o = new Orbit().setFromState(r0, v0, MU, 1000);
    expect(o.e).toBeGreaterThan(1);
    const r = r0.clone();
    const v = v0.clone();
    rk4(r, v, MU, 20000, 0.5);
    const out = new Vector3();
    o.getStateAt(21000, out);
    expect(out.distanceTo(r) / r.length()).toBeLessThan(1e-7);
    const r2 = r0.clone();
    const v2 = v0.clone().multiplyScalar(-1);
    rk4(r2, v2, MU, 5000, 0.5);
    o.getStateAt(1000 - 5000, out);
    expect(out.distanceTo(r2) / r2.length()).toBeLessThan(1e-7);
  });

  it('handles a radial (degenerate) trajectory', () => {
    const r0 = new Vector3(0, 6.5e6, 0);
    const v0 = new Vector3(0, 3000, 0);
    const o = new Orbit().setFromState(r0, v0, MU, 0);
    expect(o.degenerate).toBe(true);
    const r = r0.clone();
    const v = v0.clone();
    rk4(r, v, MU, 500, 0.1);
    const out = new Vector3();
    o.getStateAt(500, out);
    expect(out.distanceTo(r)).toBeLessThan(0.5);
    const tImpact = o.nextInboundCrossing(6.371e6, 0);
    expect(tImpact).toBeGreaterThan(500);
    o.getStateAt(tImpact, out);
    expect(Math.abs(out.length() - 6.371e6)).toBeLessThan(1);
  });

  it('finds atmosphere entry and periapsis times consistently', () => {
    const o = new Orbit().setFromState(new Vector3(6.371e6 + 300e3, 0, 0), new Vector3(0, 0, -7500), MU, 50);
    expect(o.periapsis).toBeLessThan(6.371e6 + 140e3);
    const R = 6.371e6 + 140e3;
    const t = o.nextInboundCrossing(R, 50);
    const out = new Vector3();
    const outV = new Vector3();
    o.getStateAt(t, out, outV);
    expect(Math.abs(out.length() - R)).toBeLessThan(0.1);
    expect(out.dot(outV)).toBeLessThan(0);
    const tpe = o.nextTimeAtTrueAnomaly(0, 50);
    o.getStateAt(tpe, out);
    expect(Math.abs(out.length() - o.periapsis)).toBeLessThan(0.1);
    expect(o.timeToApoapsis(50)).toBeGreaterThanOrEqual(0);
  });

  it('inclination and node follow the game frame convention', () => {
    // Launch due east from latitude 28.6° lands in a 28.6° inclined orbit with the
    // position at the launch site being the northernmost point (node 90° behind).
    const lat = 28.6 * Math.PI / 180;
    const r = new Vector3(Math.cos(lat), Math.sin(lat), 0).multiplyScalar(6.6e6);
    const east = new Vector3(0, 0, -1); // east at longitude 0 in the game frame
    const o = new Orbit().setFromState(r, east.multiplyScalar(7800), MU, 0);
    expect(o.inc * 180 / Math.PI).toBeCloseTo(28.6, 3);
  });
});

describe('Solar system ephemeris', () => {
  const ut = utFromDate(new Date(Date.UTC(2026, 8, 24, 17, 14, 0)));
  const sys = new SolarSystem(ut);

  it('Earth–Sun distance and solar declination near the September equinox', () => {
    const d = sys.earth.position.length();
    expect(d / 1.495978707e11).toBeGreaterThan(0.998);
    expect(d / 1.495978707e11).toBeLessThan(1.008);
    const sunDir = sys.sun.position.clone().sub(sys.earth.position).normalize();
    const dec = Math.asin(sunDir.y) * 180 / Math.PI;
    expect(dec).toBeGreaterThan(-1.6);
    expect(dec).toBeLessThan(0.2);
  });

  it('Moon is waxing gibbous two days before the 26 Sep 2026 full moon', () => {
    const moonDir = sys.moon.position.clone().sub(sys.earth.position);
    const dist = moonDir.length();
    expect(dist).toBeGreaterThan(3.5e8);
    expect(dist).toBeLessThan(4.1e8);
    const sunDir = sys.sun.position.clone().sub(sys.earth.position).normalize();
    const elong = Math.acos(moonDir.normalize().dot(sunDir)) * 180 / Math.PI;
    expect(elong).toBeGreaterThan(140);
    expect(elong).toBeLessThan(168);
  });

  it('Sun is near local solar noon over Cape Canaveral at 17:14 UTC', () => {
    const lat = 28.6082 * Math.PI / 180;
    const lon = -80.6041 * Math.PI / 180;
    const up = CelestialBody.dirFromLatLon(lat, lon, new Vector3()).applyQuaternion(sys.earth.rotation);
    const sunDir = sys.sun.position.clone().sub(sys.earth.position).normalize();
    const elev = Math.asin(up.dot(sunDir)) * 180 / Math.PI;
    expect(elev).toBeGreaterThan(58);
    expect(elev).toBeLessThan(63);
  });

  it('Moon keeps the same face toward Earth (tidal lock)', () => {
    for (const dt of [0, 5 * 86400, 13 * 86400]) {
      sys.update(ut + dt);
      const toEarth = sys.earth.position.clone().sub(sys.moon.position).normalize();
      const lon0 = new Vector3(1, 0, 0).applyQuaternion(sys.moon.rotation);
      const angle = Math.acos(Math.min(1, lon0.dot(toEarth))) * 180 / Math.PI;
      expect(angle).toBeLessThan(9); // optical libration only
    }
    sys.update(ut);
  });
});

describe('Atmosphere', () => {
  it('matches USSA-1976 reference values', () => {
    const atm = new EarthAtmosphere();
    const s = createAtmosphereSample();
    atm.sample(0, s);
    expect(s.density).toBeCloseTo(1.225, 3);
    atm.sample(11019, s); // geometric altitude of the 11 km geopotential tropopause
    expect(Math.abs(s.pressure - 22632) / 22632).toBeLessThan(0.001);
    atm.sample(50000, s);
    expect(s.density).toBeGreaterThan(9e-4);
    expect(s.density).toBeLessThan(1.1e-3);
    atm.sample(120000, s);
    expect(s.density).toBeCloseTo(2.222e-8, 10);
  });
});
