/**
 * LEARNING NOTE: The flight simulation loop
 *
 * GAME LOOP: rendering happens as fast as the display allows (60–120 Hz) but
 * physics MUST advance in fixed steps (1/60 s) so results don't depend on frame
 * rate. We keep an accumulator of real time × warp and consume it in fixed slices;
 * the renderer interpolates between the last two physics states for smooth motion.
 *
 * TWO KINDS OF TIME WARP:
 *   • Physics warp (2–4×): more fixed steps per frame. Needed in the atmosphere
 *     or under thrust, where forces must be integrated.
 *   • On-rails warp (5× … 1,000,000×): when coasting in vacuum the trajectory is an
 *     exact Kepler conic, so we jump analytically to any future time. We stop just
 *     before events the predictor knows about (SOI changes, atmosphere entry,
 *     impact, maneuver nodes) so nothing is skipped.
 *
 * Also handled here: staging (decoupling splits vessels), clamps release,
 * landing detection (settled vessels get "pinned" to the rotating surface),
 * destruction, sphere-of-influence hand-offs, and debris cleanup.
 *
 * Key concepts: fixed timestep + accumulator, render interpolation, analytic vs.
 * numerical propagation, event-limited time warp, entity lifecycle
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  DOCK_CAPTURE_DISTANCE,
  DOCK_MAX_ANGLE,
  DOCK_MAX_SPEED,
  DOCK_SEPARATION_DV,
  LANDED_SETTLE_TIME,
  LANDED_SPEED_THRESHOLD,
  MAX_PHYSICS_STEPS_PER_FRAME,
  PHYSICS_BUBBLE_RADIUS,
  PHYSICS_DT,
} from '../core/constants';
import type { CelestialBody } from '../physics/CelestialBody';
import { CelestialBody as CB } from '../physics/CelestialBody';
import type { SolarSystem } from '../physics/SolarSystem';
import { TrajectoryPredictor } from '../physics/Trajectory';
import { Orbit, orbitalFrame } from '../physics/Orbit';
import type { CraftData } from '../parts/Craft';
import { actionKind } from '../parts/PartCatalog';
import type { LaunchSite } from '../world/LaunchSites';
import { AttitudeController } from './Attitude';
import { Autopilot } from './Autopilot';
import type { FlightPart } from './FlightPart';
import {
  createNode,
  nodeStateAfter,
  refreshNodeTarget,
  updateNodeRemaining,
  type ManeuverNode,
  burnLeadTime,
} from './Maneuver';
import { Vessel } from './Vessel';
import { WindField } from '../physics/Wind';
import { VesselPhysics, type ControlCommand, type FlightEvent } from './VesselPhysics';

export interface WarpLevel {
  rate: number;
  rails: boolean;
}

export const WARP_LEVELS: WarpLevel[] = [
  { rate: 1, rails: false },
  { rate: 2, rails: false },
  { rate: 3, rails: false },
  { rate: 4, rails: false },
  { rate: 5, rails: true },
  { rate: 10, rails: true },
  { rate: 50, rails: true },
  { rate: 100, rails: true },
  { rate: 1_000, rails: true },
  { rate: 10_000, rails: true },
  { rate: 100_000, rails: true },
  { rate: 1_000_000, rails: true },
];

export interface FairingPiece {
  /** Absolute position (heliocentric) & velocity. */
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly q: Quaternion;
  readonly w: Vector3;
  body: CelestialBody;
  diameter: number;
  length: number;
  side: 1 | -1;
  age: number;
}

const _r = new Vector3();
const _v = new Vector3();
const _t = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _q = new Quaternion();
const _cmd: ControlCommand = { x: 0, y: 0, z: 0 };
const _zero: ControlCommand = { x: 0, y: 0, z: 0 };
const _dockPosA = new Vector3();
const _dockDirA = new Vector3();
const _dockPosB = new Vector3();
const _dockDirB = new Vector3();
const _orbitA = new Orbit();
const _orbitB = new Orbit();

export interface TargetInfo {
  /** Range to the target (m) and relative speed (m/s), updated every frame. */
  distance: number;
  relSpeed: number;
  /** Predicted closest approach (m) and its universal time (NaN if unknown). */
  caDistance: number;
  caTime: number;
}

/**
 * Final-approach geometry between our nearest free docking port and the target
 * vessel's, in the PILOT FRAME of our port: forward along the port's axis, up
 * roughly along the vessel's dorsal side, right = forward × up. That is the view
 * out of the docking window, so "target is up and to the right" reads directly
 * as "translate up and right".
 */
export interface DockingState {
  valid: boolean;
  own: FlightPart | null;
  ownFace: 1 | -1;
  target: FlightPart | null;
  targetFace: 1 | -1;
  /** Pilot-frame unit vectors (inertial). */
  readonly fwd: Vector3;
  readonly up: Vector3;
  readonly right: Vector3;
  /** Target port face relative to our port face: x right, y up, z forward (m). */
  readonly offset: Vector3;
  /** Target velocity relative to us in the same frame (m/s). */
  readonly relVel: Vector3;
  distance: number;
  /** Rate the gap closes (m/s, negative when drifting apart). */
  closing: number;
  /** Offset across the approach axis (m). */
  lateral: number;
  /** Angle between our port axis and the reversed target port axis (rad). */
  angle: number;
  /** Nose direction (inertial) that turns our port to face the target port. */
  readonly alignDir: Vector3;
}

/** Docking geometry is tracked inside this range (m). */
const DOCKING_RANGE = 2_500;

function isVesselTarget(t: CelestialBody | Vessel): t is Vessel {
  return 'parts' in t;
}
const _qd = new Quaternion();
const _nose = new Vector3();
const _vrel = new Vector3();

/**
 * Where a decoupler splits the part tree. A stack separator stays with the stage
 * BELOW it (like an interstage): built top-down it hangs below its parent and
 * leaves with its own subtree; in an inverted tree (root at the bottom, the
 * separator attached above its parent) the split happens at the part above it.
 * Radial separators leave with their booster.
 */
export function separationPoint(p: FlightPart): FlightPart {
  if (p.def.decoupler && !p.def.decoupler.radial && p.attach === 'above') {
    const up = p.children.find((c) => c.attach === 'above');
    if (up) return up;
  }
  return p;
}

export class FlightSim {
  readonly system: SolarSystem;
  time: number;
  readonly vessels: Vessel[] = [];
  active: Vessel;
  readonly physics = new VesselPhysics();
  readonly attitude = new AttitudeController();
  readonly autopilot = new Autopilot();
  readonly predictor = new TrajectoryPredictor(5);
  readonly nodePredictor = new TrajectoryPredictor(5);
  readonly nodes: ManeuverNode[] = [];
  readonly fairings: FairingPiece[] = [];
  /** Navigation target: a body (encounters) or another vessel (rendezvous). */
  target: CelestialBody | Vessel | null = null;
  /** Range, closing speed and predicted closest approach to a target vessel. */
  targetInfo: TargetInfo | null = null;
  /** Port-to-port approach geometry when a target vessel is near. */
  readonly dock: DockingState = {
    valid: false,
    own: null,
    ownFace: 1,
    target: null,
    targetFace: 1,
    fwd: new Vector3(),
    up: new Vector3(),
    right: new Vector3(),
    offset: new Vector3(),
    relVel: new Vector3(),
    distance: 0,
    closing: 0,
    lateral: 0,
    angle: 0,
    alignDir: new Vector3(),
  };
  warpIndex = 0;
  paused = false;
  /** Universal time of liftoff (NaN until launched). */
  launchTime = NaN;
  readonly launchSite: LaunchSite;
  /** Fired events drained by the UI each frame. */
  readonly events: FlightEvent[] = [];
  /** Message for UI when warp is refused/limited. */
  warpMessage = '';
  accumulator = 0;
  /** Render interpolation factor in [0,1). */
  alpha = 0;
  /** Absolute positions of vessels at the previous physics step (for interpolation). */
  /** Body-relative positions at the previous physics tick (for render interpolation). */
  private readonly prevRel = new Map<number, Vector3>();
  private readonly prevBody = new Map<number, string>();
  /** Simulation time the renderer shows (between the last two physics ticks). */
  renderTime = 0;
  private readonly prevQ = new Map<number, Quaternion>();
  private predictionDirty = true;
  private predictTimer = 0;
  /** Counter for naming controllable sections released by decouplers. */
  private releasedUnits = 0;
  /** Seconds the active vessel has been coasting in vacuum with no forces. */
  private stageCooldown = 0;

