/**
 * LEARNING NOTE: Forces on a rocket, one step at a time
 *
 * Every 1/60 s we add up everything pushing on the vessel:
 *
 *  THRUST   F = ṁ · Isp(p) · g0. Mass flow ṁ is fixed by the throttle; ambient
 *           pressure p lowers effective Isp (and thrust) at sea level. Engines
 *           gimbal (tilt) a few degrees to steer: torque = lever arm × force.
 *  DRAG     Axial: ½ρv²·Cd·A for every exposed face — flat tops are terrible
 *           (Cd≈0.9), ogive noses are good (Cd≈0.2). Normal: slender-body theory
 *           gives a tapered nose a lift slope of 2 per radian (destabilising),
 *           cylinders feel crossflow drag, fins produce lift behind the centre of
 *           mass (stabilising). Transonic flow roughly doubles drag near Mach 1.
 *  HEATING  Sutton–Graves stagnation heat flux q̇ = k·√(ρ/Rₙ)·v³. Ablators boil
 *           away to carry heat off; other skins heat up and radiate (σT⁴).
 *  CONTACT  Terrain & water push back through springs/dampers at contact points,
 *           with Coulomb friction; landing legs are softer and tougher.
 *  GRAVITY  −μr/|r|³, integrated with velocity-Verlet (symplectic, 2nd order)
 *           so orbits don't slowly gain energy.
 *
 * Rotation follows Euler's rigid-body equation I·ω̇ = τ − ω×(Iω) in the vessel frame.
 *
 * Key concepts: specific impulse, dynamic pressure, centre of pressure vs. centre
 * of mass (static stability), stagnation heating, spring–damper contacts,
 * velocity-Verlet integration, quaternion integration
 */
import { Quaternion, Vector3 } from 'three';
import {
  ABLATOR_HEAT_OF_ABLATION,
  AERO_BREAKUP_LOAD,
  AMBIENT_TEMPERATURE_SPACE,
  CONTACT_DAMPING_RATIO,
  CONTACT_FRICTION,
  CONTACT_STATIC_SAG,
  CROSSFLOW_CD,
  DEFAULT_ENGINE_SPOOL,
  FIN_LIFT_SLOPE,
  FIN_STALL_ANGLE,
  G0,
  SKIN_EMISSIVITY,
  SKIN_MASS_FRACTION,
  STEFAN_BOLTZMANN,
  STRUCTURE_HEAT_CAPACITY,
  SUTTON_GRAVES_K,
} from '../core/constants';
import { clamp } from '../core/math';
import { createAtmosphereSample } from '../physics/Atmosphere';
import type { WindField } from '../physics/Wind';
import type { FlightPart } from './FlightPart';
import type { Vessel } from './Vessel';

export type FlightEventKind =
  | 'stage'
  | 'ignition'
  | 'flameout'
  | 'no-ignitions'
  | 'crash'
  | 'part-destroyed'
  | 'overheat'
  | 'breakup'
  | 'chute-semi'
  | 'chute-full'
  | 'chute-cut'
  | 'chute-torn'
  | 'touchdown'
  | 'splashdown'
  | 'landed'
  | 'liftoff'
  | 'soi-change'
  | 'fairing'
  | 'decouple'
  | 'docked'
  | 'undocked'
  | 'switch'
  | 'vessel-destroyed';

export interface FlightEvent {
  kind: FlightEventKind;
  vessel: Vessel;
  part?: FlightPart;
  message: string;
  /** Impact speed for crashes (m/s). */
  speed?: number;
  time: number;
}

/** Destruction requests collected during a step and applied afterwards. */
export interface DestroyRequest {
  vessel: Vessel;
  part: FlightPart;
  reason: 'crash' | 'overheat' | 'breakup' | 'torn';
  speed: number;
}

/** Commanded control vector: x = pitch, y = roll, z = −yaw (vessel-frame torque axes). */
export interface ControlCommand {
  x: number;
  y: number;
  z: number;
}

const _up = new Vector3();
const _vAir = new Vector3();
const _vAirL = new Vector3();
const _F = new Vector3();
const _T = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _tmp3 = new Vector3();
const _p = new Vector3();
const _vp = new Vector3();
const _n = new Vector3();
const _qInv = new Quaternion();
const _dq = new Quaternion();
const _omegaBody = new Vector3();
const _Iw = new Vector3();
const _grav = new Vector3();
const _aNG = new Vector3();
const _ground = new Vector3();
const _dirBF = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _rL = new Vector3();
const _nL = new Vector3();
const _tL = new Vector3();
const _rx = new Vector3();
const _Ir = new Vector3();

function machFactor(m: number): number {
  if (m < 0.8) return 1;
  if (m < 1.05) {
    const t = (m - 0.8) / 0.25;
    return 1 + 0.85 * t * t * (3 - 2 * t);
  }
  if (m < 1.6) return 1.85 - ((m - 1.05) / 0.55) * 0.35;
  if (m < 4) return 1.5 - ((m - 1.6) / 2.4) * 0.35;
  return Math.max(1.0, 1.15 - (m - 4) * 0.02);
}

