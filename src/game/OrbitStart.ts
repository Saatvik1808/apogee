/**
 * LEARNING NOTE: Skipping the launch
 *
 * Practising rendezvous, a lunar capture or a re-entry does not need a rocket
 * climbing out of the atmosphere every time. A sandbox can put the vehicle
 * straight into a well-defined circular orbit — the same way flight simulators
 * offer "start in the air". Each preset names the body, altitude and
 * inclination; the simulation computes the matching state vector.
 *
 * Key concepts: initial conditions, circular orbit speed v = √(μ/r)
 */
import type { BodyId } from '../physics/CelestialBody';

export type OrbitStart = 'pad' | 'leo' | 'geo' | 'moon' | 'mars';

export interface OrbitStartSpec {
  label: string;
  sub: string;
  body: BodyId;
  altKm: number;
  incDeg: number;
}

export const ORBIT_STARTS: Record<OrbitStart, OrbitStartSpec> = {
  pad: { label: 'Launch pad', sub: 'Fly the whole ascent', body: 'earth', altKm: 0, incDeg: 0 },
  leo: { label: 'Low Earth orbit', sub: '250 km, 28.6°', body: 'earth', altKm: 250, incDeg: 28.6 },
  geo: { label: 'Geostationary', sub: '35,786 km, equatorial', body: 'earth', altKm: 35_786, incDeg: 0 },
  moon: { label: 'Lunar orbit', sub: '100 km above the Moon', body: 'moon', altKm: 100, incDeg: 0 },
  mars: { label: 'Mars orbit', sub: '300 km above Mars', body: 'mars', altKm: 300, incDeg: 0 },
};

export const ORBIT_START_IDS: OrbitStart[] = ['pad', 'leo', 'geo', 'moon', 'mars'];