  constructor(system: SolarSystem, craft: CraftData, site: LaunchSite, startTime: number) {
    // Each launch day and site has its own (reproducible) weather
    let seed = Math.floor(startTime / 3600) * 2654435761;
    for (let i = 0; i < site.id.length; i++) seed = (seed ^ site.id.charCodeAt(i)) * 16777619;
    this.physics.wind = new WindField(seed >>> 0);
    this.system = system;
    this.time = startTime;
    this.renderTime = startTime;
    this.launchSite = site;
    system.update(startTime);
    const body = system.get(site.body);
    const v = Vessel.fromCraft(craft, body);
    this.vessels.push(v);
    this.active = v;
    this.placeOnPad(v, site);
    this.target = system.moon;
    this.physics.time = startTime;
    this.storePrev();
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /** Stand the vessel upright on the pad, dorsal side west so "pitch down" tilts east. */
  placeOnPad(v: Vessel, site: LaunchSite): void {
    const body = v.body;
    const lat = (site.lat * Math.PI) / 180;
    const lon = (site.lon * Math.PI) / 180;
    const up = CB.dirFromLatLon(lat, lon, new Vector3());
    const east = new Vector3(-Math.sin(lon), 0, -Math.cos(lon));
    const north = new Vector3().crossVectors(up, east).normalize();
    const south = north.clone().negate();
    const west = east.clone().negate();
    const basis = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(south, up, west));
    const h = body.terrain ? body.terrain.heightAt(up) : 0;
    let minY = Infinity;
    for (const c of v.contactPoints) minY = Math.min(minY, c.pos.y);
    if (!isFinite(minY)) minY = v.boundsMin.y;
    // Vessel origin sits so that the lowest point touches the pad
    const originHeight = body.radius + h - minY + 0.02;
    const originBF = up.clone().multiplyScalar(originHeight);
    const comBF = v.com.clone().applyQuaternion(basis).add(originBF);
    v.pinnedPos.copy(comBF);
    v.pinnedRot.copy(basis);
    v.pinned = true;
    v.clamped = true;
    v.situation = 'prelaunch';
    this.updatePinned(v);
    this.attitude.resetHold(v);
  }

  private updatePinned(v: Vessel): void {
    const body = v.body;
    v.r.copy(v.pinnedPos).applyQuaternion(body.rotation);
    body.surfaceVelocity(v.r, v.v);
    v.q.copy(body.rotation).multiply(v.pinnedRot);
    v.w.copy(body.angularVelocity).applyQuaternion(_q.copy(v.q).invert());
  }

