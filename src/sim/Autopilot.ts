/**
 * LEARNING NOTE: Guidance — how rockets steer themselves
 *
 * ASCENT. A rocket first climbs vertically to clear the tower, then "pitches
 * over" and follows a gravity turn: gravity itself bends the trajectory toward the
 * horizon while the vehicle keeps its angle of attack near zero (big side loads
 * at high dynamic pressure break rockets). Above the dense atmosphere we switch
 * to closed-loop guidance: choose the pitch angle whose vertical thrust component
 * exactly balances "effective gravity" g − v_h²/r plus a correction toward a
 * target climb rate. As horizontal speed approaches orbital velocity, v_h²/r → g,
 * the required pitch falls to zero and the vehicle slides into a circular orbit.
 *
 * MANEUVER EXECUTION. Point along the remaining Δv vector and start so that
 * half the Δv is delivered before the node (not half the burn TIME — the rocket
 * lightens as it burns, so the Δv comes faster at the end), then throttle down
 * as the remaining Δv shrinks.
 *
 * POWERED DESCENT (the "suicide burn"). Stopping distance under constant
 * deceleration a is d = v²/2a. We fly a reference profile v_ref(h) = √(2·a·h)
 * with a safety margin and let a proportional controller hold the vertical speed
 * on it, pointing retrograde to kill horizontal drift, then descend the last
 * metres at ~1.5 m/s on the landing legs.
 *
 * Key concepts: gravity turn, closed-loop guidance, effective gravity, burn
 * centring, proportional control, stopping distance
 */
import { Vector3 } from 'three';
import { DEG, G0 } from '../core/constants';
import { clamp } from '../core/math';
import { estimateBurnTime } from './Maneuver';
import type { FlightSim } from './FlightSim';
import type { Vessel } from './Vessel';

export type AutopilotMode = 'off' | 'ascent' | 'node' | 'land';

export interface AscentParams {
  /** Target circular orbit altitude (m). */
  targetAltitude: number;
  /** Launch heading, degrees clockwise from north (90 = due east). */
  heading: number;
  /**
   * Target orbital plane (unit normal, inertial frame) from a launch window. When
   * set, the rocket steers to stay IN that plane instead of holding a compass
   * heading — a constant heading would curve the ground track and rotate the
   * orbit's node by 15–20° over 2,000 km of downrange flight.
   */
  planeNormal: Vector3 | null;
  /** Surface speed at which the pitch-over starts (m/s). */
  turnStartSpeed: number;
  autoStage: boolean;
  /** Limit acceleration (g) — useful for crew. */
  maxG: number;
}

/** Exponent of the apoapsis-feedback pitch law. */
export let TURN_SHAPE = 0.55;
/** Test hook for tuning the pitch law. */
export function setTurnShape(s: number): void {
  TURN_SHAPE = s;
}

const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _dir = new Vector3();
const _plane = new Vector3();
const _tmp = new Vector3();
const _pro = new Vector3();
const _sUp = new Vector3();
const _sE = new Vector3();
const _sDir = new Vector3();
const _nose = new Vector3();

export class Autopilot {
  mode: AutopilotMode = 'off';
  phase = '';
  readonly ascent: AscentParams = {
    targetAltitude: 200_000,
    heading: 90,
    planeNormal: null,
    turnStartSpeed: 60,
    autoStage: true,
    maxG: 5,
  };
  /** Desired nose direction (inertial), consumed by the attitude controller. */
  readonly target = new Vector3();
  hasTarget = false;
  private stageTimer = 0;
  /** Landing: the braking burn has started (latched). */
  private braking = false;
  private brakeTimer = 0;
  private brakeThrottle = 1;
  private brakeLate = false;
  /** Set when the program completes; UI shows it then clears. */
  doneMessage = '';

  engage(mode: AutopilotMode, sim: FlightSim): void {
    this.mode = mode;
    this.phase = '';
    this.doneMessage = '';
    this.stageTimer = 0;
    this.braking = false;
    this.brakeTimer = 0;
    this.brakeLate = false;
    const v = sim.active;
    v.controls.sas = true;
    if (mode === 'ascent' && v.situation === 'prelaunch') v.controls.throttle = 1;
    if (mode === 'land') {
      v.controls.speedMode = 'surface';
      for (const p of v.parts) if (p.def.legs) p.legsDeployed = true;
    }
    if (mode === 'off') this.hasTarget = false;
  }