export class VesselPhysics {
  private readonly atm = createAtmosphereSample();
  readonly events: FlightEvent[] = [];
  readonly destroyQueue: DestroyRequest[] = [];
  time = 0;
  /** This flight's weather (null = still air). */
  wind: WindField | null = null;

  /** Force & torque (vessel frame) accumulators. */
  private readonly force = new Vector3();
  private readonly torque = new Vector3();
  private nonGravForce = false;

  emit(kind: FlightEventKind, vessel: Vessel, message: string, part?: FlightPart, speed?: number): void {
    this.events.push({ kind, vessel, part, message, speed, time: this.time });
  }

  /** Environment/telemetry update without integrating (also used for pinned vessels). */
  updateEnvironment(v: Vessel): void {
    const body = v.body;
    const rMag = v.r.length();
    _up.copy(v.r).multiplyScalar(1 / rMag);
    v.altitude = rMag - body.radius;
    v.terrainHeight = body.terrain ? body.terrainHeightAtInertial(v.r) : 0;
    const water = body.terrain ? body.isWaterAtInertial(v.r) : false;
    const ground = water ? Math.max(0, v.terrainHeight) : v.terrainHeight;
    // Radar altitude measured to the lowest point of the vessel (approx along "up")
    let lowest = Infinity;
    for (const c of v.contactPoints) {
      v.localToBody(c.pos, _p);
      const d = _p.dot(_up) - rMag;
      if (d < lowest) lowest = d;
    }
    if (!isFinite(lowest)) lowest = 0;
    v.radarAltitude = v.altitude - ground + lowest;

    body.surfaceVelocity(v.r, _tmp);
    v.surfaceVelocity.copy(v.v).sub(_tmp);
    v.verticalSpeed = v.v.dot(_up);
    const vs = v.surfaceVelocity.dot(_up);
    v.horizontalSpeed = Math.sqrt(Math.max(0, v.surfaceVelocity.lengthSq() - vs * vs));

    // Wind: aerodynamics see the velocity relative to the moving air
    v.wind.set(0, 0, 0);
    if (this.wind && body.atmosphere) {
      _east.set(0, 1, 0).applyQuaternion(body.rotation).cross(_up);
      if (_east.lengthSq() > 1e-10) {
        _east.normalize();
        _north.crossVectors(_up, _east);
        this.wind.sample(body.id, v.altitude, this.time, _east, _north, v.wind);
      }
    }
    v.airVelocity.copy(v.surfaceVelocity).sub(v.wind);

    if (body.atmosphere && v.altitude < 1_000_000) {
      body.atmosphere.sample(v.altitude, this.atm);
      v.airDensity = this.atm.density;
      v.staticPressure = this.atm.pressure;
      const spd = v.airVelocity.length();
      v.dynamicPressure = 0.5 * this.atm.density * spd * spd;
      v.mach = spd / this.atm.speedOfSound;
      v.inAtmosphere = v.altitude < body.atmosphere.ceiling;
    } else {
      v.airDensity = 0;
      v.staticPressure = 0;
      v.dynamicPressure = 0;
      v.mach = 0;
      v.inAtmosphere = false;
    }
    // Angle of attack (to the airflow)
    const spd = v.airVelocity.length();
    if (spd > 1) {
      v.forward(_tmp);
      v.angleOfAttack = Math.acos(clamp(_tmp.dot(v.airVelocity) / spd, -1, 1));
    } else {
      v.angleOfAttack = 0;
    }
    v.maxAltitude = Math.max(v.maxAltitude, v.altitude);
  }

  /**
   * Advance one vessel by dt. `cmd` is the attitude command (already mixed from
   * pilot input and SAS). Returns true if non-gravitational forces acted.
   */
  step(v: Vessel, dt: number, cmd: ControlCommand): boolean {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    this.nonGravForce = false;
    this.updateEnvironment(v);
    _qInv.copy(v.q).invert();

    this.updateMechanisms(v, dt);
    this.applyEngines(v, dt, cmd);
    this.applyRcs(v, dt, cmd);
    this.applyControlTorque(v, cmd);
    if (v.airDensity > 1e-12) this.applyAero(v);
    else for (const p of v.parts) p.heatFlux = 0;
    this.applyThermal(v, dt);
    this.applyContacts(v, dt);

    // Fuel was consumed: recompute mass properties before integrating
    v.computeMassProperties(true);
    this.integrate(v, dt);
    v.age += dt;
    return this.nonGravForce;
  }