  /**
   * Put a vessel straight into a circular orbit (sandbox "start in orbit" and
   * pre-positioned targets). Frame: +Y is the pole; the ascending node sits at
   * longitude `lanDeg` in the equatorial plane; `nuDeg` is the angle along the
   * orbit from that node. The nose points prograde, the dorsal side away from
   * the planet.
   */
  placeInOrbit(v: Vessel, body: CelestialBody, altitude: number, incDeg = 0, lanDeg = 0, nuDeg = 0): void {
    v.body = body;
    const R = body.radius + altitude;
    const speed = Math.sqrt(body.mu / R);
    const inc = (incDeg * Math.PI) / 180;
    const lan = (lanDeg * Math.PI) / 180;
    const nu = (nuDeg * Math.PI) / 180;
    const node = new Vector3(Math.cos(lan), 0, -Math.sin(lan));
    const pole = new Vector3(0, 1, 0);
    const eastAtNode = new Vector3().crossVectors(pole, node).normalize();
    const inPlane = eastAtNode.clone().multiplyScalar(Math.cos(inc)).addScaledVector(pole, Math.sin(inc));
    v.r.copy(node).multiplyScalar(Math.cos(nu)).addScaledVector(inPlane, Math.sin(nu)).multiplyScalar(R);
    v.v.copy(node).multiplyScalar(-Math.sin(nu)).addScaledVector(inPlane, Math.cos(nu)).multiplyScalar(speed);
    const fwd = v.v.clone().normalize();
    const up = v.r.clone().normalize();
    v.q.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3().crossVectors(fwd, up).normalize(), fwd, up));
    v.w.set(0, 0, 0);
    v.pinned = false;
    v.clamped = false;
    v.onRails = false;
    v.situation = 'orbiting';
    v.airborneTime = 1e6;
    this.physics.updateEnvironment(v);
    v.maxAltitude = v.altitude;
    this.attitude.resetHold(v);
    this.predictionDirty = true;
  }

  /** Add another vessel to the flight (a persisted satellite, a target station). */
  addVessel(v: Vessel): void {
    if (!this.vessels.includes(v)) this.vessels.push(v);
    this.physics.updateEnvironment(v);
  }

  /** Swap the pad vessel for one restored from the tracking station (resuming a flight). */
  replaceActive(v: Vessel): void {
    const old = this.active;
    const i = this.vessels.indexOf(old);
    if (i >= 0) this.vessels.splice(i, 1);
    this.prevRel.delete(old.id);
    this.prevQ.delete(old.id);
    this.prevBody.delete(old.id);
    this.vessels.push(v);
    this.active = v;
    this.physics.updateEnvironment(v);
    v.maxAltitude = v.altitude;
    this.attitude.resetHold(v);
    this.predictionDirty = true;
    this.storePrev();
  }

  /** Hand control to another vessel of this flight (the KSP "[ ]" switch). */
  setActive(v: Vessel): void {
    if (v === this.active || v.destroyed || !this.vessels.includes(v)) return;
    this.active = v;
    this.autopilot.disengage();
    for (const n of [...this.nodes]) this.removeNode(n);
    if (this.target === v) this.target = null;
    if (v.onRails && !this.warp.rails) {
      v.railsOrbit.getStateAt(this.time, v.r, v.v);
      v.onRails = false;
    }
    this.attitude.resetHold(v);
    this.predictionDirty = true;
    this.physics.emit('switch', v, `Controlling ${v.name}`);
  }

  /** Switch to the next / previous controllable vessel. */
  cycleActive(dir: 1 | -1): Vessel | null {
    const list = this.vessels.filter((x) => !x.destroyed && x.isControllable && !x.debris);
    if (list.length < 2) return null;
    const i = list.indexOf(this.active);
    const next = list[(i + dir + list.length) % list.length]!;
    this.setActive(next);
    return next;
  }

  // The target union is told apart structurally (a vessel has parts): robust even
  // if a class is loaded twice (hot module reload, tests importing by another path)
  get targetBody(): CelestialBody | null {
    const t = this.target;
    return t && !isVesselTarget(t) ? t : null;
  }

  get targetVessel(): Vessel | null {
    const t = this.target;
    return t && isVesselTarget(t) ? t : null;
  }

  /** Absolute position of the current target; false when there is none. */
  targetPosition(out: Vector3): boolean {
    const t = this.target;
    if (!t) return false;
    if (isVesselTarget(t)) t.absolutePosition(out);
    else out.copy(t.position);
    return true;
  }

  targetVelocity(out: Vector3): boolean {
    const t = this.target;
    if (!t) return false;
    if (isVesselTarget(t)) t.absoluteVelocity(out);
    else out.copy(t.velocity);
    return true;
  }

  /**
   * Body-relative state of the target vessel at time t (two-body propagation of
   * its current orbit). False if there is no target vessel in the active
   * vessel's sphere of influence.
   */
  targetStateAt(t: number, outR: Vector3, outV: Vector3): boolean {
    const tv = this.targetVessel;
    if (!tv || tv.destroyed || tv.body !== this.active.body || tv.pinned) return false;
    const o = tv.onRails ? tv.railsOrbit : _orbitB.setFromState(tv.r, tv.v, tv.body.mu, this.time);
    o.getStateAt(t, outR, outV);
    return true;
  }

  private updateTargetInfo(recomputeCA: boolean): void {
    const tv = this.targetVessel;
    if (tv && tv.destroyed) this.target = null;
    if (!tv || tv.destroyed || this.active.destroyed) {
      this.targetInfo = null;
      return;
    }
    const a = this.active;
    tv.absolutePosition(_a);
    a.absolutePosition(_b);
    const info = this.targetInfo ?? { distance: 0, relSpeed: 0, caDistance: NaN, caTime: NaN };
    info.distance = _a.distanceTo(_b);
    tv.absoluteVelocity(_a);
    a.absoluteVelocity(_b);
    info.relSpeed = _a.distanceTo(_b);
    if (recomputeCA || isNaN(info.caTime)) this.closestApproach(a, tv, info);
    this.targetInfo = info;
  }

  /**
   * Pick the closest pair of compatible free ports (ours × the target's) and
   * express their relative position, velocity and alignment in our port's
   * pilot frame. Runs once per frame; allocation-free.
   */
  private updateDocking(): void {
    const d = this.dock;
    d.valid = false;
    const a = this.active;
    const tv = this.targetVessel;
    if (!tv || tv.destroyed || a.destroyed || a.pinned || tv.body !== a.body) return;
    if (this.targetInfo && this.targetInfo.distance > DOCKING_RANGE) return;
    let best = Infinity;
    for (const p of a.parts) {
      const fa = a.freePortFace(p);
      if (!fa) continue;
      a.dockFacePose(p, fa, _dockPosA, _dockDirA);
      for (const q of tv.parts) {
        const fb = tv.freePortFace(q);
        if (!fb || Math.abs(p.stats.diameterTop - q.stats.diameterTop) > 0.01) continue;
        tv.dockFacePose(q, fb, _dockPosB, _dockDirB);
        const dist = _dockPosA.distanceTo(_dockPosB);
        if (dist < best) {
          best = dist;
          d.own = p;
          d.ownFace = fa;
          d.target = q;
          d.targetFace = fb;
        }
      }
    }
    if (!isFinite(best) || !d.own || !d.target) return;
    a.dockFacePose(d.own, d.ownFace, _dockPosA, _dockDirA);
    tv.dockFacePose(d.target, d.targetFace, _dockPosB, _dockDirB);
    // Pilot frame: forward = our port axis, up = the vessel's dorsal side made
    // perpendicular to it (its right side for a port pointing along dorsal)
    d.fwd.copy(_dockDirA);
    d.up.set(0, 0, 1).applyQuaternion(a.q);
    d.up.addScaledVector(d.fwd, -d.up.dot(d.fwd));
    if (d.up.lengthSq() < 1e-6) {
      d.up.set(1, 0, 0).applyQuaternion(a.q);
      d.up.addScaledVector(d.fwd, -d.up.dot(d.fwd));
    }
    d.up.normalize();
    d.right.crossVectors(d.fwd, d.up);
    _t.copy(_dockPosB).sub(_dockPosA);
    d.offset.set(_t.dot(d.right), _t.dot(d.up), _t.dot(d.fwd));
    _vrel.copy(tv.v).sub(a.v);
    d.relVel.set(_vrel.dot(d.right), _vrel.dot(d.up), _vrel.dot(d.fwd));
    d.distance = _t.length();
    d.closing = d.distance > 1e-6 ? -_vrel.dot(_t) / d.distance : 0;
    d.lateral = Math.hypot(d.offset.x, d.offset.y);
    d.angle = Math.acos(Math.max(-1, Math.min(1, -d.fwd.dot(_dockDirB))));
    // The rotation that would turn our port axis onto the reversed target axis,
    // applied to the nose: for ports on the vessel's axis this is exactly ±that axis
    _qd.setFromUnitVectors(d.fwd, _t.copy(_dockDirB).negate());
    d.alignDir.copy(a.forward(_nose)).applyQuaternion(_qd).normalize();
    d.valid = true;
  }

  /**
   * Closest approach between the active vessel and a target vessel: both orbits
   * are sampled over the next two revolutions (coarse scan, then a golden-section
   * refinement around the minimum).
   */
  private closestApproach(a: Vessel, tv: Vessel, info: TargetInfo): void {
    if (a.body !== tv.body || a.pinned || tv.pinned) {
      info.caDistance = NaN;
      info.caTime = NaN;
      return;
    }
    const mu = a.body.mu;
    const oa = this.predictor.count > 0 && this.predictor.patches[0]!.body === a.body ? this.predictor.patches[0]!.orbit : _orbitA.setFromState(a.r, a.v, mu, this.time);
    const ob = tv.onRails ? tv.railsOrbit : _orbitB.setFromState(tv.r, tv.v, mu, this.time);
    const pa = oa.isElliptic ? oa.period : 3 * 3600;
    const pb = ob.isElliptic ? ob.period : 3 * 3600;
    const horizon = Math.min(2 * 86400, 2 * Math.max(pa, pb));
    const dist = (t: number): number => {
      oa.getStateAt(t, _r);
      ob.getStateAt(t, _v);
      return _r.distanceTo(_v);
    };
    const N = 600;
    let best = Infinity;
    let bestT = this.time;
    for (let i = 0; i <= N; i++) {
      const t = this.time + (horizon * i) / N;
      const d = dist(t);
      if (d < best) {
        best = d;
        bestT = t;
      }
    }
    let lo = Math.max(this.time, bestT - horizon / N);
    let hi = bestT + horizon / N;
    for (let k = 0; k < 28; k++) {
      const m1 = lo + (hi - lo) * 0.382;
      const m2 = lo + (hi - lo) * 0.618;
      if (dist(m1) < dist(m2)) hi = m2;
      else lo = m1;
    }
    const t = (lo + hi) / 2;
    info.caTime = t;
    info.caDistance = dist(t);
  }

  // ---------------------------------------------------------------------------
  // Warp
  // ---------------------------------------------------------------------------

  get warp(): WarpLevel {
    return WARP_LEVELS[this.warpIndex]!;
  }

  /** Highest rails warp index allowed for the active vessel right now (0 = none). */
  maxRailsIndex(): number {
    const v = this.active;
    if (v.destroyed) return WARP_LEVELS.length - 1;
    if (v.pinned) return v.situation === 'prelaunch' ? 10 : WARP_LEVELS.length - 1;
    if (v.totalThrust > 0) return 0;
    if (v.inAtmosphere || v.touchingGround || v.inWater) return 0;
    const alt = v.altitude;
    if (alt < 1_000_000) return 8;
    if (alt < 5_000_000) return 9;
    if (alt < 20_000_000) return 10;
    return 11;
  }

  canRailsWarp(): boolean {
    return this.maxRailsIndex() >= 4;
  }

  setWarpIndex(i: number): void {
    i = Math.max(0, Math.min(WARP_LEVELS.length - 1, i));
    const target = WARP_LEVELS[i]!;
    if (target.rails) {
      const max = this.maxRailsIndex();
      if (max < 4) {
        this.warpMessage = this.active.totalThrust > 0 ? 'Cannot warp while engines are firing' : 'Cannot use on-rails warp in atmosphere — using physics warp';
        i = Math.min(3, i);
      } else if (i > max) {
        i = max;
        this.warpMessage = 'Warp limited at this altitude';
      }
    }
    const wasRails = this.warp.rails;
    this.warpIndex = i;
    const nowRails = this.warp.rails;
    if (nowRails && !wasRails) this.enterRails();
    else if (!nowRails && wasRails) this.exitRails();
  }

  warpUp(): void {
    const i = this.warpIndex;
    if (i === 0 && this.canRailsWarp()) this.setWarpIndex(4);
    else if (i < 3 && !this.canRailsWarp()) this.setWarpIndex(i + 1);
    else if (i >= 3 && i < 4 && this.canRailsWarp()) this.setWarpIndex(4);
    else if (i >= 4) this.setWarpIndex(i + 1);
    else this.setWarpIndex(i + 1);
  }

  warpDown(): void {
    const i = this.warpIndex;
    if (i === 4) this.setWarpIndex(0);
    else this.setWarpIndex(i - 1);
  }

  stopWarp(): void {
    this.setWarpIndex(0);
  }

  private enterRails(): void {
    for (const v of this.vessels) {
      if (v.destroyed || v.pinned || v.onRails) continue;
      v.railsOrbit.setFromState(v.r, v.v, v.body.mu, this.time);
      v.onRails = true;
      v.w.set(0, 0, 0);
    }
    this.accumulator = 0;
  }

  private exitRails(): void {
    for (const v of this.vessels) {
      if (!v.onRails || v.pinned) continue;
      if (this.isFarAway(v)) continue;
      v.railsOrbit.getStateAt(this.time, v.r, v.v);
      v.onRails = false;
    }
    this.attitude.resetHold(this.active);
    this.accumulator = 0;
  }

  private isFarAway(v: Vessel): boolean {
    if (v === this.active) return false;
    v.absolutePosition(_a);
    this.active.absolutePosition(_b);
    return _a.distanceTo(_b) > PHYSICS_BUBBLE_RADIUS;
  }

  // ---------------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------------

  update(realDt: number): void {
    if (this.paused) return;
    realDt = Math.min(realDt, 0.1);
    const w = this.warp;
    if (w.rails) {
      this.railsAdvance(realDt * w.rate);
      this.alpha = 1;
      this.storePrev();
    } else {
      this.accumulator += realDt * w.rate;
      let steps = 0;
      while (this.accumulator >= PHYSICS_DT && steps < MAX_PHYSICS_STEPS_PER_FRAME) {
        this.storePrev();
        this.fixedStep(PHYSICS_DT);
        this.accumulator -= PHYSICS_DT;
        steps++;
      }
      if (steps >= MAX_PHYSICS_STEPS_PER_FRAME) this.accumulator = Math.min(this.accumulator, PHYSICS_DT);
      this.alpha = this.accumulator / PHYSICS_DT;
    }
    // Planets are shown at the same in-between time as the interpolated vessels.
    // (Earth moves 30 km/s around the Sun: mixing times by one 16 ms tick would
    // misplace a rocket by ~500 m relative to the ground.) The next physics step
    // re-evaluates the bodies at simulation time.
    this.renderTime = this.time - (1 - this.alpha) * PHYSICS_DT;
    this.system.update(this.renderTime);
    const predicted = this.updatePrediction(realDt);
    this.updateNodes();
    this.updateTargetInfo(predicted);
    this.updateDocking();
    // Drain physics events
    if (this.physics.events.length) {
      this.events.push(...this.physics.events);
      this.physics.events.length = 0;
    }
  }

  private storePrev(): void {
    for (const v of this.vessels) {
      let p = this.prevRel.get(v.id);
      if (!p) {
        p = new Vector3();
        this.prevRel.set(v.id, p);
      }
      // Body-relative, so interpolation is independent of the planet's own motion
      p.copy(v.r);
      this.prevBody.set(v.id, v.body.id);
      let q = this.prevQ.get(v.id);
      if (!q) {
        q = new Quaternion();
        this.prevQ.set(v.id, q);
      }
      q.copy(v.q);
    }
  }

  /** Interpolated absolute COM position & orientation for rendering. */
  renderState(v: Vessel, outPos: Vector3, outQ: Quaternion): void {
    const body = v.body;
    if (v.pinned) {
      // Clamped/landed: rigidly attached to the rotating planet at render time
      outPos.copy(v.pinnedPos).applyQuaternion(body.rotation).add(body.position);
      outQ.copy(body.rotation).multiply(v.pinnedRot);
      return;
    }
    const prev = this.prevRel.get(v.id);
    const prevQ = this.prevQ.get(v.id);
    outQ.copy(v.q);
    if (prev && prevQ && this.alpha < 1 && this.prevBody.get(v.id) === body.id) {
      outPos.lerpVectors(prev, v.r, this.alpha).add(body.position);
      outQ.slerpQuaternions(prevQ, v.q, this.alpha);
    } else {
      outPos.copy(v.r).add(body.position);
    }
  }

  private fixedStep(dt: number): void {
    const sys = this.system;
    sys.update(this.time);
    this.physics.time = this.time;
    const active = this.active;
    this.autopilot.update(this, dt);
    for (const v of this.vessels) {
      if (v.destroyed) continue;
      if (v.pinned) {
        this.updatePinned(v);
        this.physics.updateEnvironment(v);
        // Engines on a pinned vessel (clamped prelaunch or landed): release when an
        // engine can actually run — ignited, with propellant to burn (a dry stage
        // pressing the throttle must not unpin, or it would flap landed/flying)
        if (v.situation !== 'prelaunch' && v.controls.throttle > 0 && this.canThrust(v)) {
          v.pinned = false;
          v.situation = 'flying';
          v.settledTime = 0;
        } else {
          v.totalThrust = 0;
          continue;
        }
      }
      if (v.onRails) {
        v.railsOrbit.getStateAt(this.time + dt, v.r, v.v);
        continue;
      }
      const cmd = v === active && !v.destroyed ? this.computeCommand(v) : _zero;
      this.physics.step(v, dt, cmd);
      v.onRails = false;
    }
    this.time += dt;
    sys.update(this.time);
    this.processDestruction();
    for (const v of this.vessels) {
      if (v.destroyed || v.pinned || v.onRails) continue;
      this.checkSOI(v);
      this.updateSituation(v, dt);
    }
    this.updateFairings(dt);
    this.checkDocking();
    this.cullVessels();
    if (this.stageCooldown > 0) this.stageCooldown -= dt;
    // Liftoff detection: the lowest point of the vehicle has left the ground (the
    // centre of mass is always metres above it, even sitting on the pad)
    if (isNaN(this.launchTime) && active.situation === 'flying' && active.radarAltitude > 1 && !active.pinned) {
      this.launchTime = this.time;
      this.physics.emit('liftoff', active, 'Liftoff!');
    }
  }

  /** True if some ignited engine of v can run right now (or a solid still has grain). */
  private canThrust(v: Vessel): boolean {
    for (const p of v.parts) {
      if (!p.isEngine || !p.engineIgnited) continue;
      if (p.isSolid) {
        if (p.fuel > 0) return true;
        continue;
      }
      if (p.engineRunning) return true;
      if (p.ignitionsLeft > 0 && v.engineFuel(p) > 0) return true;
    }
    return false;
  }

  private railsAdvance(dtSim: number): void {
    const tStart = this.time;
    let tEnd = this.time + dtSim;
    let hitEvent = false;
    const v = this.active;
    if (!v.pinned && !v.destroyed) {
      // Event times come from the trajectory prediction. On rails the conic does
      // not change between frames, so the cached prediction stays valid until a
      // discrete event (SOI change, staging, node edit) marks it dirty or the
      // vessel runs past its first patch — re-predicting every frame cost ~4 ms
      // per frame on an interplanetary cruise (encounter scans of every planet).
      const cached = this.predictor.count > 0 ? this.predictor.patches[0]! : null;
      const valid = cached && !this.predictionDirty && cached.body === v.body && this.time >= cached.startTime - 1e-6 && this.time <= cached.endTime + 1e-6;
      if (!valid) this.predictor.predict(v.body, v.r, v.v, this.time, { maxPatches: 2, target: this.targetBody });
      const p0 = this.predictor.patches[0]!;
      if (p0.endReason !== 'none' && p0.endTime < tEnd) {
        tEnd = p0.endReason === 'impact' ? Math.max(this.time, p0.endTime - 30) : p0.endTime + 1e-3;
        hitEvent = true;
      }
      if (isFinite(p0.atmosphereEntry) && p0.atmosphereEntry < tEnd) {
        tEnd = Math.max(this.time, p0.atmosphereEntry - 2);
        hitEvent = true;
      }
    }
    for (const n of this.nodes) {
      // Drop out of warp early enough to start a long burn on time
      const lead = Math.max(60, burnLeadTime(this.active, n.remaining.length(), 30));
      if (n.time - lead > this.time && n.time - lead < tEnd) {
        tEnd = n.time - lead;
        hitEvent = true;
      }
    }
    this.time = tEnd;
    this.system.update(this.time);
    for (const ves of this.vessels) {
      if (ves.destroyed) continue;
      if (ves.pinned) {
        this.updatePinned(ves);
        continue;
      }
      if (!ves.onRails) {
        ves.railsOrbit.setFromState(ves.r, ves.v, ves.body.mu, tStart);
        ves.onRails = true;
      }
      ves.railsOrbit.getStateAt(this.time, ves.r, ves.v);
      // SOI transitions on rails: re-base the conic
      if (this.checkSOI(ves)) ves.railsOrbit.setFromState(ves.r, ves.v, ves.body.mu, this.time);
      this.physics.updateEnvironment(ves);
      if (ves !== this.active && ves.inAtmosphere && !ves.pinned) {
        ves.destroyed = true;
      }
      this.updateSituationRails(ves);
    }
    this.holdAttitudeOnRails();
    this.cullVessels();
    if (hitEvent) this.setWarpIndex(0);
  }

  /**
   * On rails there is no rotational physics, so a vessel holding a direction
   * (autopilot burn, SAS prograde…) simply keeps pointing there — otherwise a
   * heavy stack would have to spend minutes turning when warp ends, and a long
   * burn would start late.
   */
  private holdAttitudeOnRails(): void {
    const v = this.active;
    if (v.pinned || v.destroyed) return;
    let dir: Vector3 | null = null;
    const ap = this.autopilot;
    if (ap.mode === 'node' && this.nodes[0] && this.nodes[0].remaining.lengthSq() > 1e-6) dir = _t.copy(this.nodes[0].remaining).normalize();
    else if (ap.mode === 'off') dir = this.sasTargetDirection(v, _t);
    if (!dir) return;
    v.forward(_a);
    _q.setFromUnitVectors(_a, dir);
    v.q.premultiply(_q).normalize();
    v.w.set(0, 0, 0);
  }

  private computeCommand(v: Vessel): ControlCommand {
    const ap = this.autopilot;
    const target = ap.mode !== 'off' && ap.hasTarget ? ap.target : this.sasTargetDirection(v, _t);
    return this.attitude.compute(v, this.physics, target, _cmd);
  }

  /** Current SAS target direction (inertial) or null for attitude hold. */
  sasTargetDirection(v: Vessel, out: Vector3): Vector3 | null {
    const c = v.controls;
    if (!c.sas) return null;
    let vel: Vector3 = c.speedMode === 'surface' ? v.surfaceVelocity : v.v;
    // Target mode: prograde/retrograde are relative to the target, as the navball shows
    // them — pointing target-retrograde and burning kills the relative velocity
    if (c.speedMode === 'target' && v === this.active && this.targetVelocity(_b)) vel = _vrel.copy(v.v).add(v.body.velocity).sub(_b);
    const spd = vel.length();
    switch (c.sasMode) {
      case 'stability':
        return null;
      case 'prograde':
        return spd > 0.5 ? out.copy(vel).normalize() : null;
      case 'retrograde':
        return spd > 0.5 ? out.copy(vel).normalize().negate() : null;
      case 'normal':
      case 'antinormal':
      case 'radial-out':
      case 'radial-in': {
        orbitalFrame(v.r, v.v, _a, _b, out);
        if (c.sasMode === 'normal') return out.copy(_b);
        if (c.sasMode === 'antinormal') return out.copy(_b).negate();
        if (c.sasMode === 'radial-out') return out;
        return out.negate();
      }
      case 'target':
      case 'anti-target': {
        if (!this.targetPosition(_b)) return null;
        v.absolutePosition(_a);
        out.copy(_b).sub(_a).normalize();
        return c.sasMode === 'target' ? out : out.negate();
      }
      case 'maneuver': {
        const n = this.nodes[0];
        if (!n || n.remaining.lengthSq() < 1e-6) return null;
        return out.copy(n.remaining).normalize();
      }
      case 'port':
        return v === this.active && this.dock.valid ? out.copy(this.dock.alignDir) : null;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Staging
  // ---------------------------------------------------------------------------

  stage(): boolean {
    const v = this.active;
    if (v.destroyed || this.stageCooldown > 0) return false;
    v.pruneEmptyStages();
    if (v.nextStage >= v.stages.length) return false;
    if (this.warp.rails) this.setWarpIndex(0);
    const uids = v.stages[v.nextStage]!;
    v.nextStage++;
    this.stageCooldown = 0.35;
    this.physics.emit('stage', v, `Stage ${v.nextStage} activated`);
    const wasPrelaunch = v.situation === 'prelaunch';
    let ignitedSomething = false;
    // Engines first (so they're part of the right vessel), then chutes/fairings, then decouplers
    for (const uid of uids) {
      const p = v.partByUid(uid);
      if (!p) continue;
      if (p.isEngine) {
        p.engineIgnited = true;
        ignitedSomething = true;
      } else if (p.def.parachute) {
        if (p.chuteState === 'stowed') p.chuteState = 'armed';
      } else if (p.def.fairing && p.fairingAttached) {
        this.jettisonFairing(v, p);
      }
    }
    if (ignitedSomething && v.controls.throttle <= 0 && wasPrelaunch) v.controls.throttle = 1;
    if (ignitedSomething && v.controls.throttle <= 0) v.controls.throttle = 1;
    for (const uid of uids) {
      const p = v.partByUid(uid);
      if (!p) continue;
      if (p.def.decoupler) this.decouple(v, p);
      else if (p.def.dock && p.dockedTo) this.undock(p);
    }
    if (wasPrelaunch) {
      v.clamped = false;
      v.pinned = false;
      v.situation = 'flying';
      this.attitude.resetHold(v);
    }
    v.computeMassProperties(true);
    // A landed (pinned) vessel that just dropped a stage has a new centre of mass:
    // re-anchor it, or the remaining stack renders sunk into the ground until liftoff
    if (v.pinned) v.pinnedPos.copy(v.r).applyQuaternion(v.body.rotationInverse);
    this.predictionDirty = true;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Action groups & sandbox tools
  // ---------------------------------------------------------------------------

  /**
   * Fire action group `n` (1–10) on the active vessel: every part assigned to it
   * responds — engines light or shut down, legs, solar arrays and airbrakes flip,
   * decouplers, parachutes and fairings fire, docking ports release. Toggles are
   * decided once per group, so a mixed group always flips the same way.
   * Returns how many parts responded.
   */
  triggerActionGroup(n: number): number {
    const v = this.active;
    this.groupHeld = 0;
    if (v.destroyed) return 0;
    const parts = v.parts.filter((p) => !p.destroyed && Array.isArray(p.config.groups) && p.config.groups.includes(n));
    if (!parts.length) return 0;
    if (this.warp.rails) this.setWarpIndex(0);
    const legsOut = parts.some((p) => !!p.def.legs && p.legsDeployed);
    const enginesOn = parts.some((p) => p.isEngine && !p.isSolid && p.engineIgnited);
    let brakes = false;
    const separate: FlightPart[] = [];
    for (const p of parts) {
      switch (actionKind(p.def)) {
        case 'engine':
          if (p.isSolid) p.engineIgnited = true;
          else if (enginesOn) {
            p.engineIgnited = false;
            p.engineRunning = false;
          } else p.engineIgnited = true;
          break;
        case 'chute':
          if (p.chuteState === 'stowed') p.chuteState = 'armed';
          break;
        case 'fairing':
          if (p.fairingAttached) this.jettisonFairing(v, p);
          break;
        case 'legs':
          p.legsDeployed = !legsOut;
          break;
        case 'solar':
          p.solarStowed = !p.solarStowed;
          break;
        case 'brake':
          brakes = true;
          break;
        case 'decouple':
        case 'dock':
          // Clamped on the pad the stack is pinned as one piece: separations wait for liftoff
          if (v.situation === 'prelaunch') this.groupHeld++;
          else separate.push(p);
          break;
      }
    }
    if (brakes) v.controls.brakes = !v.controls.brakes;
    for (const p of separate) {
      if (p.destroyed) continue;
      // An earlier separation in this group may have moved the part to another
      // vessel (and handed control to it): act on whichever vessel holds it now
      const owner = this.vessels.find((x) => !x.destroyed && x.parts.includes(p));
      if (!owner) continue;
      if (p.def.decoupler) this.decouple(owner, p);
      else if (p.dockedTo && owner === this.active) this.undock(p);
    }
    v.pruneEmptyStages();
    v.computeMassProperties(true);
    if (v.pinned) v.pinnedPos.copy(v.r).applyQuaternion(v.body.rotationInverse);
    this.predictionDirty = true;
    return parts.length;
  }

  /** Separations an action group could not fire (vessel still clamped on the pad). */
  groupHeld = 0;

  /** Airbrakes open/closed (B). Returns the new state. */
  toggleBrakes(): boolean {
    const c = this.active.controls;
    c.brakes = !c.brakes;
    return c.brakes;
  }

  /** Sandbox "set orbit": move a vessel into a circular orbit around any body. */
  teleport(v: Vessel, body: CelestialBody, altitude: number, incDeg: number): void {
    if (v.destroyed) return;
    this.setWarpIndex(0);
    for (const n of [...this.nodes]) this.removeNode(n);
    this.placeInOrbit(v, body, altitude, incDeg);
    this.prevRel.delete(v.id);
    this.prevQ.delete(v.id);
    this.prevBody.delete(v.id);
    if (isNaN(this.launchTime)) this.launchTime = this.time;
    this.predictionDirty = true;
  }

  private decouple(v: Vessel, p: FlightPart): void {
    const d = p.def.decoupler!;
    // Separation axis: stack → along vessel Y (the lower part is pushed back),
    // radial → outward from the parent's axis.
    let axis: Vector3;
    if (d.radial || p.attach === 'radial') {
      axis = new Vector3(1, 0, 0).applyQuaternion(p.rotation).applyQuaternion(v.q).negate();
    } else {
      const sign = p.attach === 'above' ? -1 : 1;
      axis = new Vector3(0, sign, 0).applyQuaternion(v.q);
    }
    const child = v.split(separationPoint(p), d.separationDv, axis);
    if (child) {
      child.situation = v.situation;
      // Radial boosters: small outward tumble
      if (d.radial) child.w.set(0, 0, 0.12).applyQuaternion(p.rotation);
      // A released section with its own command part is a spacecraft, not debris: name it
      if (child.isControllable) child.name = `${v.name.replace(/ debris$/, '')} · unit ${++this.releasedUnits}`;
      this.vessels.push(child);
      this.physics.emit('decouple', v, 'Stage separation', p);
      this.followCommandModule(v, child, true);
    }
  }

  /**
   * After a split the root side stays `v`; if the command module (and thus
   * control) went with the separated section, THAT is the vessel the player
   * flies on.
   */
  private followCommandModule(v: Vessel, child: Vessel, rename: boolean): void {
    if (v !== this.active || v.isControllable || !child.isControllable) return;
    if (rename) {
      child.name = v.name;
      v.name = `${v.name} debris`;
    }
    child.debris = false;
    v.debris = !v.isControllable;
    child.controls.throttle = v.controls.throttle;
    child.controls.sas = v.controls.sas;
    child.controls.sasMode = v.controls.sasMode;
    v.controls.throttle = 0;
    this.active = child;
    this.attitude.resetHold(child);
  }

  // ---------------------------------------------------------------------------
  // Docking
  // ---------------------------------------------------------------------------

  /**
   * Latch the active vessel to another one when two free docking faces meet:
   * within DOCK_CAPTURE_DISTANCE, facing each other within DOCK_MAX_ANGLE, and
   * closing slower than DOCK_MAX_SPEED. Ports must be the same size.
   */
  private checkDocking(): void {
    const a = this.active;
    if (a.destroyed || a.pinned || a.onRails) return;
    const portsA = a.freeDockPorts();
    if (!portsA.length) return;
    a.absolutePosition(_a);
    for (const b of this.vessels) {
      if (b === a || b.destroyed || b.pinned || b.body !== a.body) continue;
      b.absolutePosition(_b);
      if (_a.distanceTo(_b) > 60) continue;
      const portsB = b.freeDockPorts();
      if (!portsB.length) continue;
      if (_r.copy(a.v).sub(b.v).length() > DOCK_MAX_SPEED) continue;
      for (const pa of portsA) {
        a.dockFacePose(pa.part, pa.face, _dockPosA, _dockDirA);
        for (const pb of portsB) {
          if (Math.abs(pa.part.stats.diameterTop - pb.part.stats.diameterTop) > 0.01) continue;
          b.dockFacePose(pb.part, pb.face, _dockPosB, _dockDirB);
          if (_dockPosA.distanceTo(_dockPosB) > DOCK_CAPTURE_DISTANCE) continue;
          if (_dockDirA.dot(_dockDirB) > -Math.cos(DOCK_MAX_ANGLE)) continue;
          if (b.onRails) {
            b.railsOrbit.getStateAt(this.time, b.r, b.v);
            b.onRails = false;
          }
          const otherName = b.name;
          if (this.target === b) this.target = null;
          a.dock(pa.part, pa.face, b, pb.part);
          a.controls.tx = a.controls.ty = a.controls.tz = 0;
          this.attitude.resetHold(a);
          this.predictionDirty = true;
          this.physics.emit('docked', a, `Docked with ${otherName}`, pa.part);
          return;
        }
      }
    }
  }

  /** Release a docked module at `port` (either side of the pair). */
  undock(port: FlightPart): boolean {
    const v = this.active;
    const root = port.dockRoot;
    const other = port.dockedTo;
    if (!root || !other || !root.parent || !v.parts.includes(port)) return false;
    const hostPort = root.parent;
    const face: 1 | -1 = root.attach === 'above' ? 1 : -1;
    // Push the module away along the host port's docking axis
    const axis = new Vector3(0, face, 0).applyQuaternion(hostPort.rotation).applyQuaternion(v.q).negate();
    port.dockedTo = null;
    other.dockedTo = null;
    port.dockRoot = null;
    other.dockRoot = null;
    const child = v.split(root, DOCK_SEPARATION_DV, axis);
    if (!child) return false;
    child.name = root.vesselName ?? `${v.name} module`;
    root.vesselName = null;
    child.debris = !child.isControllable;
    child.situation = v.situation;
    this.vessels.push(child);
    this.followCommandModule(v, child, false);
    this.predictionDirty = true;
    this.physics.emit('undocked', this.active, `Undocked from ${this.active === v ? child.name : v.name}`, port);
    return true;
  }

  /** Docked module roots on the active vessel (for the Undock button). */
  dockedPorts(): FlightPart[] {
    return this.active.parts.filter((p) => !!p.def.dock && !!p.dockedTo && !!p.dockRoot && p.dockRoot.parent === p);
  }

  private jettisonFairing(v: Vessel, p: FlightPart): void {
    p.fairingAttached = false;
    const dia = p.fairingDiameter;
    const len = p.fairingLength;
    const base = new Vector3(0, p.height / 2, 0).applyQuaternion(p.rotation).add(p.position);
    for (const side of [1, -1] as const) {
      const local = base.clone().add(new Vector3(side * dia * 0.25, len * 0.45, 0));
      const pos = v.localToBody(local, new Vector3()).add(v.body.position);
      const out = new Vector3(side, 0, 0).applyQuaternion(v.q);
      const vel = v.absoluteVelocity(new Vector3()).addScaledVector(out, 3.5);
      this.fairings.push({
        pos,
        vel,
        q: v.q.clone(),
        w: new Vector3(0, 0, -side * 0.35),
        body: v.body,
        diameter: dia,
        length: len,
        side,
        age: 0,
      });
    }
    v.refreshStructure();
    v.computeMassProperties(true);
    this.physics.emit('fairing', v, 'Fairing separation', p);
  }

  private updateFairings(dt: number): void {
    for (let i = this.fairings.length - 1; i >= 0; i--) {
      const f = this.fairings[i]!;
      f.age += dt;
      const b = f.body;
      _r.copy(f.pos).sub(b.position);
      const r2 = _r.lengthSq();
      f.vel.addScaledVector(_r, (-b.mu / (r2 * Math.sqrt(r2))) * dt);
      // light drag in atmosphere
      if (b.atmosphere) {
        const alt = Math.sqrt(r2) - b.radius;
        if (alt < b.atmosphere.ceiling) {
          const rel = _v.copy(f.vel).sub(b.velocity);
          f.vel.addScaledVector(rel, -Math.min(0.5, 2e-4 * Math.exp(-alt / 7000)) * dt * 60);
        }
      }
      f.pos.addScaledVector(f.vel, dt);
      const ang = f.w.length() * dt;
      if (ang > 0) {
        _t.copy(f.w).normalize();
        _q.setFromAxisAngle(_t, ang);
        f.q.multiply(_q);
      }
      if (f.age > 90) this.fairings.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Destruction
  // ---------------------------------------------------------------------------

  private processDestruction(): void {
    const q = this.physics.destroyQueue;
    if (!q.length) return;
    const seen = new Set<FlightPart>();
    for (const req of q) {
      if (seen.has(req.part) || req.part.destroyed || req.vessel.destroyed) continue;
      seen.add(req.part);
      this.destroyPart(req.vessel, req.part, req.reason, req.speed);
    }
    q.length = 0;
  }

  destroyPart(v: Vessel, p: FlightPart, reason: string, speed: number): void {
    p.destroyed = true;
    const msg =
      reason === 'crash'
        ? `${p.def.name} destroyed on impact (${speed.toFixed(1)} m/s)`
        : reason === 'overheat'
          ? `${p.def.name} burned up (${p.temperature.toFixed(0)} K)`
          : reason === 'breakup'
            ? `Structural failure! Aerodynamic loads tore off the ${p.def.name}`
            : `${p.def.name} destroyed`;
    this.physics.emit(reason === 'overheat' ? 'overheat' : reason === 'breakup' ? 'breakup' : 'crash', v, msg, p, speed);
    if (p === v.root) {
      // Losing the root: everything else becomes debris
      for (const c of [...p.children]) {
        const child = v.split(c, 0.5, null);
        if (child) {
          child.debris = true;
          this.vessels.push(child);
        }
      }
      v.destroyed = true;
      v.situation = 'destroyed';
      this.physics.emit('vessel-destroyed', v, v === this.active ? 'Vessel destroyed' : 'Debris destroyed');
      if (v === this.active) this.setWarpIndex(0);
      return;
    }
    // Children of the destroyed part become separate debris vessels
    for (const c of [...p.children]) {
      const child = v.split(c, 0.5, null);
      if (child) this.vessels.push(child);
    }
    // Remove the part itself
    const parent = p.parent;
    if (parent) parent.children.splice(parent.children.indexOf(p), 1);
    p.parent = null;
    v.parts = v.parts.filter((x) => x !== p);
    v.stages = v.stages.map((s) => s.filter((u) => u !== p.uid));
    v.pruneEmptyStages();
    v.refreshStructure();
    v.computeMassProperties(true);
    if (!v.isControllable && v === this.active && !v.debris) {
      this.physics.emit('vessel-destroyed', v, 'Command module lost — no control');
    }
  }

  // ---------------------------------------------------------------------------
  // Environment transitions
  // ---------------------------------------------------------------------------

  /** Returns true if the vessel changed SOI. */
  private checkSOI(v: Vessel): boolean {
    const b = v.body;
    if (b.parent && isFinite(b.soiRadius) && v.r.length() > b.soiRadius) {
      b.relativeStateAt(this.time, _a, _b);
      v.r.add(_a);
      v.v.add(_b);
      v.body = b.parent;
      if (v === this.active) this.physics.emit('soi-change', v, `Leaving ${b.name}'s sphere of influence → ${v.body.name}`);
      this.predictionDirty = true;
      return true;
    }
    for (const c of b.children) {
      c.relativeStateAt(this.time, _a, _b);
      if (_r.copy(v.r).sub(_a).length() < c.soiRadius) {
        v.r.sub(_a);
        v.v.sub(_b);
        v.body = c;
        if (v === this.active) this.physics.emit('soi-change', v, `Entering ${c.name}'s sphere of influence`);
        this.predictionDirty = true;
        return true;
      }
    }
    return false;
  }

  private updateSituation(v: Vessel, dt: number): void {
    if (v.destroyed) {
      v.situation = 'destroyed';
      return;
    }
    const surfSpeed = v.surfaceVelocity.length();
    if (v.touchingGround || v.inWater) {
      const prev = v.situation;
      // Scraping the ground during the first moments of a liftoff isn't a landing:
      // engines still spooling up let the stack settle back for an instant, both
      // on the pad and when lifting off again from the Moon or Mars
      const justLaunched = !isNaN(this.launchTime) && this.time - this.launchTime < 4;
      const takingOff = prev === 'flying' && v.airborneTime < 1.5 && (justLaunched || v.totalThrust > 0);
      if (takingOff) return;
      if (prev !== 'landed' && prev !== 'splashed' && prev !== 'prelaunch') {
        if (v.inWater) this.physics.emit('splashdown', v, `Splashdown at ${surfSpeed.toFixed(1)} m/s`, undefined, surfSpeed);
        else this.physics.emit('touchdown', v, `Touchdown at ${surfSpeed.toFixed(1)} m/s`, undefined, surfSpeed);
      }
      v.airborneTime = 0;
      v.situation = v.inWater ? 'splashed' : 'landed';
      if (surfSpeed < LANDED_SPEED_THRESHOLD * (v.inWater ? 6 : 1) && v.w.length() < 0.05 && v.totalThrust === 0) {
        v.settledTime += dt;
        if (v.settledTime > LANDED_SETTLE_TIME && !v.pinned) {
          const body = v.body;
          v.pinnedPos.copy(v.r).applyQuaternion(body.rotationInverse);
          v.pinnedRot.copy(body.rotationInverse).multiply(v.q);
          v.pinned = true;
          if (v === this.active) this.physics.emit('landed', v, v.inWater ? `Splashed down on ${body.name}` : `Landed on ${body.name}`);
        }
      } else {
        v.settledTime = 0;
      }
      return;
    }
    v.settledTime = 0;
    v.airborneTime += dt;
    if (v.inAtmosphere) {
      v.situation = 'flying';
      return;
    }
    this.updateSituationRails(v);
  }

  private updateSituationRails(v: Vessel): void {
    if (v.pinned || v.destroyed) return;
    const o = v.onRails ? v.railsOrbit : _orbit.setFromState(v.r, v.v, v.body.mu, this.time);
    const b = v.body;
    const floor = b.radius + (b.atmosphere ? b.atmosphere.ceiling : (b.terrain?.maxHeight ?? 0) + 500);
    if (v.inAtmosphere) v.situation = 'flying';
    else if (!o.isElliptic || o.apoapsis > b.soiRadius) v.situation = o.periapsis < b.radius ? 'suborbital' : 'escaping';
    else if (o.periapsis > floor) v.situation = 'orbiting';
    else v.situation = 'suborbital';
  }

  private cullVessels(): void {
    const act = this.active;
    for (const v of this.vessels) {
      if (v === act || v.destroyed) continue;
      if (this.isFarAway(v)) {
        if (!v.onRails && !v.pinned) {
          const o = _orbit.setFromState(v.r, v.v, v.body.mu, this.time);
          const floor = v.body.radius + (v.body.atmosphere ? v.body.atmosphere.ceiling : 0);
          if (o.periapsis < floor && v.debris) {
            v.destroyed = true;
            continue;
          }
          v.railsOrbit.copy(o);
          v.onRails = true;
        }
      }
      if (v.debris && v.age > 900 && this.isFarAway(v) && v.situation !== 'orbiting') v.destroyed = true;
    }
    for (let i = this.vessels.length - 1; i >= 0; i--) {
      const v = this.vessels[i]!;
      if (v.destroyed && v !== act && v.age > 0) {
        this.vessels.splice(i, 1);
        this.prevRel.delete(v.id);
        this.prevQ.delete(v.id);
        this.prevBody.delete(v.id);
      }
    }
    // Keep the debris count bounded (count first: this runs every physics step)
    let nDebris = 0;
    for (const x of this.vessels) if (x.debris && x !== act) nDebris++;
    if (nDebris > 40) {
      const debris = this.vessels.filter((x) => x.debris && x !== act);
      debris.sort((a, b) => b.age - a.age);
      for (const d of debris.slice(0, debris.length - 40)) d.destroyed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Prediction & maneuver nodes
  // ---------------------------------------------------------------------------

  /** Returns true when a new prediction was computed this frame. */
  private updatePrediction(realDt: number): boolean {
    this.predictTimer -= realDt;
    const v = this.active;
    if (v.destroyed) {
      this.predictor.count = 0;
      return false;
    }
    // A coasting orbit only changes at discrete events (staging, SOI change, node
    // edits), which set predictionDirty; otherwise a timer sets the cadence — fast
    // while the orbit is actually changing (thrust or drag), 5 Hz when coasting.
    // Each prediction is up to four conic patches with encounter scans, so running
    // it every rendered frame was the single biggest CPU cost of a coast.
    const thrusting = v.totalThrust > 0 || v.inAtmosphere;
    if (!this.predictionDirty && this.predictTimer > 0) return false;
    this.predictTimer = thrusting ? 0.05 : 0.2;
    this.predictionDirty = false;
    if (v.pinned && v.situation !== 'landed') {
      this.predictor.count = 0;
      return true;
    }
    const src = v.onRails ? v.railsOrbit : null;
    if (src) {
      src.getStateAt(this.time, _r, _v);
      this.predictor.predict(v.body, _r, _v, this.time, { maxPatches: 4, target: this.targetBody });
    } else {
      this.predictor.predict(v.body, v.r, v.v, this.time, { maxPatches: 4, target: this.targetBody });
    }
    return true;
  }

  /** Patch index of the active prediction containing time t (or -1). */
  patchAt(t: number): number {
    for (let i = 0; i < this.predictor.count; i++) {
      const p = this.predictor.patches[i]!;
      // A closed orbit with no event ahead repeats forever: nodes may be placed
      // any number of revolutions out (rendezvous phasing needs that), even though
      // the drawn patch covers one revolution
      const open = p.endReason === 'none' && p.orbit.isElliptic && i === this.predictor.count - 1;
      if (t >= p.startTime - 1e-6 && (open || t <= p.endTime + 1e-6)) return i;
    }
    return -1;
  }

  /**
   * Patch holding a node's time. A long burn can still be running after the
   * node's time has passed (burns are centred on the node); the current orbit —
   * propagated back to the node time — is then the right reference.
   */
  private nodePatch(n: ManeuverNode): number {
    const idx = this.patchAt(n.time);
    if (idx >= 0) return idx;
    // A burn centred on the node — or one that started late because the vessel was
    // still turning — runs past the node time; the current orbit is the reference
    const recent = n.time <= this.time && this.time - n.time < 3600;
    if ((n.burning || recent) && this.predictor.count > 0 && this.predictor.patches[0]!.body === n.body) return 0;
    return -1;
  }

  addNode(t: number): ManeuverNode | null {
    const idx = this.patchAt(t);
    if (idx < 0) return null;
    const patch = this.predictor.patches[idx]!;
    const n = createNode(t, patch.body);
    refreshNodeTarget(n, patch.orbit);
    this.nodes.push(n);
    this.nodes.sort((a, b) => a.time - b.time);
    return n;
  }

  removeNode(n: ManeuverNode): void {
    const i = this.nodes.indexOf(n);
    if (i >= 0) this.nodes.splice(i, 1);
  }

  /** Re-derive a node's target after the player edits its components or time. */
  editNode(n: ManeuverNode): void {
    const idx = this.patchAt(n.time);
    if (idx < 0) return;
    const patch = this.predictor.patches[idx]!;
    n.body = patch.body;
    refreshNodeTarget(n, patch.orbit);
    n.burning = false;
  }

  private updateNodes(): void {
    const v = this.active;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]!;
      // Only the NEXT node can be the one being executed: thrust near a later
      // node's time must not freeze that node's plan onto the pre-burn orbit
      if (i === 0 && v.totalThrust > 0 && Math.abs(n.time - this.time) < 3600) {
        n.burning = true;
        n.lastThrust = this.time;
      }
      // A burn flown by hand is over once the engines have been quiet for a while
      // past the node; drop it, or it would steer SAS "maneuver" forever
      if (n.burning && this.time > n.time && v.totalThrust <= 0 && (isNaN(n.lastThrust) || this.time - n.lastThrust > 20)) {
        this.nodes.splice(i, 1);
        continue;
      }
      const idx = this.nodePatch(n);
      if (idx < 0 || this.predictor.patches[idx]!.body !== n.body) {
        // Node no longer lies on the predicted path (e.g. far in the past)
        if (!n.burning && n.time < this.time - 600) this.nodes.splice(i, 1);
        continue;
      }
      const orbit = this.predictor.patches[idx]!.orbit;
      if (!n.burning) refreshNodeTarget(n, orbit);
      if (v.body === n.body) updateNodeRemaining(n, orbit, v.r, v.v);
      else updateNodeRemaining(n, orbit);
    }
    // Predict the trajectory after the first node
    const n0 = this.nodes[0];
    if (n0) {
      const idx = this.nodePatch(n0);
      if (idx >= 0 && this.predictor.patches[idx]!.body === n0.body) {
        const orbit = this.predictor.patches[idx]!.orbit;
        nodeStateAfter(n0, orbit, _r, _v);
        this.nodePredictor.predict(n0.body, _r, _v, n0.time, { maxPatches: 4, target: this.targetBody });
      } else this.nodePredictor.count = 0;
    } else {
      this.nodePredictor.count = 0;
    }
  }

  /** Mission elapsed time (s). */
  get missionTime(): number {
    return isNaN(this.launchTime) ? 0 : this.time - this.launchTime;
  }
}

const _orbit = new Orbit();
