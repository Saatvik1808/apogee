/**
 * LEARNING NOTE: Celestial bodies and the "patched conics" hierarchy
 *
 * Real spaceflight has every body pulling on every other body (the n-body
 * problem, which has no closed-form solution). The patched-conic approximation —
 * used for Apollo mission planning and by games like Kerbal Space Program — says:
 * inside a body's Sphere Of Influence (SOI) only THAT body's gravity matters.
 * Each body therefore orbits its parent on a fixed Kepler conic ("on rails"),
 * and a spacecraft switches reference body when it crosses an SOI boundary.
 *
 * Sun → Earth → Moon, Sun → Mars. Each body knows its gravitational parameter
 * μ = G·M, radius, SOI radius, rotation and (optionally) atmosphere & terrain.
 *
 * Positions are always "absolute" (relative to the Sun, in a non-rotating frame
 * aligned with Earth's equator). Surface points are expressed in a rotating
 * "body-fixed" frame (latitude/longitude) and converted with the body's rotation.
 *
 * Key concepts: sphere of influence r_SOI = a·(m/M)^(2/5), body-fixed vs inertial
 * frames, sidereal rotation, tidal locking
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { DEG } from '../core/constants';
import type { AtmosphereModel } from './Atmosphere';
import { Orbit } from './Orbit';

export type BodyId = 'sun' | 'earth' | 'moon' | 'mars';

/** CPU-side terrain height provider (metres above body radius). */
export interface TerrainProvider {
  readonly maxHeight: number;
  readonly minHeight: number;
  /** Height above the reference radius at unit body-fixed direction `dir`. */
  heightAt(dir: Vector3): number;
  /** True where the surface is liquid water (ocean). */
  isWater(dir: Vector3): boolean;
}

export type RotationModel =
  | { kind: 'iau'; poleRa: number; poleDec: number; w0: number; wRate: number }
  | { kind: 'tidal' }
  | { kind: 'none' };

export interface BodyConfig {
  id: BodyId;
  name: string;
  mu: number;
  radius: number;
  soiRadius: number;
  rotation: RotationModel;
  atmosphere: AtmosphereModel | null;
  /** Visual/physical atmosphere top used for rendering (m). */
  atmosphereHeight: number;
  /** Mean surface albedo colour (linear RGB) used by environment lighting. */
  albedo: [number, number, number];
}

const _v = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _qAxis = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);

export class CelestialBody {
  readonly id: BodyId;
  readonly name: string;
  readonly mu: number;
  readonly radius: number;
  readonly soiRadius: number;
  readonly rotationModel: RotationModel;
  readonly atmosphere: AtmosphereModel | null;
  readonly atmosphereHeight: number;
  readonly albedo: [number, number, number];

  parent: CelestialBody | null = null;
  readonly children: CelestialBody[] = [];
  /** Orbit around parent (null for the root). */
  orbit: Orbit | null = null;
  terrain: TerrainProvider | null = null;

  /** Cached state at `cachedTime` (absolute frame). */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  /** Body-fixed → inertial rotation at `cachedTime`. */
  readonly rotation = new Quaternion();
  readonly rotationInverse = new Quaternion();
  /** Angular velocity vector (inertial frame, rad/s). */
  readonly angularVelocity = new Vector3();
  cachedTime = NaN;

  /** Pole-frame quaternion (Y → rotation axis) for IAU / tidal models. */
  private readonly poleFrame = new Quaternion();
  private spinRate = 0;
  private spinAngle0 = 0;

  constructor(cfg: BodyConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.mu = cfg.mu;
    this.radius = cfg.radius;
    this.soiRadius = cfg.soiRadius;
    this.rotationModel = cfg.rotation;
    this.atmosphere = cfg.atmosphere;
    this.atmosphereHeight = cfg.atmosphereHeight;
    this.albedo = cfg.albedo;
    this.setupRotation();
  }

  private setupRotation(): void {
    const rm = this.rotationModel;
    if (rm.kind === 'iau') {
      // Pole direction in game frame
      const ra = rm.poleRa;
      const dec = rm.poleDec;
      const pole = new Vector3(Math.cos(dec) * Math.cos(ra), Math.sin(dec), -Math.cos(dec) * Math.sin(ra));
      // IAU: prime meridian angle W measured from the node of the body's equator on
      // the ICRF equator, located at RA (α0 + 90°).
      const nodeRa = ra + Math.PI / 2;
      const node = new Vector3(Math.cos(nodeRa), 0, -Math.sin(nodeRa));
      // Frame with Y = pole, X = node, Z = X × Y (right-handed)
      const z = new Vector3().crossVectors(node, pole).normalize();
      _m.makeBasis(node, pole, z);
      this.poleFrame.setFromRotationMatrix(_m);
      this.spinRate = rm.wRate;
      this.spinAngle0 = rm.w0;
    }
  }

  /** Rotation angle about the pole at time t (rad). */
  spinAngle(t: number): number {
    const rm = this.rotationModel;
    if (rm.kind === 'iau') return this.spinAngle0 + this.spinRate * t;
    if (rm.kind === 'tidal' && this.orbit) {
      const o = this.orbit;
      // Mean anomaly → rotate so body-fixed +X faces the parent on average
      const M = o.meanMotion * (t - o.tPeriapsis);
      return M + Math.PI;
    }
    return 0;
  }