  // ---------------------------------------------------------------------------
  private updateMechanisms(v: Vessel, dt: number): void {
    let legsMoving = false;
    for (const p of v.parts) {
      if (p.def.legs) {
        const target = p.legsDeployed ? 1 : 0;
        if (p.legDeploy !== target) {
          p.legDeploy = clamp(p.legDeploy + Math.sign(target - p.legDeploy) * dt * 0.5, 0, 1);
          legsMoving = true;
        }
      }
      if (p.def.shape === 'solar') {
        const target = v.altitude > (v.body.atmosphere ? v.body.atmosphere.ceiling : 0) && v.situation !== 'prelaunch' ? 1 : 0;
        p.solarDeploy = clamp(p.solarDeploy + Math.sign(target - p.solarDeploy) * dt * 0.25, 0, 1);
      }
      const chute = p.def.parachute;
      if (chute && p.chuteState !== 'stowed' && p.chuteState !== 'cut') {
        const q = v.dynamicPressure;
        if (p.chuteState === 'armed') {
          // The semi-deploy pressure is specified for Earth; on a thin-air world
          // (Mars: 610 Pa at the datum) the same fraction of the surface pressure
          // marks "deep enough in the atmosphere" — otherwise no chute could ever
          // open there.
          const atm = v.body.atmosphere;
          const semi = chute.semiPressure * (atm ? Math.min(1, atm.seaLevelPressure / 101_325) : 1);
          if (atm && v.staticPressure > semi && v.airVelocity.length() > 1) {
            if (q > chute.maxQ * 1.6) {
              p.chuteState = 'cut';
              this.emit('chute-torn', v, `${p.def.name} shredded — too fast to deploy`, p);
            } else {
              p.chuteState = 'semi';
              this.emit('chute-semi', v, `${p.def.name} semi-deployed`, p);
            }
          }
        } else if (p.chuteState === 'semi') {
          p.chuteDeploy = Math.min(1, p.chuteDeploy + dt * 0.8);
          if (v.radarAltitude < chute.deployAltitude) {
            p.chuteState = 'full';
            p.chuteDeploy = 0.07;
            this.emit('chute-full', v, `${p.def.name} fully deployed`, p);
          }
        } else if (p.chuteState === 'full') {
          p.chuteDeploy = Math.min(1, p.chuteDeploy + dt * 0.35);
          if (q > chute.maxQ * (0.4 + p.chuteDeploy)) {
            p.chuteState = 'cut';
            this.emit('chute-torn', v, `${p.def.name} ripped apart (dynamic pressure ${(q / 1000).toFixed(1)} kPa)`, p);
          }
          if (chute.drogue && v.parts.some((o) => o.def.parachute && !o.def.parachute.drogue && o.chuteState === 'full' && o.chuteDeploy > 0.6)) {
            p.chuteState = 'cut';
            this.emit('chute-cut', v, 'Drogue released', p);
          }
          if ((v.situation === 'landed' || v.situation === 'splashed') && v.settledTime > 1.5) {
            p.chuteState = 'cut';
          }
        }
      }
    }
    if (legsMoving) v.updateLegContacts();
  }

  // ---------------------------------------------------------------------------
  private drawFuel(v: Vessel, p: FlightPart, amount: number): number {
    if (p.isSolid) {
      const got = Math.min(amount, p.fuel);
      p.fuel -= got;
      return got;
    }
    const prop = p.def.engine!.propellant;
    let total = 0;
    for (const t of v.parts) {
      if (t.group === p.group && t.propellant === prop && !t.isSolid) total += t.fuel;
    }
    if (total <= 0) return 0;
    const got = Math.min(amount, total);
    const k = got / total;
    for (const t of v.parts) {
      if (t.group === p.group && t.propellant === prop && !t.isSolid) t.fuel = Math.max(0, t.fuel - t.fuel * k);
    }
    return got;
  }

  private fuelAvailable(v: Vessel, p: FlightPart): number {
    return v.engineFuel(p);
  }

