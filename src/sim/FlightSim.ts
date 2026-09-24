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
} from './Maneuver';
import { Vessel } from './Vessel';
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
  target: CelestialBody | null = null;
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
  /** Seconds the active vessel has been coasting in vacuum with no forces. */
  private stageCooldown = 0;

  constructor(system: SolarSystem, craft: CraftData, site: LaunchSite, startTime: number) {
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
    this.updatePrediction(realDt);
    this.updateNodes();
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
        // Engines on a pinned vessel (clamped prelaunch or landed): release when thrusting
        if (v.situation !== 'prelaunch' && v.controls.throttle > 0 && v.parts.some((p) => p.engineIgnited && (p.engineRunning || p.isSolid || p.ignitionsLeft > 0))) {
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
    this.cullVessels();
    if (this.stageCooldown > 0) this.stageCooldown -= dt;
    // Liftoff detection
    if (isNaN(this.launchTime) && active.situation === 'flying' && active.altitude - active.terrainHeight > 1 && !active.pinned) {
      this.launchTime = this.time;
      this.physics.emit('liftoff', active, 'Liftoff!');
    }
    this.predictionDirty = true;
  }

  private railsAdvance(dtSim: number): void {
    let tEnd = this.time + dtSim;
    let hitEvent = false;
    const v = this.active;
    if (!v.pinned && !v.destroyed) {
      // Refresh prediction for event times
      this.predictor.predict(v.body, v.r, v.v, this.time, { maxPatches: 2, target: this.target });
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
      const lead = 60;
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
        ves.railsOrbit.setFromState(ves.r, ves.v, ves.body.mu, this.time - dtSim);
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
    this.cullVessels();
    this.predictionDirty = true;
    if (hitEvent) this.setWarpIndex(0);
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
    const vel = c.speedMode === 'surface' ? v.surfaceVelocity : v.v;
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
        if (!this.target) return null;
        v.absolutePosition(_a);
        out.copy(this.target.position).sub(_a).normalize();
        return c.sasMode === 'target' ? out : out.negate();
      }
      case 'maneuver': {
        const n = this.nodes[0];
        if (!n || n.remaining.lengthSq() < 1e-6) return null;
        return out.copy(n.remaining).normalize();
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Staging
  // ---------------------------------------------------------------------------

  stage(): boolean {
    const v = this.active;
    if (v.destroyed || this.stageCooldown > 0) return false;
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
      if (!p || !p.def.decoupler) continue;
      this.decouple(v, p);
    }
    if (wasPrelaunch) {
      v.clamped = false;
      v.pinned = false;
      v.situation = 'flying';
      this.attitude.resetHold(v);
    }
    v.computeMassProperties(true);
    this.predictionDirty = true;
    return true;
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
    const child = v.split(p, d.separationDv, axis);
    if (child) {
      child.situation = v.situation;
      // Radial boosters: small outward tumble
      if (d.radial) child.w.set(0, 0, 0.12).applyQuaternion(p.rotation);
      this.vessels.push(child);
      this.physics.emit('decouple', v, 'Stage separation', p);
    }
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
      // Scraping the pad during the first moments of a liftoff isn't a landing
      const takingOff = prev === 'flying' && v.airborneTime < 1.5 && v.totalThrust > v.mass * (v.body.mu / v.r.lengthSq());
      if (takingOff) return;
      if (prev !== 'landed' && prev !== 'splashed' && prev !== 'prelaunch') {
        if (v.inWater) this.physics.emit('splashdown', v, `Splashdown at ${surfSpeed.toFixed(1)} m/s`);
        else this.physics.emit('touchdown', v, `Touchdown at ${surfSpeed.toFixed(1)} m/s`);
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
    // Keep the debris count bounded
    const debris = this.vessels.filter((x) => x.debris && x !== act);
    if (debris.length > 40) {
      debris.sort((a, b) => b.age - a.age);
      for (const d of debris.slice(0, debris.length - 40)) d.destroyed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Prediction & maneuver nodes
  // ---------------------------------------------------------------------------

  private updatePrediction(realDt: number): void {
    this.predictTimer -= realDt;
    const v = this.active;
    if (v.destroyed) {
      this.predictor.count = 0;
      return;
    }
    const thrusting = v.totalThrust > 0 || v.inAtmosphere;
    if (!this.predictionDirty && this.predictTimer > 0) return;
    if (thrusting && this.predictTimer > 0 && !this.warp.rails) return;
    this.predictTimer = thrusting ? 0.05 : 0.2;
    this.predictionDirty = false;
    if (v.pinned && v.situation !== 'landed') {
      this.predictor.count = 0;
      return;
    }
    const src = v.onRails ? v.railsOrbit : null;
    if (src) {
      src.getStateAt(this.time, _r, _v);
      this.predictor.predict(v.body, _r, _v, this.time, { maxPatches: 4, target: this.target });
    } else {
      this.predictor.predict(v.body, v.r, v.v, this.time, { maxPatches: 4, target: this.target });
    }
  }

  /** Patch index of the active prediction containing time t (or -1). */
  patchAt(t: number): number {
    for (let i = 0; i < this.predictor.count; i++) {
      const p = this.predictor.patches[i]!;
      if (t >= p.startTime - 1e-6 && t <= p.endTime + 1e-6) return i;
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
    if (n.burning && n.time <= this.time && this.predictor.count > 0 && this.predictor.patches[0]!.body === n.body) return 0;
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
      const idx = this.nodePatch(n);
      if (idx < 0 || this.predictor.patches[idx]!.body !== n.body) {
        // Node no longer lies on the predicted path (e.g. far in the past)
        if (!n.burning && n.time < this.time - 600) this.nodes.splice(i, 1);
        continue;
      }
      const orbit = this.predictor.patches[idx]!.orbit;
      if (v.totalThrust > 0 && Math.abs(n.time - this.time) < 3600) n.burning = true;
      if (!n.burning) refreshNodeTarget(n, orbit);
      if (v.body === n.body) updateNodeRemaining(n, orbit, v.r, v.v);
      else updateNodeRemaining(n, orbit);
    }
    // Predict the trajectory after the first node
    const n0 = this.nodes[0];
    if (n0) {
      const idx = this.nodePatch(n0);
      if (idx >= 0) {
        const orbit = this.predictor.patches[idx]!.orbit;
        nodeStateAfter(n0, orbit, _r, _v);
        this.nodePredictor.predict(n0.body, _r, _v, n0.time, { maxPatches: 4, target: this.target });
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