  disengage(msg = ''): void {
    this.mode = 'off';
    this.hasTarget = false;
    this.doneMessage = msg;
  }

  /** Called every physics step before the vessel is integrated. */
  update(sim: FlightSim, dt: number): void {
    const v = sim.active;
    if (this.mode === 'off' || v.destroyed) {
      this.hasTarget = false;
      return;
    }
    if (!v.isControllable) {
      this.disengage('Autopilot: no control');
      return;
    }
    switch (this.mode) {
      case 'ascent':
        this.updateAscent(sim, v, dt);
        break;
      case 'node':
        this.updateNode(sim, v, dt);
        break;
      case 'land':
        this.updateLand(sim, v, dt);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  private localFrame(v: Vessel): void {
    _up.copy(v.r).normalize();
    // East = ω × r direction (planet spin axis is the body's local Y)
    _tmp.set(0, 1, 0).applyQuaternion(v.body.rotation);
    _east.crossVectors(_tmp, _up);
    if (_east.lengthSq() < 1e-10) _east.set(1, 0, 0);
    _east.normalize();
    _north.crossVectors(_up, _east).normalize();
  }

  /**
   * Thrust available right now from ignited engines that can actually burn (N):
   * a liquid engine whose tanks ran dry counts for nothing, however many
   * re-ignitions it has left.
   */
  private availableThrust(v: Vessel): number {
    let t = 0;
    for (const p of v.parts) {
      if (!p.isEngine || !p.engineIgnited) continue;
      if (p.flameout && (p.isSolid || p.ignitionsLeft <= 0)) continue;
      if (v.engineFuel(p) <= 0) continue;
      t += p.stats.thrustVac;
    }
    return t;
  }

  private tryAutoStage(sim: FlightSim, v: Vessel, dt: number): void {
    if (!this.ascent.autoStage) return;
    this.stageTimer -= dt;
    if (this.stageTimer > 0) return;
    // Evaluate a few times a second, not every physics step
    this.stageTimer = 0.25;
    v.pruneEmptyStages();
    const next = v.stages[v.nextStage];
    if (!next) return;
    let nextHasEngine = false;
    let onlyFairing = next.length > 0;
    // Drop decoupled sections whose engines are all dry
    let dropsSpent = false;
    let anyDecoupler = false;
    let anyEngineBelow = false;
    for (const u of next) {
      const p = v.partByUid(u);
      if (!p) continue;
      if (p.isEngine) nextHasEngine = true;
      if (!p.def.fairing) onlyFairing = false;
      if (p.def.decoupler) {
        if (!anyDecoupler) {
          anyDecoupler = true;
          dropsSpent = true;
        }
        for (const q of v.subtree(p)) {
          if (q.isEngine) {
            anyEngineBelow = true;
            const dry = q.isSolid ? q.fuel <= 0 : q.flameout || !q.engineIgnited;
            if (!dry) dropsSpent = false;
          }
        }
      }
    }
    if (!anyEngineBelow) dropsSpent = false;
    const thrustNow = v.totalThrust;
    let anyRunning = false;
    for (const p of v.parts) {
      if (p.isEngine && p.engineIgnited && p.thrust > 0) {
        anyRunning = true;
        break;
      }
    }
    const atmTop = v.body.atmosphere ? v.body.atmosphere.ceiling : 0;
    let go = false;
    if (v.situation === 'prelaunch') go = true;
    else if (dropsSpent) go = true;
    else if (nextHasEngine && (thrustNow <= 0 || !anyRunning) && v.controls.throttle > 0) go = true;
    else if (onlyFairing && v.altitude > atmTop * 0.75) go = true;
    if (go) {
      sim.stage();
      this.stageTimer = 0.8;
    }
  }

  /** Burn time to deliver dv with the currently running engines (rocket equation). */
  private timeToGo(v: Vessel, dv: number): number {
    let thrust = 0;
    let mdot = 0;
    for (const p of v.parts) {
      if (!p.isEngine || !p.engineIgnited || p.thrust <= 0) continue;
      thrust += p.stats.thrustVac;
      mdot += p.stats.thrustVac / (p.stats.ispVac * G0);
    }
    if (thrust <= 0) return 60;
    const ve = thrust / mdot;
    const m0 = v.mass;
    return (m0 * (1 - Math.exp(-dv / ve))) / mdot;
  }

  // ---------------------------------------------------------------------------
  private updateAscent(sim: FlightSim, v: Vessel, dt: number): void {
    const a = this.ascent;
    // A circular orbit must clear the atmosphere with some margin
    const ceiling = v.body.atmosphere ? v.body.atmosphere.ceiling : 0;
    if (a.targetAltitude < ceiling + 30_000) a.targetAltitude = ceiling + 30_000;
    this.tryAutoStage(sim, v, dt);
    this.localFrame(v);
    const body = v.body;
    const h = v.altitude;
    const hdg = a.heading * DEG;
    // Horizontal heading direction
    _dir.copy(_north).multiplyScalar(Math.cos(hdg)).addScaledVector(_east, Math.sin(hdg)).normalize();
    if (a.planeNormal) {
      // Plane guidance: fly along the target plane (n × up), in the sense of the
      // launch heading, and steer against any velocity leaking out of the plane
      _plane.crossVectors(a.planeNormal, _up);
      if (_plane.lengthSq() > 1e-6) {
        _plane.normalize();
        if (_plane.dot(_dir) < 0) _plane.negate();
        const vOut = v.v.dot(a.planeNormal);
        const vHor = Math.max(200, Math.sqrt(Math.max(0, v.v.lengthSq() - v.v.dot(_up) ** 2)));
        _dir.copy(_plane).addScaledVector(a.planeNormal, -clamp((2 * vOut) / vHor, -0.35, 0.35)).normalize();
      }
    }
    const surfSpeed = v.surfaceVelocity.length();
    const atmTop = body.atmosphere ? body.atmosphere.ceiling : 0;

    // Orbit state
    const r = v.r.length();
    const mu = body.mu;
    const vVert = v.v.dot(_up);
    const vH2 = Math.max(0, v.v.lengthSq() - vVert * vVert);
    const gEff = mu / (r * r) - vH2 / r;
    const energy = v.v.lengthSq() / 2 - mu / r;
    const hVec = _tmp.crossVectors(v.r, v.v);
    const hm = hVec.length();
    const aSemi = -mu / (2 * energy);
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * hm * hm) / (mu * mu)));
    const pe = energy < 0 ? aSemi * (1 - e) - body.radius : -Infinity;
    const ap = energy < 0 ? aSemi * (1 + e) - body.radius : Infinity;