  private applyEngines(v: Vessel, dt: number, cmd: ControlCommand): void {
    const pAtm = v.staticPressure;
    // Sea-level Isp in the catalogue is measured at Earth's 101,325 Pa; the
    // back-pressure loss scales with the actual ambient pressure — on Mars
    // (610 Pa) it is under 1 % of the Earth loss, not the full loss.
    const pSL = 101_325;
    let total = 0;
    let maxNow = 0;
    const com = v.com;
    for (const p of v.parts) {
      if (!p.isEngine) continue;
      if (!p.engineIgnited) {
        p.thrust = 0;
        p.massFlow = 0;
        p.engineThrottle = 0;
        continue;
      }
      const e = p.def.engine;
      const minThrottle = e ? e.minThrottle : 1;
      let target: number;
      if (p.isSolid) {
        target = p.fuel > 0 ? 1 : 0;
        p.engineRunning = p.fuel > 0;
      } else {
        const c = v.controls.throttle;
        target = c > 0.001 ? Math.max(c, minThrottle) : 0;
        if (target > 0 && !p.engineRunning) {
          if (p.ignitionsLeft > 0 && this.fuelAvailable(v, p) > 0) {
            p.ignitionsLeft--;
            p.engineRunning = true;
            p.flameout = false;
            this.emit('ignition', v, `${p.def.name} ignition`, p);
          } else if (p.ignitionsLeft <= 0 && !p.flameout) {
            p.flameout = true;
            this.emit('no-ignitions', v, `${p.def.name}: no ignitions remaining`, p);
          }
        } else if (target === 0 && p.engineRunning) {
          p.engineRunning = false;
        }
        if (!p.engineRunning) target = 0;
      }
      const spool = e ? e.spool : 0.25;
      const k = 1 - Math.exp(-dt / Math.max(0.05, spool || DEFAULT_ENGINE_SPOOL));
      // Shut-down is faster than spool-up
      p.engineThrottle += (target - p.engineThrottle) * (target < p.engineThrottle ? Math.min(1, k * 3) : k);
      if (p.engineThrottle < 1e-4) p.engineThrottle = 0;

      const thrustVacMax = p.stats.thrustVac; // already includes cluster & limit
      const ispVac = p.stats.ispVac;
      const ispSL = p.stats.ispSL;
      const mdotMax = thrustVacMax / (ispVac * G0);
      const mdot = mdotMax * p.engineThrottle;
      if (p.engineRunning || (p.isSolid && p.fuel > 0)) maxNow += thrustVacMax;
      if (mdot <= 0) {
        p.thrust = 0;
        p.massFlow = 0;
        continue;
      }
      const want = mdot * dt;
      const got = this.drawFuel(v, p, want);
      const frac = want > 0 ? got / want : 0;
      if (got < want * 0.999) {
        if (!p.flameout) {
          p.flameout = true;
          this.emit('flameout', v, `${p.def.name} flameout — propellant depleted`, p);
        }
        p.engineRunning = false;
      }
      const isp = Math.max(ispVac * 0.08, ispVac - (ispVac - ispSL) * (pAtm / pSL));
      const thrust = mdot * frac * isp * G0;
      p.thrust = thrust;
      p.massFlow = mdot * frac;
      total += thrust;

      // Gimbal: deflection in the vessel frame from the control command
      const gMax = e ? e.gimbal : p.def.solid ? p.def.solid.gimbal : 0;
      const tanMax = Math.tan(gMax);
      // Application point: top of engine (gimbal pivot) for liquids, centre for solids
      _p.set(0, p.isSolid ? 0 : p.height / 2, 0).applyQuaternion(p.rotation).add(p.position);
      const dx = _p.x - com.x;
      const dy = _p.y - com.y;
      const dz = _p.z - com.z;
      let gx = 0;
      let gz = 0;
      if (tanMax > 0) {
        // τ = d × F with F = T·(gx, 1, gz): τx ∝ dy·gz, τz ∝ −dy·gx, τy ∝ dz·gx − dx·gz
        const sgn = dy < 0 ? -1 : 1;
        gz = cmd.x * tanMax * sgn;
        gx = -cmd.z * tanMax * sgn;
        const rho = Math.hypot(dx, dz);
        if (rho > 0.3) {
          gx += (cmd.y * tanMax * dz) / rho;
          gz += (-cmd.y * tanMax * dx) / rho;
        }
        const mag = Math.hypot(gx, gz);
        if (mag > tanMax) {
          gx *= tanMax / mag;
          gz *= tanMax / mag;
        }
      }
      const kg = 1 - Math.exp(-dt / 0.08);
      p.gimbalX += (gx - p.gimbalX) * kg;
      p.gimbalZ += (gz - p.gimbalZ) * kg;
      // Thrust direction (vessel frame)
      _F.set(p.gimbalX, 1, p.gimbalZ).normalize().multiplyScalar(thrust);
      this.force.add(_F);
      _tmp.set(dx, dy, dz);
      _T.crossVectors(_tmp, _F);
      this.torque.add(_T);
      this.nonGravForce = true;
    }
    v.totalThrust = total;
    v.maxThrustNow = maxNow;
  }

  /**
   * Reaction-control thrusters: small hydrazine jets that translate the vessel
   * (the tool for docking) and add attitude torque. Each quad carries its own
   * propellant; the demand is the translation input plus half the attitude
   * command, and all armed quads share the flow evenly.
   */
  private applyRcs(v: Vessel, dt: number, cmd: ControlCommand): void {
    v.rcsActive = false;
    const c = v.controls;
    if (!c.rcs) return;
    let thrust = 0;
    let isp = 240;
    let quads = 0;
    for (const p of v.parts) {
      const r = p.def.rcs;
      if (!r || p.destroyed || p.fuel <= 0) continue;
      thrust += r.thrust;
      isp = r.isp;
      quads++;
    }
    if (thrust <= 0) return;
    const tx = clamp(c.tx, -1, 1);
    const ty = clamp(c.ty, -1, 1);
    const tz = clamp(c.tz, -1, 1);
    const tmag = Math.hypot(tx, ty, tz);
    if (tmag > 1e-3) {
      const s = (thrust * Math.min(1, tmag)) / tmag;
      this.force.x += tx * s;
      this.force.y += ty * s;
      this.force.z += tz * s;
      this.nonGravForce = true;
    }
    const lever = this.rcsTorque(v);
    this.torque.x += cmd.x * lever;
    this.torque.y += cmd.y * lever;
    this.torque.z += cmd.z * lever;
    const att = Math.min(1, Math.abs(cmd.x) + Math.abs(cmd.y) + Math.abs(cmd.z));
    const demand = Math.min(1, tmag) + att * 0.5;
    if (demand <= 0.01) return;
    v.rcsActive = true;
    const share = ((thrust * demand) / (isp * G0)) * dt / quads;
    for (const p of v.parts) if (p.def.rcs && !p.destroyed && p.fuel > 0) p.fuel = Math.max(0, p.fuel - share);
  }