  /** Body-fixed → inertial rotation at time t. */
  getRotationAt(t: number, out: Quaternion): Quaternion {
    const rm = this.rotationModel;
    if (rm.kind === 'none') return out.identity();
    if (rm.kind === 'tidal' && this.orbit) {
      // Pole = orbit normal; X = periapsis direction; spin by mean anomaly + π.
      const o = this.orbit;
      _v.crossVectors(o.P, o.W).normalize();
      _m.makeBasis(o.P, o.W, _v);
      _qAxis.setFromRotationMatrix(_m);
      _q.setFromAxisAngle(Y_AXIS, this.spinAngle(t));
      return out.copy(_qAxis).multiply(_q);
    }
    _q.setFromAxisAngle(Y_AXIS, this.spinAngle(t));
    return out.copy(this.poleFrame).multiply(_q);
  }

  /** Angular velocity magnitude (rad/s). */
  get rotationRate(): number {
    const rm = this.rotationModel;
    if (rm.kind === 'iau') return rm.wRate;
    if (rm.kind === 'tidal' && this.orbit) return this.orbit.meanMotion;
    return 0;
  }

  /** Rotation period in seconds (Infinity if not rotating). */
  get rotationPeriod(): number {
    const r = this.rotationRate;
    return r > 0 ? (2 * Math.PI) / r : Infinity;
  }

  /** Update cached absolute state; parents must be updated first. */
  update(t: number): void {
    if (this.parent && this.orbit) {
      this.orbit.getStateAt(t, this.position, this.velocity);
      this.position.add(this.parent.position);
      this.velocity.add(this.parent.velocity);
    } else {
      this.position.set(0, 0, 0);
      this.velocity.set(0, 0, 0);
    }
    this.getRotationAt(t, this.rotation);
    this.rotationInverse.copy(this.rotation).invert();
    this.angularVelocity.set(0, this.rotationRate, 0).applyQuaternion(this.rotation);
    this.cachedTime = t;
  }

  /** Absolute position at arbitrary time (no caching; walks parents). */
  absolutePositionAt(t: number, out: Vector3, outVel?: Vector3): Vector3 {
    if (!this.parent || !this.orbit) {
      out.set(0, 0, 0);
      if (outVel) outVel.set(0, 0, 0);
      return out;
    }
    const pr = new Vector3();
    const pv = new Vector3();
    this.parent.absolutePositionAt(t, pr, outVel ? pv : undefined);
    this.orbit.getStateAt(t, out, outVel);
    out.add(pr);
    if (outVel) outVel.add(pv);
    return out;
  }

  /** Position relative to parent at time t. */
  relativeStateAt(t: number, outR: Vector3, outV?: Vector3): void {
    if (!this.orbit) {
      outR.set(0, 0, 0);
      if (outV) outV.set(0, 0, 0);
      return;
    }
    this.orbit.getStateAt(t, outR, outV);
  }

  /** Velocity of the rotating surface/atmosphere at inertial offset r (relative to centre). */
  surfaceVelocity(r: Vector3, out: Vector3): Vector3 {
    return out.crossVectors(this.angularVelocity, r);
  }

  /** Latitude/longitude (radians) of a body-fixed direction. */
  static latLon(dir: Vector3): { lat: number; lon: number } {
    const len = dir.length();
    return { lat: Math.asin(Math.max(-1, Math.min(1, dir.y / len))), lon: Math.atan2(-dir.z, dir.x) };
  }

  static dirFromLatLon(lat: number, lon: number, out: Vector3): Vector3 {
    const cl = Math.cos(lat);
    return out.set(cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon));
  }

  /** Terrain height (above radius) at inertial offset r from the centre at the cached time. */
  terrainHeightAtInertial(r: Vector3): number {
    if (!this.terrain) return 0;
    _v.copy(r).applyQuaternion(this.rotationInverse).normalize();
    return this.terrain.heightAt(_v);
  }

  isWaterAtInertial(r: Vector3): boolean {
    if (!this.terrain) return false;
    _v.copy(r).applyQuaternion(this.rotationInverse).normalize();
    return this.terrain.isWater(_v);
  }

  /** Is `other` a descendant (child, grandchild…) of this body? */
  isAncestorOf(other: CelestialBody): boolean {
    let p = other.parent;
    while (p) {
      if (p === this) return true;
      p = p.parent;
    }
    return false;
  }
}

export const BODY_CONSTANTS = {
  sun: { mu: 1.32712440018e20, radius: 6.957e8 },
  earth: { mu: 3.986004418e14, radius: 6.371e6 },
  moon: { mu: 4.9028e12, radius: 1.7374e6 },
  // MOLA elevations are relative to the 3396 km areoid, so we use it as the reference radius
  mars: { mu: 4.282837e13, radius: 3.396e6 },
} as const;

export const MARS_ROTATION: RotationModel = {
  kind: 'iau',
  poleRa: 317.68143 * DEG,
  poleDec: 52.8865 * DEG,
  w0: 176.63 * DEG,
  wRate: (350.89198226 * DEG) / 86400,
};

export const EARTH_ROTATION: RotationModel = {
  kind: 'iau',
  poleRa: 0,
  poleDec: 90 * DEG,
  w0: 190.147 * DEG,
  wRate: (360.9856235 * DEG) / 86400,
};