    const thrustAvail = this.availableThrust(v);
    const aT = thrustAvail / v.mass;

    // Throttle: full, but respect a G limit
    let throttle = 1;
    if (aT > 0) throttle = clamp((a.maxG * G0) / aT, 0.05, 1);

    const vH = Math.sqrt(vH2);
    const vCirc = Math.sqrt(mu / r);
    // Orbit complete? (nearly circular above the atmosphere, or at/over target)
    const targetPe = Math.max(atmTop + 15_000, a.targetAltitude - 15_000);
    const safePe = pe > atmTop + 10_000;
    if (safePe && (pe > targetPe || (pe > h - 8_000 && vH >= vCirc * 0.998) || ap > a.targetAltitude * 2.5)) {
      v.controls.throttle = 0;
      this.disengage(`Orbit achieved: ${(ap / 1000).toFixed(0)} × ${(pe / 1000).toFixed(0)} km`);
      v.controls.sasMode = 'prograde';
      v.controls.speedMode = 'orbit';
      return;
    }

    if (surfSpeed < a.turnStartSpeed && h - v.terrainHeight < 400) {
      this.phase = 'Vertical ascent';
      this.target.copy(_up);
    } else if (h < 60_000 && ap < a.targetAltitude * 0.95) {
      // Gravity turn steered by FEEDBACK on the apoapsis: pitch falls from vertical
      // to horizontal as the predicted apoapsis rises towards the target. A lofted
      // path raises the apoapsis early → the rocket pitches over sooner; a flat one
      // keeps it low → the rocket stays steeper. That self-correction makes one law
      // work for punchy small rockets and sluggish heavy lifters alike.
      this.phase = 'Gravity turn';
      const apAlt = energy < 0 ? Math.max(0, ap) : a.targetAltitude;
      const f = clamp(apAlt / (a.targetAltitude * 0.9), 0, 1);
      const ramp = clamp((surfSpeed - a.turnStartSpeed) / 40, 0, 1);
      let pitch = Math.PI / 2 - (Math.PI / 2) * Math.pow(f, TURN_SHAPE) * ramp;
      // Don't lie down while the air is still thick
      const floor = body.atmosphere ? 45 * DEG * Math.pow(Math.max(0, 1 - h / 50_000), 1.5) : 0;
      pitch = Math.max(pitch, floor);
      this.target.copy(_dir).multiplyScalar(Math.cos(pitch)).addScaledVector(_up, Math.sin(pitch)).normalize();
      // Keep angle of attack small while dynamic pressure is high
      if (surfSpeed > 30) {
        _pro.copy(v.surfaceVelocity).normalize();
        const q = v.dynamicPressure;
        const maxAoA = (q > 20_000 ? 2 : q > 8_000 ? 4 : 8) * DEG;
        const ang = Math.acos(clamp(_pro.dot(this.target), -1, 1));
        if (ang > maxAoA) {
          const k = maxAoA / ang;
          this.target.lerpVectors(_pro, this.target, k).normalize();
        }
      }
    } else {
      this.phase = 'Orbital insertion';
      const dh = a.targetAltitude - h;
      // E-guidance: choose the vertical acceleration a0 (linear in time) that reaches
      // the target altitude with zero vertical speed exactly when horizontal speed
      // reaches circular velocity. T = time-to-go from the rocket equation.
      const vCircT = Math.sqrt(mu / (body.radius + a.targetAltitude));
      const dvH = Math.max(0, vCircT - vH);
      const T = Math.max(4, this.timeToGo(v, dvH));
      let a0 = (6 * dh) / (T * T) - (4 * vVert) / T;
      // Safety: never let the predicted low point dip back into the atmosphere
      if (vVert < 0) {
        const tFall = Math.min(T, 200);
        const hLow = h + vVert * tFall + 0.5 * (a0) * tFall * tFall;
        if (hLow < atmTop + 8_000) a0 = Math.max(a0, (2 * (atmTop + 8_000 - h - vVert * tFall)) / (tFall * tFall));
      }
      let s = aT > 0 ? (a0 + gEff) / aT : 0;
      s = clamp(s, -0.3, 0.8);
      const pitch = Math.asin(s);
      // Heading: follow the current horizontal velocity to avoid dog-legs
      _pro.copy(v.v).addScaledVector(_up, -vVert);
      if (_pro.lengthSq() > 1) _pro.normalize();
      else _pro.copy(_dir);
      this.target.copy(_pro).multiplyScalar(Math.cos(pitch)).addScaledVector(_up, Math.sin(pitch)).normalize();
      if (h < atmTop && v.dynamicPressure > 2_000) {
        // still thick air: don't stray far from prograde
        const pv = _tmp.copy(v.surfaceVelocity).normalize();
        const ang = Math.acos(clamp(pv.dot(this.target), -1, 1));
        const maxA = 6 * DEG;
        if (ang > maxA) this.target.lerpVectors(pv, this.target, maxA / ang).normalize();
      }
      // Terminal guidance: ease off as we approach circular speed
      const dvLeft = vCirc - vH;
      if (aT > 0 && dvLeft < aT * 3) throttle = Math.min(throttle, clamp(dvLeft / (aT * 3), 0.04, 1));
    }
    this.hasTarget = true;
    v.controls.throttle = throttle;
    // Nothing left to burn and no later stage brings an engine with propellant
    // (a parachute stage does not count): give up rather than "burn" forever
    if (thrustAvail <= 0 && !v.hasEngineInLaterStage()) {
      this.disengage('Autopilot: out of propellant before orbit');
      v.controls.throttle = 0;
    }
  }

  // ---------------------------------------------------------------------------
  private updateNode(sim: FlightSim, v: Vessel, dt: number): void {
    const n = sim.nodes[0];
    if (!n) {
      this.disengage('No maneuver node');
      v.controls.throttle = 0;
      return;
    }
    this.tryAutoStage(sim, v, dt);
    const rem = n.remaining.length();
    const burn = estimateBurnTime(v, rem);
    // Centre the burn on its Δv, not its duration: the rocket gets lighter as it
    // burns, so the second half of the Δv takes less time than the first. Starting
    // when half the Δv still lies before the node keeps long burns (TLI, TMI)
    // pointed where the impulsive plan intended.
    const lead = estimateBurnTime(v, rem / 2);
    const tTo = n.time - sim.time;
    if (rem > 1e-3) {
      this.target.copy(n.remaining).normalize();
      this.hasTarget = true;
    }
    const err = sim.attitude.error;
    const thrust = this.availableThrust(v);
    const aT = thrust / v.mass;
    if (thrust <= 0 && !v.hasEngineInLaterStage() && (n.burning || tTo <= 0)) {
      // Ran dry mid-burn with nothing left to stage: stop instead of waiting forever
      v.controls.throttle = 0;
      this.disengage(`Maneuver aborted — out of propellant, ${rem.toFixed(0)} m/s short`);
      return;
    }
    let throttle = 0;
    if (isFinite(lead) && tTo <= lead + 0.05) {
      if (err < 4 * DEG || (n.burning && err < 15 * DEG)) {
        throttle = aT > 0 ? clamp(rem / (aT * 1.2), 0.02, 1) : 1;
        this.phase = `Burning — ${rem.toFixed(1)} m/s left`;
      } else {
        this.phase = 'Aligning';
      }
    } else {
      this.phase = `Waiting — burn in ${Math.max(0, tTo - (isFinite(lead) ? lead : 0)).toFixed(0)} s`;
    }
    let minT = 1;
    for (const p of v.parts) if (p.isEngine && p.engineIgnited && p.def.engine) minT = Math.min(minT, p.def.engine.minThrottle);
    if (throttle > 0 && throttle < minT && rem < 0.4) throttle = 0;
    if (n.burning && (rem < 0.08 || (throttle === 0 && rem < 0.5 && tTo < -burn))) {
      v.controls.throttle = 0;
      sim.removeNode(n);
      this.disengage('Maneuver complete');
      return;
    }
    v.controls.throttle = throttle;
  }

  // ---------------------------------------------------------------------------
  /**
   * Forward-simulate a full-thrust retrograde (gravity-turn) burn from the current
   * state (1 s steps, mass loss, centrifugal relief). The ground track is followed
   * across the curved, cratered surface so the result is the smallest CLEARANCE
   * above the real terrain along the way (negative: we'd hit something).
   */
  private predictStop(v: Vessel, h: number, vs: number, vh: number, r: number, g: number, throttle = 1): { clear: number; lead: number } {
    let thrust = 0;
    let mdot = 0;
    for (const p of v.parts) {
      if (!p.isEngine || !p.engineIgnited || p.def.engine === undefined) continue;
      if (p.flameout && p.ignitionsLeft <= 0) continue;
      thrust += p.stats.thrustVac;
      mdot += p.stats.thrustVac / (p.stats.ispVac * G0);
    }
    // No usable engine: nothing to predict (the caller must not treat this as "late")
    if (thrust <= 0) return { clear: Infinity, lead: 0 };
    thrust *= throttle;
    mdot *= throttle;
    const body = v.body;
    const terrain = body.terrain;
    const ground0 = v.altitude - h; // terrain height under us now
    const R = body.radius;
    // Unit vectors: straight up now, and the horizontal direction of travel (body-fixed)
    _sUp.copy(v.r).normalize().applyQuaternion(body.rotationInverse);
    _sE.copy(v.surfaceVelocity).addScaledVector(_up, -v.surfaceVelocity.dot(_up)).normalize().applyQuaternion(body.rotationInverse);
    let y = h; // altitude above ground0
    let x = 0;
    let vx = vh;
    let vy = vs;
    let m = v.mass;
    // Propellant runs out: the burn can't continue below the dry mass
    let fuel = 0;
    for (const p of v.parts) if (!p.isSolid) fuel += p.fuel;
    const mDry = Math.max(v.mass * 0.05, v.mass - fuel);
    let minClear = Infinity;
    let sample = 0;
    let t = 0;
    for (let i = 0; i < 4000 && t < 3000; i++) {
      const sp = Math.hypot(vx, vy);
      if (t >= sample || sp < 4) {
        sample = t + 10;
        let ground = ground0;
        if (terrain) {
          const ang = x / (R + ground0);
          _sDir.copy(_sUp).multiplyScalar(Math.cos(ang)).addScaledVector(_sE, Math.sin(ang));
          ground = terrain.heightAt(_sDir);
        }
        minClear = Math.min(minClear, y + ground0 - ground);
      }
      if (sp < 4) return { clear: minClear, lead: 0 };
      const a = m > mDry ? thrust / m : 0;
      // Adaptive step: never let one step reverse the velocity
      const dt = clamp((0.25 * sp) / Math.max(a, 1e-3), 0.05, 1);
      vx -= ((a * vx) / sp) * dt;
      vy += (-(a * vy) / sp - (g - (vx * vx) / Math.max(R * 0.5, r - h + y))) * dt;
      y += vy * dt;
      x += vx * dt;
      if (a > 0) m = Math.max(mDry, m - mdot * dt);
      t += dt;
      if (y + ground0 < -2_000) break;
    }
    return { clear: Math.min(minClear, y), lead: 0 };
  }

  private updateLand(sim: FlightSim, v: Vessel, dt: number): void {
    this.localFrame(v);
    const body = v.body;
    const r = v.r.length();
    const g = body.mu / (r * r);
    const thrust = this.availableThrust(v);
    const aMax = thrust / v.mass;
    const h = Math.max(0, v.radarAltitude);
    const vs = v.surfaceVelocity.dot(_up);
    const vh = _tmp.copy(v.surfaceVelocity).addScaledVector(_up, -vs);
    const vhMag = vh.length();
    const speed = v.surfaceVelocity.length();
    if (v.situation === 'prelaunch') {
      this.disengage('Landing autopilot: launch first');
      return;
    }
    if (v.situation === 'landed' || v.situation === 'splashed' || (v.touchingGround && speed < 0.6)) {
      v.controls.throttle = 0;
      this.disengage('Touchdown — autopilot off');
      v.controls.sasMode = 'stability';
      return;
    }
    if (aMax <= g * 1.05) this.phase = 'Insufficient thrust to land!';
    this.tryAutoStage(sim, v, dt);

    // 1. De-orbit: lower the periapsis to ~5 km above the highest terrain (the
    //    classic "descent orbit insertion"), then coast down to it. With an
    //    atmosphere (Mars) the periapsis goes well inside it instead, so drag and
    //    the braking burn below can finish the job — an orbit that never dips into
    //    the air would leave the autopilot "coasting, braking soon" forever.
    const hiTerrain = body.terrain ? body.terrain.maxHeight : 0;
    const o = sim.predictor.count > 0 ? sim.predictor.patches[0]!.orbit : null;
    if (o && o.isElliptic && !this.braking && vhMag > 30) {
      const peGoal = body.atmosphere ? body.radius + Math.max(hiTerrain + 5_000, body.atmosphere.ceiling * 0.35) : body.radius + hiTerrain + 5_000;
      if (o.periapsis > peGoal + 3_000) {
        this.phase = 'Descent orbit insertion';
        this.target.copy(v.v).normalize().negate();
        this.hasTarget = true;
        const aligned = sim.attitude.error < 6 * DEG;
        v.controls.throttle = aligned ? clamp((o.periapsis - peGoal) / 20_000, 0.05, 1) : 0;
        return;
      }
    }

    // 2. Braking: a "gravity-turn" suicide burn — full thrust against the surface
    //    velocity. We simulate that burn forward from the current state (a few
    //    hundred 1 s steps, including mass loss) and light the engines when the
    //    predicted altitude at standstill drops to ~1.2 km. Braking later wastes
    //    less propellant fighting gravity; braking too late means a crater.
    if (vhMag > 2 && (h > 300 || vhMag > 40)) {
      const margin = 1_800;
      this.brakeTimer -= dt;
      if (this.brakeTimer <= 0) {
        // Re-plan ~6× per second: full-thrust stop point, then the lowest throttle
        // that still stops at the margin (bisection on the forward simulation).
        this.brakeTimer = 0.15;
        const full = this.predictStop(v, h, vs, vhMag, r, g, 1).clear;
        this.brakeLate = full < margin * 0.6;
        if (!this.braking && full < margin) this.braking = true;
        if (this.braking && full > margin * 6 && h > 30_000) this.braking = false;
        let t = 1;
        if (this.braking && full > margin) {
          let lo = 0.25;
          let hi = 1;
          if (this.predictStop(v, h, vs, vhMag, r, g, lo).clear > margin) t = lo;
          else {
            for (let i = 0; i < 6; i++) {
              const mid = (lo + hi) / 2;
              if (this.predictStop(v, h, vs, vhMag, r, g, mid).clear > margin) hi = mid;
              else lo = mid;
            }
            t = hi;
          }
        }
        this.brakeThrottle = t;
      }
      this.target.copy(v.surfaceVelocity).normalize().negate();
      if (!this.braking) {
        this.hasTarget = true;
        v.controls.throttle = 0;
        this.phase = `Coasting — ${(v.altitude / 1000).toFixed(1)} km, braking soon`;
        return;
      }
      // Running late: lean up so the burn also arrests the fall
      if (this.brakeLate) this.target.addScaledVector(_up, 0.6).normalize();
      this.hasTarget = true;
      const aligned = sim.attitude.error < 10 * DEG;
      v.controls.throttle = aligned ? this.brakeThrottle : 0.02;
      this.phase = `Braking — ${vhMag.toFixed(0)} m/s horizontal`;
      return;
    }
    this.braking = true;

    // 3. Terminal descent: vertical speed follows the stopping curve
    //    v_ref(h) = −√(2·a·h) (constant deceleration a) down to ~1 m/s at the
    //    surface. Feed-forward supplies the curve's own deceleration (g + a when on
    //    it) and a proportional term corrects errors — without the feed-forward the
    //    controller lags behind the curve and arrives too fast.
    const aUse = Math.max(0.3, aMax * 0.72 - g);
    const curve = (alt: number) => -(Math.sqrt(2 * aUse * Math.max(0, alt - 1.5)) + 1.0);
    // Lean against any sideways drift (≈6° per m/s), gentler right above the ground
    const tilt = clamp(vhMag * 0.1 + 0.5 * Math.atan2(vhMag, Math.max(3, Math.abs(vs))), 0, h < 30 ? 10 * DEG : 30 * DEG);
    if (vhMag > 0.3) {
      _dir.copy(vh).multiplyScalar(-1 / vhMag);
      this.target.copy(_up).multiplyScalar(Math.cos(tilt)).addScaledVector(_dir, Math.sin(tilt)).normalize();
    } else {
      this.target.copy(_up);
    }
    this.hasTarget = true;
    const cosT = Math.max(0.2, this.target.dot(_up));
    // Engines take a moment to spool: steer on the vertical speed expected ~0.35 s
    // from now (given the thrust we already have) to avoid a bounce near the ground.
    const aNow = v.totalThrust / v.mass;
    const lag = 0.35;
    const vsSoon = vs + (aNow * Math.max(0, _nose.set(0, 1, 0).applyQuaternion(v.q).dot(_up)) - g) * lag;
    const vRefSoon = curve(Math.max(0, h + vs * lag));
    const onCurve = vRefSoon < -1.5 ? clamp(vsSoon / vRefSoon, 0, 1.5) : 1;
    const gain = h < 20 ? 0.9 : 1.6;
    const aNeed = g + aUse * onCurve + gain * (vRefSoon - vsSoon);
    let throttle = clamp(aNeed / (aMax * cosT), 0, 1);
    // "Contact": a light lander may not be able to throttle below its weight, so
    // it would hover. Like Apollo, cut the engine for the last metre or two.
    if (h < 2.5 && vs > -2.5 && vhMag < 1.5) throttle = 0;
    this.phase = throttle > 0.02 ? (h < 40 ? 'Final descent' : 'Powered descent') : h < 2.5 ? 'Engine stop — contact' : `Falling — ${h.toFixed(0)} m`;
    // legs out for the last kilometre
    if (h < 1_000) for (const p of v.parts) if (p.def.legs) p.legsDeployed = true;
    v.controls.throttle = throttle;
  }
}