  /** Attitude torque the armed, fuelled RCS quads can produce (N·m, per axis). */
  private rcsTorque(v: Vessel): number {
    if (!v.controls.rcs) return 0;
    let lever = 0;
    for (const p of v.parts) {
      const r = p.def.rcs;
      if (!r || p.destroyed || p.fuel <= 0) continue;
      _tmp.copy(p.position).sub(v.com);
      lever += r.thrust * 0.5 * Math.max(0.3, _tmp.length());
    }
    return lever;
  }

  private applyControlTorque(v: Vessel, cmd: ControlCommand): void {
    let tq = 0;
    for (const p of v.parts) if (p.stats.torque > 0 && !p.destroyed) tq += p.stats.torque;
    if (tq <= 0) return;
    this.torque.x += cmd.x * tq;
    this.torque.y += cmd.y * tq;
    this.torque.z += cmd.z * tq;
  }

  /** Max torque available per axis (N·m) — for the attitude controller. */
  controlAuthority(v: Vessel, out: Vector3): Vector3 {
    let rw = this.rcsTorque(v);
    for (const p of v.parts) rw += p.stats.torque;
    let pitchYaw = 0;
    let roll = 0;
    for (const p of v.parts) {
      if (!p.isEngine || p.thrust <= 0) continue;
      const e = p.def.engine;
      const gMax = e ? e.gimbal : p.def.solid ? p.def.solid.gimbal : 0;
      if (gMax <= 0) continue;
      const tanMax = Math.tan(gMax);
      _p.set(0, p.isSolid ? 0 : p.height / 2, 0).applyQuaternion(p.rotation).add(p.position).sub(v.com);
      pitchYaw += p.thrust * tanMax * Math.abs(_p.y);
      roll += p.thrust * tanMax * Math.hypot(_p.x, _p.z);
    }
    return out.set(rw + pitchYaw, rw + roll, rw + pitchYaw);
  }

