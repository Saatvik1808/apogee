/**
 * LEARNING NOTE: Sanity-checking the sky
 *
 * Physically based LUTs can be validated with simple expectations: sunlight at
 * noon is only slightly dimmed, at sunset it is strongly reddened (blue lost
 * first), and a point in the planet's shadow gets no direct sun at all.
 *
 * Key concepts: transmittance, Rayleigh wavelength dependence
 */
import { describe, expect, it } from 'vitest';
import { AtmosphereLUTs, EARTH_ATMOSPHERE } from '../src/render/atmosphere/AtmosphereModel';

describe('Atmosphere LUTs', () => {
  const t0 = performance.now();
  const lut = new AtmosphereLUTs(EARTH_ATMOSPHERE);
  const ms = performance.now() - t0;
  it('builds quickly', () => {
    expect(ms).toBeLessThan(3000);
  });
  it('noon sun is bright and slightly yellow; sunset is red', () => {
    const R = EARTH_ATMOSPHERE.bottomRadius + 10;
    const noon = lut.sunTransmittance(R, 1, [0, 0, 0]);
    expect(noon[0]).toBeGreaterThan(0.85);
    expect(noon[2]).toBeGreaterThan(0.6);
    expect(noon[0]).toBeGreaterThan(noon[2]);
    const sunset = lut.sunTransmittance(R, 0.02, [0, 0, 0]);
    expect(sunset[0]).toBeGreaterThan(sunset[1]);
    expect(sunset[1]).toBeGreaterThan(sunset[2]);
    expect(sunset[2]).toBeLessThan(0.1);
    const night = lut.sunTransmittance(R, -0.3, [0, 0, 0]);
    expect(night[0]).toBe(0);
  });
  it('multiple scattering and ambient are positive and bluish by day', () => {
    const m = lut.sampleMS(1000, 0.8);
    expect(m[2]).toBeGreaterThan(m[0]);
    const amb = lut.sampleAmbient(0.8, [0, 0, 0]);
    expect(amb[2]).toBeGreaterThan(amb[0]);
    expect(amb[2]).toBeGreaterThan(0.01);
    const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
    if (env?.env.APOGEE_REPORT) env.stderr.write(`LUT build ${ms.toFixed(0)} ms, MS=${m.map((x) => x.toExponential(2))}, ambient(noon)=${amb.map((x) => x.toFixed(3))}\n`);
  });
});
