/**
 * LEARNING NOTE: Building the universe at a real date
 *
 * The solar system is a tree: the Sun at the root, Earth and Mars orbiting it,
 * the Moon orbiting Earth. We create each body's Kepler orbit from real
 * ephemeris data at the game's starting date, then let the orbits run "on rails".
 * Updating the tree top-down each frame (parents before children) gives every
 * body's absolute position by summing relative offsets.
 *
 * Key concepts: scene/body hierarchies, osculating orbits, two-body gravitational
 * parameter μ₁ + μ₂ for relative motion
 */
import { Vector3 } from 'three';
import { EarthAtmosphere, MarsAtmosphere } from './Atmosphere';
import { BODY_CONSTANTS, CelestialBody, EARTH_ROTATION, MARS_ROTATION, type BodyId } from './CelestialBody';
import { EARTH_ELEMENTS, MARS_ELEMENTS, moonGeocentricState, stateFromEclipticElements } from './Ephemeris';
import { Orbit } from './Orbit';

export class SolarSystem {
  readonly sun: CelestialBody;
  readonly earth: CelestialBody;
  readonly moon: CelestialBody;
  readonly mars: CelestialBody;
  /** Parents precede children — safe update order. */
  readonly ordered: CelestialBody[];
  readonly epoch: number;
  time = 0;

  constructor(epochUt: number) {
    this.epoch = epochUt;
    const C = BODY_CONSTANTS;
    this.sun = new CelestialBody({
      id: 'sun',
      name: 'Sun',
      mu: C.sun.mu,
      radius: C.sun.radius,
      soiRadius: Infinity,
      rotation: { kind: 'none' },
      atmosphere: null,
      atmosphereHeight: 0,
      albedo: [1, 1, 1],
    });
    this.earth = new CelestialBody({
      id: 'earth',
      name: 'Earth',
      mu: C.earth.mu,
      radius: C.earth.radius,
      soiRadius: 9.24e8,
      rotation: EARTH_ROTATION,
      atmosphere: new EarthAtmosphere(),
      atmosphereHeight: 100_000,
      albedo: [0.2, 0.26, 0.34],
    });
    this.moon = new CelestialBody({
      id: 'moon',
      name: 'Moon',
      mu: C.moon.mu,
      radius: C.moon.radius,
      soiRadius: 6.61e7,
      rotation: { kind: 'tidal' },
      atmosphere: null,
      atmosphereHeight: 0,
      albedo: [0.12, 0.115, 0.11],
    });
    this.mars = new CelestialBody({
      id: 'mars',
      name: 'Mars',
      mu: C.mars.mu,
      radius: C.mars.radius,
      soiRadius: 5.78e8,
      rotation: MARS_ROTATION,
      atmosphere: new MarsAtmosphere(),
      atmosphereHeight: 80_000,
      albedo: [0.33, 0.2, 0.12],
    });

    this.attach(this.earth, this.sun);
    this.attach(this.mars, this.sun);
    this.attach(this.moon, this.earth);

    const r = new Vector3();
    const v = new Vector3();
    stateFromEclipticElements(EARTH_ELEMENTS, C.sun.mu + C.earth.mu, epochUt, r, v);
    this.earth.orbit = new Orbit().setFromState(r, v, C.sun.mu + C.earth.mu, epochUt);
    stateFromEclipticElements(MARS_ELEMENTS, C.sun.mu + C.mars.mu, epochUt, r, v);
    this.mars.orbit = new Orbit().setFromState(r, v, C.sun.mu + C.mars.mu, epochUt);
    moonGeocentricState(epochUt, r, v);
    this.moon.orbit = new Orbit().setFromState(r, v, C.earth.mu + C.moon.mu, epochUt);

    this.ordered = [this.sun, this.earth, this.mars, this.moon];
    this.update(epochUt);
  }

  private attach(child: CelestialBody, parent: CelestialBody): void {
    child.parent = parent;
    parent.children.push(child);
  }

  update(t: number): void {
    this.time = t;
    for (const b of this.ordered) b.update(t);
  }

  get(id: BodyId): CelestialBody {
    switch (id) {
      case 'sun':
        return this.sun;
      case 'earth':
        return this.earth;
      case 'moon':
        return this.moon;
      case 'mars':
        return this.mars;
    }
  }

  /** Unit direction from an absolute position toward the Sun centre. */
  sunDirection(absPos: Vector3, out: Vector3): Vector3 {
    return out.copy(this.sun.position).sub(absPos).normalize();
  }

  /**
   * Fraction of the Sun's disc visible from absPos (0 = full eclipse), accounting
   * for occlusion by every planet/moon (soft penumbra by disc overlap).
   */
  sunVisibility(absPos: Vector3): number {
    const toSun = _a.copy(this.sun.position).sub(absPos);
    const dSun = toSun.length();
    toSun.multiplyScalar(1 / dSun);
    const sunAngR = Math.asin(Math.min(1, this.sun.radius / dSun));
    let vis = 1;
    for (const b of this.ordered) {
      if (b === this.sun) continue;
      const toB = _b.copy(b.position).sub(absPos);
      const dB = toB.length();
      if (dB > dSun || dB < b.radius * 0.999) continue;
      const bodyAngR = Math.asin(Math.min(1, b.radius / dB));
      const sep = Math.acos(Math.max(-1, Math.min(1, toB.dot(toSun) / dB)));
      if (sep >= sunAngR + bodyAngR) continue;
      // Largest possible occlusion: total (body bigger) or annular (body smaller)
      const maxOcc = bodyAngR >= sunAngR ? 1 : (bodyAngR * bodyAngR) / (sunAngR * sunAngR);
      const inner = Math.abs(bodyAngR - sunAngR);
      let occ = maxOcc;
      if (sep > inner) {
        // Partial overlap: smooth ramp through the penumbra
        const t = (sep - inner) / (sunAngR + bodyAngR - inner);
        occ = maxOcc * (1 - t * t * (3 - 2 * t));
      }
      vis = Math.min(vis, 1 - occ);
    }
    return vis;
  }
}

const _a = new Vector3();
const _b = new Vector3();