  // ---------------------------------------------------------------------------
  private applyAero(v: Vessel): void {
    const rho = v.airDensity;
    _vAir.copy(v.airVelocity);
    _vAirL.copy(_vAir).applyQuaternion(_qInv);
    const speed = _vAirL.length();
    if (speed < 0.01) return;
    const mf = machFactor(v.mach);
    const com = v.com;
    const w = v.w;
    const vAx = _vAirL.y;
    const front: 1 | -1 = vAx >= 0 ? 1 : -1;
    const qAx = 0.5 * rho * vAx * vAx;
    const enginesFiring = v.totalThrust > 0;
    this.nonGravForce = true;

    // Axial faces
    for (const f of v.aeroFaces) {
      const isFront = f.facing === front;
      let cd = isFront ? f.frontCd : f.baseCd;
      if (!isFront && f.engineBase && enginesFiring) cd *= 0.25;
      const mag = qAx * f.area * cd * mf;
      _F.set(0, -front * mag, 0);
      this.addForceAt(_F, f.pos, com);
      // Nose lift (normal force) for tapered surfaces facing the flow
      if (isFront && f.liftArea > 0) {
        this.pointVelocity(f.pos, com, w, _vp);
        const ax = _vp.y;
        _n.set(_vp.x, 0, _vp.z);
        const vn = _n.length();
        if (vn > 1e-3) {
          const vtot = Math.hypot(vn, ax);
          const alpha = Math.atan2(vn, Math.abs(ax));
          const N = 0.5 * rho * vtot * vtot * f.liftArea * Math.sin(2 * Math.min(alpha, Math.PI / 4)) * mf;
          _F.copy(_n).multiplyScalar(-N / vn);
          this.addForceAt(_F, f.pos, com);
        }
      }
    }
    // Crossflow on bodies
    for (const b of v.aeroBody) {
      this.pointVelocity(b.pos, com, w, _vp);
      _n.set(_vp.x, 0, _vp.z);
      const vn = _n.length();
      if (vn < 1e-3) continue;
      const mag = 0.5 * rho * vn * vn * CROSSFLOW_CD * b.sideArea * Math.min(mf, 1.4);
      _F.copy(_n).multiplyScalar(-mag / vn);
      this.addForceAt(_F, b.pos, com);
    }
    // Fins
    for (const fin of v.aeroFins) {
      this.pointVelocity(fin.pos, com, w, _vp);
      const vt = _vp.length();
      if (vt < 0.1) continue;
      const vperp = _vp.dot(fin.normal);
      let a = Math.asin(clamp(vperp / vt, -1, 1));
      const aa = Math.abs(a);
      let eff: number;
      if (aa < FIN_STALL_ANGLE) eff = Math.sin(aa);
      else eff = Math.sin(FIN_STALL_ANGLE) * Math.max(0.4, 1 - (aa - FIN_STALL_ANGLE) * 0.8);
      a = Math.sign(a) * eff;
      const qf = 0.5 * rho * vt * vt;
      const lift = qf * fin.area * FIN_LIFT_SLOPE * a * Math.min(mf, 1.3);
      _F.copy(fin.normal).multiplyScalar(-lift);
      // fin drag
      _F.addScaledVector(_vp, (-qf * fin.area * 0.02 * mf) / vt);
      this.addForceAt(_F, fin.pos, com);
    }
    // Parachutes
    for (const p of v.parts) {
      const c = p.def.parachute;
      if (!c || (p.chuteState !== 'semi' && p.chuteState !== 'full')) continue;
      const canopies = p.config.canopies ?? 1;
      const full = Math.PI * (c.canopy / 2) ** 2 * canopies;
      const area = p.chuteState === 'semi' ? full * 0.05 * p.chuteDeploy : full * p.chuteDeploy;
      const mag = 0.5 * rho * speed * speed * c.cd * area;
      _F.copy(_vAirL).multiplyScalar(-mag / speed);
      _p.set(0, p.def.shape === 'parachute' ? p.height / 2 : 0, 0).applyQuaternion(p.rotation).add(p.position);
      this.addForceAt(_F, _p, com);
    }
    // Aerodynamic structural load (q · sin α) → break-up
    const aoa = v.angleOfAttack;
    const effA = Math.min(aoa, Math.PI - aoa);
    v.aeroLoad = v.dynamicPressure * Math.sin(effA);
    const hasChuteOut = v.parts.some((p) => p.chuteState === 'full' || p.chuteState === 'semi');
    const stack = v.parts.length > 2 && !hasChuteOut && v.length > 6;
    if (stack && v.aeroLoad > AERO_BREAKUP_LOAD && v.dynamicPressure > 12_000) {
      // Destroy the part farthest from the COM (the structure snaps)
      let worst: FlightPart | null = null;
      let wd = -1;
      for (const p of v.parts) {
        const d = p.position.distanceTo(com);
        if (d > wd && p !== v.root) {
          wd = d;
          worst = p;
        }
      }
      if (worst) this.destroyQueue.push({ vessel: v, part: worst, reason: 'breakup', speed: 0 });
    }
  }

  private pointVelocity(pos: Vector3, com: Vector3, w: Vector3, out: Vector3): Vector3 {
    _tmp3.copy(pos).sub(com);
    return out.crossVectors(w, _tmp3).add(_vAirL);
  }

  private addForceAt(F: Vector3, pos: Vector3, com: Vector3): void {
    this.force.add(F);
    _tmp2.copy(pos).sub(com);
    _T.crossVectors(_tmp2, F);
    this.torque.add(_T);
  }

  // ---------------------------------------------------------------------------
  private applyThermal(v: Vessel, dt: number): void {
    const speed = v.airVelocity.length();
    const rho = v.airDensity;
    const flux = rho > 1e-10 && speed > 600 ? SUTTON_GRAVES_K * Math.sqrt(rho / Math.max(0.5, v.refRadius)) * speed * speed * speed : 0;
    v.heatFlux = flux;
    const ambient = rho > 1e-6 ? 250 : AMBIENT_TEMPERATURE_SPACE;
    // Direction of motion in the vessel frame
    let sMax = -Infinity;
    if (flux > 0) {
      _tmp.copy(v.airVelocity).applyQuaternion(_qInv).normalize();
      for (const p of v.parts) {
        if (p.shielded) continue;
        const s = _tmp.dot(p.position) + p.radius * 0.2 + (p.height / 2) * Math.abs(_tmp.y);
        if (s > sMax) sMax = s;
      }
    }
    for (const p of v.parts) {
      let qin = 0;
      if (flux > 0 && !p.shielded) {
        const s = _tmp.dot(p.position) + p.radius * 0.2 + (p.height / 2) * Math.abs(_tmp.y);
        const lead = s >= sMax - Math.max(0.6, p.height * 0.6) ? 1 : 0.06;
        const area = Math.PI * p.radius * p.radius;
        qin = flux * area * lead;
        p.heatFlux = flux * lead;
        // Heat shield facing the flow (its bottom face forward) ablates instead of heating
        if (p.def.heatShield && lead === 1 && p.ablator > 0) {
          const facing = -_tmp.y; // motion along −Y → shield bottom leads
          if (facing > 0.5) {
            const used = Math.min(p.ablator, (qin * 0.97 * dt) / ABLATOR_HEAT_OF_ABLATION);
            p.ablator -= used;
            qin *= 0.03;
          }
        }
      } else {
        p.heatFlux = 0;
      }
      const skinMass = Math.max(5, p.mass * SKIN_MASS_FRACTION);
      const surf = Math.PI * 2 * p.radius * p.height + Math.PI * p.radius * p.radius;
      const rad = SKIN_EMISSIVITY * STEFAN_BOLTZMANN * (p.temperature ** 4 - ambient ** 4) * surf;
      p.temperature += ((qin - rad) * dt) / (skinMass * STRUCTURE_HEAT_CAPACITY);
      // Engines heat from firing
      if (p.isEngine && p.thrust > 0) p.temperature = Math.max(p.temperature, 700 + 600 * p.engineThrottle);
      if (p.temperature < ambient) p.temperature += (ambient - p.temperature) * Math.min(1, dt * 0.01);
      if (p.temperature > p.def.maxTemp) {
        this.destroyQueue.push({ vessel: v, part: p, reason: 'overheat', speed: 0 });
      }
    }
  }

  // ---------------------------------------------------------------------------
  private applyContacts(v: Vessel, dt: number): void {
    const body = v.body;
    v.touchingGround = false;
    v.inWater = false;
    if (v.radarAltitude > v.boundingRadius + 30 && v.situation !== 'prelaunch') {
      v.lastContactCount = 4;
      return;
    }
    const g = body.mu / v.r.lengthSq();
    const count = Math.max(3, v.lastContactCount);
    const kTotal = (v.mass * g) / CONTACT_STATIC_SAG;
    const kPt = kTotal / count;
    const mEff = v.mass / count;
    const cPt = 2 * CONTACT_DAMPING_RATIO * Math.sqrt(kPt * mEff);
    let contacts = 0;
    for (const c of v.contactPoints) {
      if (c.part.destroyed) continue;
      v.localToBody(c.pos, _p);
      const rp = _p.length();
      _dirBF.copy(_p).applyQuaternion(body.rotationInverse).multiplyScalar(1 / rp);
      const hT = body.terrain ? body.terrain.heightAt(_dirBF) : 0;
      const water = body.terrain ? body.terrain.isWater(_dirBF) : false;
      const surfaceR = body.radius + (water ? Math.max(0, hT) : hT);
      const pen = surfaceR - rp;
      if (pen <= 0) continue;
      contacts++;
      // Surface normal: terrain gradient when on land
      _n.copy(_p).multiplyScalar(1 / rp);
      if (body.terrain && !water) this.terrainNormal(body, _dirBF, hT, _n);
      // Point velocity relative to rotating ground (inertial frame)
      _tmp.copy(c.pos).sub(v.com);
      _vp.crossVectors(v.w, _tmp).applyQuaternion(v.q).add(v.v);
      body.surfaceVelocity(_p, _ground);
      _vp.sub(_ground);
      const vn = _vp.dot(_n);
      // Crash test on impact
      const tol = c.part.def.crashTolerance * (water ? 1.6 : 1) * (c.leg ? 1 : 1);
      if (-vn > tol && !c.part.destroyed) {
        this.destroyQueue.push({ vessel: v, part: c.part, reason: 'crash', speed: -vn });
      }
      // Explicit integration is only stable if a damping or friction force cannot
      // reverse the contact point's velocity within one step. A foot on a long leg
      // has a tiny effective mass in rotation (I/R²), so the nominal damper would
      // overshoot and pump energy into the rocking motion until the legs "crash".
      // Cap every velocity-proportional force at the impulse that just zeroes the
      // point's relative velocity, shared between the contacts of this step.
      _rL.copy(c.pos).sub(v.com);
      _nL.copy(_n).applyQuaternion(_qInv);
      const capN = this.contactForceCap(v, _rL, _nL, Math.abs(vn), dt, count);
      let fn: number;
      if (water) {
        v.inWater = true;
        const kw = kPt * 0.25;
        fn = kw * Math.min(pen, 4) + clamp(-cPt * 1.5 * vn, -capN, capN);
        // water drag
        _vp.addScaledVector(_n, -vn);
        const vt = _vp.length();
        let drag = mEff * 0.8 * vt;
        if (vt > 1e-6) {
          _tL.copy(_vp).multiplyScalar(1 / vt).applyQuaternion(_qInv);
          drag = Math.min(drag, this.contactForceCap(v, _rL, _tL, vt, dt, count));
          _F.copy(_vp).multiplyScalar(-drag / vt);
        } else _F.set(0, 0, 0);
      } else {
        v.touchingGround = true;
        const legK = c.leg ? 0.45 : 1;
        fn = kPt * legK * pen + clamp(-cPt * (c.leg ? 1.3 : 1) * vn, -capN, capN);
        _vp.addScaledVector(_n, -vn);
        const vt = _vp.length();
        // Coulomb friction, viscous below 0.25 m/s so a resting vehicle does not jitter
        let fric = (CONTACT_FRICTION * Math.max(0, fn) * vt) / Math.max(vt, 0.25);
        if (vt > 1e-6) {
          _tL.copy(_vp).multiplyScalar(1 / vt).applyQuaternion(_qInv);
          fric = Math.min(fric, this.contactForceCap(v, _rL, _tL, vt, dt, count));
          _F.copy(_vp).multiplyScalar(-fric / vt);
        } else _F.set(0, 0, 0);
      }
      if (fn < 0) fn = 0;
      _F.addScaledVector(_n, fn);
      // → vessel frame
      _F.applyQuaternion(_qInv);
      this.addForceAt(_F, c.pos, v.com);
      this.nonGravForce = true;
    }
    v.lastContactCount = Math.max(3, contacts);
  }

  /**
   * Largest velocity-proportional force a contact may apply along `dLocal`
   * (vessel frame) this step: the point's inverse effective mass along d is
   * K = 1/m + (r×d)·I⁻¹(r×d), so an impulse F·dt changes its speed by F·dt·K;
   * F ≤ speed/(dt·K) can at most cancel the relative motion, and dividing by the
   * number of contacts keeps their sum within that bound too.
   */
  private contactForceCap(v: Vessel, rLocal: Vector3, dLocal: Vector3, speed: number, dt: number, count: number): number {
    _rx.crossVectors(rLocal, dLocal);
    _Ir.copy(_rx).applyMatrix3(v.invInertia);
    const K = 1 / v.mass + _rx.dot(_Ir);
    return speed / (dt * K * count);
  }

  private terrainNormal(body: Vessel['body'], dirBF: Vector3, h0: number, out: Vector3): void {
    const R = body.radius;
    const step = 4 / R; // ~4 m
    // tangent basis in body-fixed frame
    _east.set(-dirBF.z, 0, dirBF.x);
    if (_east.lengthSq() < 1e-12) _east.set(1, 0, 0);
    _east.normalize();
    _north.crossVectors(dirBF, _east).normalize();
    _tmp.copy(dirBF).addScaledVector(_east, step).normalize();
    const he = body.terrain!.heightAt(_tmp);
    _tmp.copy(dirBF).addScaledVector(_north, step).normalize();
    const hn = body.terrain!.heightAt(_tmp);
    const se = (he - h0) / 4;
    const sn = (hn - h0) / 4;
    // normal in body-fixed frame
    _tmp.copy(dirBF).addScaledVector(_east, -se).addScaledVector(_north, -sn).normalize();
    out.copy(_tmp).applyQuaternion(body.rotation);
  }

  // ---------------------------------------------------------------------------
  private integrate(v: Vessel, dt: number): void {
    const mu = v.body.mu;
    // Non-gravitational acceleration (inertial)
    _aNG.copy(this.force).applyQuaternion(v.q).multiplyScalar(1 / v.mass);
    const r2 = v.r.lengthSq();
    _grav.copy(v.r).multiplyScalar(-mu / (r2 * Math.sqrt(r2)));
    v.v.addScaledVector(_grav, dt * 0.5).addScaledVector(_aNG, dt * 0.5);
    v.r.addScaledVector(v.v, dt);
    const r2n = v.r.lengthSq();
    _grav.copy(v.r).multiplyScalar(-mu / (r2n * Math.sqrt(r2n)));
    v.v.addScaledVector(_grav, dt * 0.5).addScaledVector(_aNG, dt * 0.5);

    v.acceleration.copy(_aNG);
    const gf = _aNG.length() / G0;
    v.gForce = v.gForce + (gf - v.gForce) * Math.min(1, dt * 8);
    if (v.situation !== 'prelaunch') v.maxG = Math.max(v.maxG, v.gForce);
    v.maxQ = Math.max(v.maxQ, v.dynamicPressure);
    v.maxSpeed = Math.max(v.maxSpeed, v.v.length());
    if (v.totalThrust > 0) v.dvExpended += (v.totalThrust / v.mass) * dt;

    // Rotation: I ω̇ = τ − ω × (I ω)
    _omegaBody.copy(v.w);
    _Iw.copy(_omegaBody).applyMatrix3(v.inertia);
    _tmp.crossVectors(_omegaBody, _Iw);
    _tmp.subVectors(this.torque, _tmp).applyMatrix3(v.invInertia);
    v.w.addScaledVector(_tmp, dt);
    // Clamp absurd spin rates (numerical safety)
    const wl = v.w.length();
    if (wl > 12) v.w.multiplyScalar(12 / wl);
    // q ← q ⊗ exp(ω dt / 2)
    const angle = v.w.length() * dt;
    if (angle > 1e-12) {
      _tmp.copy(v.w).normalize();
      _dq.setFromAxisAngle(_tmp, angle);
      v.q.multiply(_dq).normalize();
    }
  }
}
