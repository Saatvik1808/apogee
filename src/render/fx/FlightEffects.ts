/**
 * LEARNING NOTE: Visual effects driven by physics
 *
 * Every effect here is triggered by simulation state, not scripted animation:
 *  • Smoke density scales with air density and thrust — thick at the pad, thinning
 *    to nothing above ~60 km where there's no air to hold it.
 *  • At liftoff the exhaust hits the flame trench and water deluge: huge steam
 *    clouds billow sideways along the ground.
 *  • On the Moon, engine exhaust near the surface blasts regolith sideways.
 *  • Re-entry heat flux spawns glowing plasma streaming off the leading surfaces.
 *  • Destruction events spawn fire, smoke, sparks and (in air) a shock ring.
 *  • Ignition flashes, liftoff FROST (ice that formed on cryogenic tanks shakes
 *    off in the first seconds — the classic Saturn V / Falcon 9 sight), touchdown
 *    dust, splashdown spray, and the sparkle of unburnt propellant freezing into
 *    ice crystals when an engine shuts down in vacuum.
 *
 * To keep fast-moving trails continuous we treat the whole engine cluster as one
 * emitter and spawn evenly spaced puffs along the path it travelled since the last
 * puff — so the column has the same density at 50 m/s and at 1,500 m/s.
 *
 * Key concepts: event-driven FX, emission rates, interpolated spawning
 */
import { Color, PointLight, Vector3 } from 'three';
import type { FlightSim } from '../../sim/FlightSim';
import type { FlightEvent } from '../../sim/VesselPhysics';
import type { Vessel } from '../../sim/Vessel';
import type { PlumeStyle } from '../../parts/PartCatalog';
import { ParticleSystem, type SpawnSpec } from './Particles';
import type { VesselView } from '../vessel/VesselView';

const SMOKE_COLORS: Record<PlumeStyle, Color> = {
  kerolox: new Color(0.78, 0.76, 0.73),
  solid: new Color(0.93, 0.92, 0.9),
  hydrolox: new Color(0.95, 0.96, 0.98),
  methalox: new Color(0.86, 0.87, 0.89),
  hypergolic: new Color(0.75, 0.56, 0.42),
};

const _spec: SpawnSpec = {
  kind: 'smoke',
  pos: new Vector3(),
  vel: new Vector3(),
  life: 1,
  size0: 1,
  size1: 2,
  color: new Color(),
  alpha: 1,
  emissive: 0,
  drag: 0.5,
  buoyancy: 0,
  up: new Vector3(0, 1, 0),
};
const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _abs = new Vector3();
const _vAbs = new Vector3();
const _tmp = new Vector3();
const _cPos = new Vector3();
const _lightPos = new Vector3();
const _cDir = new Vector3();

const _ax = new Vector3();
const _pp = new Vector3();
const CRYO = new Set(['kerolox', 'hydrolox', 'methalox']);
const DUST_COLORS: Record<string, [number, number, number]> = { moon: [0.45, 0.44, 0.42], mars: [0.62, 0.38, 0.22], earth: [0.5, 0.42, 0.3] };

export class FlightEffects {
  readonly particles = new ParticleSystem();
  readonly engineLight = new PointLight(0xffaa66, 0, 0, 2);
  readonly flash = new PointLight(0xffaa55, 0, 0, 2);
  private readonly lastEmit = new Map<string, Vector3>();
  private flashTime = 0;
  /** Particle density from the quality settings (fewer, larger puffs when low). */
  density = 1;

  constructor() {
    this.engineLight.castShadow = false;
  }

  private rnd(a: number, b: number): number {
    return a + Math.random() * (b - a);
  }

  private jitter(out: Vector3, r: number): Vector3 {
    return out.set((Math.random() - 0.5) * 2 * r, (Math.random() - 0.5) * 2 * r, (Math.random() - 0.5) * 2 * r);
  }

  update(sim: FlightSim, views: Map<number, VesselView>, camAbs: Vector3, dt: number, realDt: number): void {
    const act = sim.active;
    this.particles.setFrame(act.body);
    let lightPower = 0;
    const lightPos = _lightPos.set(0, 0, 0);
    let lightCount = 0;
    for (const v of sim.vessels) {
      if (v.destroyed) continue;
      const view = views.get(v.id);
      if (!view) continue;
      this.emitEngines(v, view, camAbs, dt);
      this.shutdownIce(v, dt);
      if (v.heatFlux > 1.5e5 && v.airDensity > 0) this.emitPlasma(v, dt);
      if (v.airborneTime > 0 && v.airborneTime < 12 && v.body.atmosphere && v.situation === 'flying') this.emitFrost(v, view, camAbs, dt);
      if (v.body.id === 'earth' && v.mach > 0.9 && v.mach < 1.12 && v.airDensity > 0.12) this.emitVaporCone(v, dt);
      if (v === act) {
        view.forEachNozzle((pos, _dir, _radius, part) => {
          lightPower += part.thrust;
          lightPos.add(pos);
          lightCount++;
        });
      }
    }
    // Engine light at the base of the active vessel (lights pad & smoke at night)
    if (lightCount > 0) {
      lightPos.multiplyScalar(1 / lightCount);
      this.engineLight.position.copy(lightPos);
      // Roughly daylight-level illumination 50 m from a large booster; dominant at night
      this.engineLight.intensity = Math.min(6e5, Math.sqrt(lightPower) * 120);
    } else {
      this.engineLight.intensity = 0;
    }
    this.flashTime -= realDt;
    this.flash.intensity = this.flashTime > 0 ? this.flash.intensity * Math.exp(-realDt * 5) : 0;
  }

  private emitEngines(v: Vessel, view: VesselView, camAbs: Vector3, dt: number): void {
    const rho = v.airDensity;
    const body = v.body;
    const radar = v.radarAltitude;
    const hasAir = rho > 2e-5;
    const airless = !body.atmosphere;
    const key = String(v.id);
    if (!hasAir && !(airless && radar < 60)) {
      this.lastEmit.delete(key);
      return;
    }
    // The engine cluster as one emitter: thrust-weighted centre and direction,
    // equivalent radius from the total exit area, longest visible plume.
    let wsum = 0;
    let area = 0;
    let plumeLen = 0;
    let thrSum = 0;
    let best = 0;
    let style = 'kerolox' as PlumeStyle;
    _cPos.set(0, 0, 0);
    _cDir.set(0, 0, 0);
    view.forEachNozzle((pos, dir, radius, part, pl) => {
      const w = Math.max(1, part.thrust);
      _cPos.addScaledVector(pos, w);
      _cDir.addScaledVector(dir, w);
      wsum += w;
      area += radius * radius;
      plumeLen = Math.max(plumeLen, pl);
      thrSum += part.engineThrottle * w;
      if (part.thrust > best) {
        best = part.thrust;
        style = (part.def.engine ? part.def.engine.plume : 'solid') as PlumeStyle;
      }
    });
    if (wsum === 0) {
      this.lastEmit.delete(key);
      return;
    }
    _cPos.multiplyScalar(1 / wsum);
    _cDir.normalize();
    const thr = thrSum / wsum;
    const clusterR = Math.sqrt(area) * 1.15;
    _up.copy(v.r).normalize();
    // Absolute emission point, part-way down the plume
    _abs.copy(_cPos).addScaledVector(_cDir, Math.max(clusterR * 2, plumeLen * 0.6)).add(camAbs);
    let prev = this.lastEmit.get(key);
    if (!prev) {
      prev = _abs.clone();
      this.lastEmit.set(key, prev);
    }
    if (hasAir) {
      const dens = Math.min(1, rho / 0.25);
      const dq = this.density;
      // Fewer puffs at low density, each larger so the column stays continuous
      const size0 = (clusterR * 2.2 + 1.5) / Math.sqrt(dq);
      // Evenly spaced puffs along the path → a continuous column at any speed
      const spacing = Math.max(1.2, size0 * 0.45);
      const travel = prev.distanceTo(_abs);
      let count = Math.floor(travel / spacing);
      const minCount = Math.floor(15 * dq * dt + Math.random()); // hovering still smokes
      const cap = Math.ceil(260 * dq * dt);
      let endT = count > 0 ? (count * spacing) / Math.max(travel, 1e-6) : 0;
      if (count > cap) {
        count = cap;
        endT = 1;
      }
      if (count < minCount) {
        count = minCount;
        endT = 1;
      }
      const col = SMOKE_COLORS[style];
      // Smoke rides the air: ground velocity + wind, so plumes lean downwind
      body.surfaceVelocity(_tmp.copy(v.r), _vAbs).add(body.velocity).add(v.wind);
      const size1 = (26 + clusterR * 16) * (0.3 + 0.7 * dens) * (style === 'solid' ? 1.4 : 1);
      const alpha = (style === 'hydrolox' ? 0.22 : style === 'solid' ? 0.7 : 0.5) * (0.2 + 0.8 * dens);
      for (let i = 0; i < count; i++) {
        const t = ((i + 0.5) / count) * endT;
        _spec.kind = 'smoke';
        _spec.pos.lerpVectors(prev, _abs, t).add(this.jitter(_tmp, clusterR * 0.6));
        _spec.vel.copy(_vAbs).addScaledVector(_cDir, this.rnd(4, 20) * dens).add(this.jitter(_tmp, 2.5));
        _spec.life = this.rnd(20, 38) * (0.35 + 0.65 * dens);
        _spec.size0 = size0;
        _spec.size1 = size1 * this.rnd(0.8, 1.2);
        _spec.color.copy(col);
        _spec.alpha = alpha * (0.35 + 0.65 * thr);
        _spec.emissive = style === 'solid' || style === 'kerolox' ? 1.2 : 0.3;
        _spec.drag = 0.35;
        _spec.buoyancy = 0.5;
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
      if (count > 0) prev.lerp(_abs, endT);
      // Mars: the landing plume scours ochre dust off the ground
      if (body.id === 'mars' && radar < 45 && thr > 0.05) this.emitGroundDust(v, radar, clusterR, dt, 0.62, 0.38, 0.22, 0.45);
      // Launch steam: exhaust + deluge water hitting the trench
      if (radar < 150 && thr > 0.05) {
        const gRate = Math.min(90, (40 + 60 * clusterR) * (1 - radar / 150));
        const gc = Math.floor(gRate * dt) + (Math.random() < (gRate * dt) % 1 ? 1 : 0);
        _east.set(0, 1, 0).applyQuaternion(body.rotation).cross(_up).normalize();
        _north.crossVectors(_up, _east);
        for (let i = 0; i < gc; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const spread = this.rnd(-0.5, 0.5);
          // Ground point below the vessel's centre of mass
          const comHeight = v.altitude - Math.max(v.terrainHeight, 0);
          _spec.kind = 'steam';
          _spec.pos.copy(v.r).add(body.position).addScaledVector(_up, -comHeight + 2);
          _spec.pos.addScaledVector(_north, side * this.rnd(5, 18)).addScaledVector(_east, spread * 8);
          _spec.vel.copy(body.velocity).add(body.surfaceVelocity(_tmp.copy(v.r), _tmp));
          _spec.vel.addScaledVector(_north, side * this.rnd(25, 70)).addScaledVector(_east, spread * 30).addScaledVector(_up, this.rnd(3, 16));
          _spec.life = this.rnd(14, 28);
          _spec.size0 = this.rnd(6, 12);
          _spec.size1 = this.rnd(40, 80);
          _spec.color.setRGB(0.92, 0.92, 0.93);
          _spec.alpha = 0.5;
          _spec.emissive = 0.6;
          _spec.drag = 0.35;
          _spec.buoyancy = 1.1;
          _spec.up.copy(_up);
          this.particles.spawn(_spec);
        }
      }
    } else if (thr > 0.05) {
      prev.copy(_abs);
      // Airless body: exhaust blasts regolith sideways near the surface
      const rate = 50 * (1 - radar / 60) * Math.min(3, 1 + clusterR);
      const c = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
      _east.set(0, 1, 0).applyQuaternion(body.rotation).cross(_up).normalize();
      _north.crossVectors(_up, _east);
      for (let i = 0; i < c; i++) {
        const a = Math.random() * Math.PI * 2;
        _spec.kind = 'dust';
        _spec.pos.copy(v.r).add(body.position).addScaledVector(_up, -(v.altitude - v.terrainHeight) + 0.5);
        _spec.vel.copy(body.velocity).add(body.surfaceVelocity(_tmp.copy(v.r), _tmp));
        _spec.vel.addScaledVector(_east, Math.cos(a) * this.rnd(40, 120)).addScaledVector(_north, Math.sin(a) * this.rnd(40, 120));
        _spec.life = this.rnd(0.8, 1.8);
        _spec.size0 = 2;
        _spec.size1 = this.rnd(8, 20);
        _spec.color.setRGB(0.45, 0.44, 0.42);
        _spec.alpha = 0.35;
        _spec.emissive = 0;
        _spec.drag = 0.1;
        _spec.buoyancy = 0;
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    }
  }

  /**
   * Transonic vapour cone: near Mach 1 the air expands and cools in the flow
   * around the vehicle's shoulders, and in humid air water vapour briefly
   * condenses into a white collar (the Prandtl–Glauert "singularity" cloud).
   */
  private emitVaporCone(v: Vessel, dt: number): void {
    // Strongest right at Mach ~1, fading either side
    const k = 1 - Math.min(1, Math.abs(v.mach - 1.0) / 0.12);
    const n = Math.floor(260 * k * this.density * dt + Math.random());
    if (n <= 0) return;
    const spd = v.airVelocity.length();
    if (spd < 1) return;
    const flow = _tmp.copy(v.airVelocity).multiplyScalar(-1 / spd); // direction the air moves past us
    const ax = v.forward(_abs);
    _east.crossVectors(ax, _up.copy(v.r).normalize());
    if (_east.lengthSq() < 1e-6) _east.set(1, 0, 0);
    _east.normalize();
    _north.crossVectors(ax, _east).normalize();
    const R = v.refRadius;
    // Collar sits around the widest point, a bit below the nose
    const along = v.length * 0.3;
    const base = _vAbs.copy(v.r).add(v.body.position).addScaledVector(ax, along * 0.2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = R * this.rnd(1.1, 2.4);
      _spec.kind = 'steam';
      _spec.pos.copy(base).addScaledVector(_east, Math.cos(a) * rr).addScaledVector(_north, Math.sin(a) * rr).addScaledVector(ax, -this.rnd(0, along));
      _spec.vel.copy(v.v).add(v.body.velocity).addScaledVector(flow, spd * this.rnd(0.02, 0.1));
      _spec.life = this.rnd(0.12, 0.3);
      _spec.size0 = R * 0.9;
      _spec.size1 = R * this.rnd(1.6, 2.6);
      _spec.color.setRGB(0.97, 0.98, 1.0);
      _spec.alpha = 0.35 * k;
      _spec.emissive = 0.9;
      _spec.drag = 0;
      _spec.buoyancy = 0;
      _spec.up.copy(_up);
      this.particles.spawn(_spec);
    }
  }

  /**
   * Liftoff frost: cryogenic tanks sit on the pad covered in ice condensed from
   * humid air; at ignition the vibration shakes it off in sheets. Flakes fall
   * away with gravity and air drag while the rocket accelerates out from under them.
   */
  private emitFrost(v: Vessel, view: VesselView, camAbs: Vector3, dt: number): void {
    const body = v.body;
    _up.copy(v.r).normalize();
    _ax.set(0, 1, 0).applyQuaternion(v.q);
    const fade = 1 - v.airborneTime / 12;
    body.surfaceVelocity(_tmp.copy(v.r), _vAbs).add(body.velocity);
    for (const e of view.partEntries) {
      const p = e.part;
      if (!p.propellant || !CRYO.has(p.propellant) || p.fuelCapacity <= 0 || p.destroyed) continue;
      const h = p.height;
      const r = p.radius;
      const rate = 28 * this.density * fade * Math.max(0.5, h / 8) * (1 + r);
      const n = Math.floor(rate * dt + Math.random());
      if (n <= 0) continue;
      e.obj.getWorldPosition(_pp).add(camAbs);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const y = (Math.random() - 0.5) * h;
        _spec.kind = 'dust';
        _spec.pos.copy(_pp).addScaledVector(_ax, y);
        _east.crossVectors(_ax, _up);
        if (_east.lengthSq() < 1e-6) _east.set(1, 0, 0);
        _east.normalize();
        _north.crossVectors(_ax, _east);
        _spec.pos.addScaledVector(_east, Math.cos(a) * r * 1.02).addScaledVector(_north, Math.sin(a) * r * 1.02);
        // Flakes leave with the rocket's velocity plus a small outward push
        _spec.vel.copy(_vAbs).addScaledVector(_east, Math.cos(a) * this.rnd(0.5, 2)).addScaledVector(_north, Math.sin(a) * this.rnd(0.5, 2));
        _spec.life = this.rnd(1.5, 3.5);
        _spec.size0 = this.rnd(0.12, 0.4) * (0.6 + r * 0.25);
        _spec.size1 = _spec.size0 * 0.8;
        _spec.color.setRGB(0.94, 0.96, 1.0);
        _spec.alpha = 0.85;
        _spec.emissive = 0.15;
        _spec.drag = 0.9;
        _spec.buoyancy = -body.mu / v.r.lengthSq() * 0.7; // falls, slowed by air
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    }
  }

  private readonly prevThrust = new Map<number, number>();

  /** Engine shutdown in vacuum: residual propellant vents and freezes into a glittering cloud. */
  private shutdownIce(v: Vessel, dt: number): void {
    void dt;
    for (const p of v.parts) {
      if (!p.isEngine) continue;
      const prev = this.prevThrust.get(p.uid) ?? 0;
      const now = p.thrust;
      this.prevThrust.set(p.uid, now);
      if (!(prev > 0 && now <= 0) || v.airDensity > 1e-7 || p.destroyed) continue;
      _tmp.copy(p.position);
      _tmp.y -= p.height / 2;
      v.localToBody(_tmp, _pp).add(v.body.position);
      _ax.set(0, -1, 0).applyQuaternion(v.q);
      const n = Math.floor(140 * this.density);
      for (let i = 0; i < n; i++) {
        _spec.kind = 'spark';
        _spec.pos.copy(_pp).add(this.jitter(_tmp, p.radius * 0.5));
        _spec.vel.copy(v.v).add(v.body.velocity).addScaledVector(_ax, this.rnd(3, 25)).add(this.jitter(_tmp, 6));
        _spec.life = this.rnd(1.5, 4);
        _spec.size0 = this.rnd(0.04, 0.12) * (0.5 + p.radius);
        _spec.size1 = _spec.size0 * 1.5;
        _spec.color.setRGB(0.85, 0.92, 1.0);
        _spec.alpha = 1;
        _spec.emissive = 3;
        _spec.drag = 0;
        _spec.buoyancy = 0;
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    }
  }

  /** Radial dust sheet where the exhaust hits the ground (thin air: slower, lingering). */
  private emitGroundDust(v: Vessel, radar: number, clusterR: number, dt: number, r: number, g: number, b: number, alpha: number): void {
    const body = v.body;
    const rate = 45 * this.density * (1 - radar / 45) * Math.min(3, 1 + clusterR);
    const c = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
    _up.copy(v.r).normalize();
    _east.set(0, 1, 0).applyQuaternion(body.rotation).cross(_up).normalize();
    _north.crossVectors(_up, _east);
    for (let i = 0; i < c; i++) {
      const a = Math.random() * Math.PI * 2;
      _spec.kind = 'dust';
      _spec.pos.copy(v.r).add(body.position).addScaledVector(_up, -(v.altitude - v.terrainHeight) + 0.8);
      _spec.vel.copy(body.velocity).add(body.surfaceVelocity(_tmp.copy(v.r), _tmp)).add(v.wind);
      _spec.vel.addScaledVector(_east, Math.cos(a) * this.rnd(15, 45)).addScaledVector(_north, Math.sin(a) * this.rnd(15, 45)).addScaledVector(_up, this.rnd(1, 6));
      _spec.life = this.rnd(3, 7);
      _spec.size0 = 3;
      _spec.size1 = this.rnd(18, 40);
      _spec.color.setRGB(r, g, b);
      _spec.alpha = alpha;
      _spec.emissive = 0;
      _spec.drag = 0.6;
      _spec.buoyancy = 0.15;
      _spec.up.copy(_up);
      this.particles.spawn(_spec);
    }
  }

  private emitPlasma(v: Vessel, dt: number): void {
    const intensity = Math.min(1, v.heatFlux / 2e6);
    const n = Math.floor(600 * intensity * dt + Math.random());
    const vel = v.surfaceVelocity;
    const spd = vel.length();
    if (spd < 1) return;
    _tmp.copy(vel).multiplyScalar(1 / spd);
    const r = v.refRadius;
    for (let i = 0; i < n; i++) {
      _spec.kind = 'plasma';
      _spec.pos.copy(v.r).add(v.body.position).addScaledVector(_tmp, r * 0.8).add(this.jitter(_abs, r * 0.9));
      _spec.vel.copy(v.v).add(v.body.velocity).addScaledVector(_tmp, -spd * this.rnd(0.05, 0.25));
      _spec.life = this.rnd(0.25, 0.7);
      _spec.size0 = r * this.rnd(1.2, 2.2);
      _spec.size1 = r * this.rnd(2.5, 5);
      _spec.color.setRGB(1.0, 0.45 + 0.25 * intensity, 0.25 + 0.3 * intensity);
      _spec.alpha = 0.6;
      _spec.emissive = 6 * intensity;
      _spec.drag = 0;
      _spec.buoyancy = 0;
      this.particles.spawn(_spec);
    }
  }

  /** React to discrete simulation events. */
  onEvent(e: FlightEvent, camAbs: Vector3): void {
    const v = e.vessel;
    const body = v.body;
    if (this.particles.frame !== body) return;
    const pos = new Vector3();
    if (e.part) v.localToBody(e.part.position, pos).add(body.position);
    else pos.copy(v.r).add(body.position);
    const vel = v.v.clone().add(body.velocity);
    _up.copy(v.r).normalize();
    const air = v.airDensity > 1e-4;
    if (e.kind === 'crash' || e.kind === 'overheat' || e.kind === 'breakup' || e.kind === 'vessel-destroyed') {
      const size = e.part ? Math.max(2, e.part.radius * 2 + e.part.height * 0.3) : 6;
      this.explosion(pos, vel, size, air);
      if (air) this.shockRing(pos, vel, size);
      this.flash.position.copy(pos).sub(camAbs);
      this.flash.intensity = 2e5 * size;
      this.flashTime = 1.5;
    } else if (e.kind === 'ignition' && e.part) {
      // Ignition: a bright, brief fireball at the nozzle as the start-up propellants light
      _tmp.copy(e.part.position);
      _tmp.y -= e.part.height / 2;
      v.localToBody(_tmp, pos).add(body.position);
      const r = Math.max(0.3, e.part.radius);
      this.flash.position.copy(pos).sub(camAbs);
      this.flash.intensity = Math.max(this.flash.intensity, 6e4 * r);
      this.flashTime = Math.max(this.flashTime, 0.35);
      _ax.set(0, -1, 0).applyQuaternion(v.q);
      const n = Math.floor(30 * this.density) + 6;
      for (let i = 0; i < n; i++) {
        _spec.kind = 'fire';
        _spec.pos.copy(pos).add(this.jitter(_tmp, r * 0.6)).addScaledVector(_ax, this.rnd(0, r * 2));
        _spec.vel.copy(vel).addScaledVector(_ax, this.rnd(4, 30)).add(this.jitter(_tmp, r * 4));
        _spec.life = this.rnd(0.15, 0.5);
        _spec.size0 = r * this.rnd(0.6, 1.4);
        _spec.size1 = r * this.rnd(2, 4);
        _spec.color.setRGB(1, this.rnd(0.55, 0.8), this.rnd(0.2, 0.4));
        _spec.alpha = 1;
        _spec.emissive = 10;
        _spec.drag = air ? 2 : 0;
        _spec.buoyancy = air ? 6 : 0;
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    } else if (e.kind === 'touchdown' || e.kind === 'splashdown') {
      const speed = e.speed ?? 2;
      const strength = Math.min(3, 0.4 + speed / 3);
      const n = Math.floor((e.kind === 'splashdown' ? 90 : 60) * strength * this.density);
      _east.set(0, 1, 0).applyQuaternion(body.rotation).cross(_up).normalize();
      _north.crossVectors(_up, _east);
      body.surfaceVelocity(_tmp.copy(v.r), _vAbs).add(body.velocity).add(v.wind);
      const R = Math.max(1.5, v.refRadius * 1.5);
      const dc = DUST_COLORS[body.id] ?? DUST_COLORS.earth!;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const splash = e.kind === 'splashdown';
        _spec.kind = splash ? 'steam' : 'dust';
        _spec.pos.copy(pos).addScaledVector(_up, -(v.radarAltitude) + 0.5).addScaledVector(_east, Math.cos(a) * R).addScaledVector(_north, Math.sin(a) * R);
        const out = this.rnd(4, 14) * strength;
        _spec.vel.copy(_vAbs).addScaledVector(_east, Math.cos(a) * out).addScaledVector(_north, Math.sin(a) * out).addScaledVector(_up, this.rnd(2, 10) * strength * (splash ? 1.6 : 0.6));
        _spec.life = splash ? this.rnd(0.8, 2) : this.rnd(1.5, 4) * (air ? 1 : 0.6);
        _spec.size0 = R * this.rnd(0.4, 0.8);
        _spec.size1 = R * this.rnd(2, 5);
        if (splash) _spec.color.setRGB(0.9, 0.93, 0.97);
        else _spec.color.setRGB(dc[0], dc[1], dc[2]);
        _spec.alpha = splash ? 0.6 : 0.45;
        _spec.emissive = 0;
        _spec.drag = air ? 1.4 : 0.05;
        _spec.buoyancy = air ? (splash ? -6 : 0.3) : -body.mu / v.r.lengthSq();
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    } else if (e.kind === 'decouple' || e.kind === 'fairing') {
      // Pyrotechnic separation: a short white flash on the seam
      this.flash.position.copy(pos).sub(camAbs);
      this.flash.intensity = Math.max(this.flash.intensity, 2.5e4);
      this.flashTime = Math.max(this.flashTime, 0.2);
      for (let i = 0; i < 26; i++) {
        _spec.kind = air ? 'smoke' : 'spark';
        _spec.pos.copy(pos).add(this.jitter(_tmp, 1.5));
        _spec.vel.copy(vel).add(this.jitter(_tmp, air ? 8 : 15));
        _spec.life = air ? this.rnd(2, 5) : this.rnd(0.4, 1.2);
        _spec.size0 = air ? 2 : 0.3;
        _spec.size1 = air ? this.rnd(6, 14) : 0.15;
        _spec.color.setRGB(air ? 0.85 : 1.0, air ? 0.85 : 0.8, air ? 0.86 : 0.5);
        _spec.alpha = air ? 0.4 : 1;
        _spec.emissive = air ? 0 : 8;
        _spec.drag = air ? 1.2 : 0;
        _spec.buoyancy = 0;
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    }
  }

  /** Expanding ring of condensation where the blast wave compresses humid air. */
  private shockRing(pos: Vector3, vel: Vector3, size: number): void {
    _east.set(1, 0, 0);
    if (Math.abs(_east.dot(_up)) > 0.9) _east.set(0, 0, 1);
    _east.cross(_up).normalize();
    _north.crossVectors(_up, _east);
    const n = Math.floor(48 * this.density) + 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.1;
      const speed = this.rnd(90, 130) * Math.sqrt(size / 6);
      _spec.kind = 'steam';
      _spec.pos.copy(pos).addScaledVector(_east, Math.cos(a) * size).addScaledVector(_north, Math.sin(a) * size);
      _spec.vel.copy(vel).addScaledVector(_east, Math.cos(a) * speed).addScaledVector(_north, Math.sin(a) * speed);
      _spec.life = this.rnd(0.45, 0.7);
      _spec.size0 = size * 0.8;
      _spec.size1 = size * 2.5;
      _spec.color.setRGB(0.95, 0.96, 1);
      _spec.alpha = 0.45;
      _spec.emissive = 0.6;
      _spec.drag = 2.5;
      _spec.buoyancy = 0;
      _spec.up.copy(_up);
      this.particles.spawn(_spec);
    }
  }

  private explosion(pos: Vector3, vel: Vector3, size: number, air: boolean): void {
    for (let i = 0; i < 45; i++) {
      _spec.kind = 'fire';
      _spec.pos.copy(pos).add(this.jitter(_tmp, size * 0.5));
      _spec.vel.copy(vel).add(this.jitter(_tmp, size * 3));
      _spec.life = this.rnd(0.6, 2.2);
      _spec.size0 = size * this.rnd(0.6, 1.2);
      _spec.size1 = size * this.rnd(2.5, 5);
      _spec.color.setRGB(1, this.rnd(0.45, 0.7), this.rnd(0.12, 0.3));
      _spec.alpha = 1;
      _spec.emissive = 12;
      _spec.drag = air ? 1.5 : 0;
      _spec.buoyancy = air ? 4 : 0;
      _spec.up.copy(_up);
      this.particles.spawn(_spec);
    }
    if (air) {
      for (let i = 0; i < 40; i++) {
        _spec.kind = 'smoke';
        _spec.pos.copy(pos).add(this.jitter(_tmp, size));
        _spec.vel.copy(vel).add(this.jitter(_tmp, size * 1.5));
        _spec.life = this.rnd(8, 20);
        _spec.size0 = size * 1.5;
        _spec.size1 = size * this.rnd(6, 12);
        _spec.color.setRGB(0.12, 0.11, 0.1);
        _spec.alpha = 0.7;
        _spec.emissive = 0.5;
        _spec.drag = 0.8;
        _spec.buoyancy = 2;
        _spec.up.copy(_up);
        this.particles.spawn(_spec);
      }
    }
    for (let i = 0; i < 90; i++) {
      _spec.kind = 'spark';
      _spec.pos.copy(pos);
      _spec.vel.copy(vel).add(this.jitter(_tmp, size * 12));
      _spec.life = this.rnd(0.5, 2.5);
      _spec.size0 = 0.4 + size * 0.05;
      _spec.size1 = 0.1;
      _spec.color.setRGB(1, 0.75, 0.4);
      _spec.alpha = 1;
      _spec.emissive = 20;
      _spec.drag = air ? 0.8 : 0;
      _spec.buoyancy = air ? -9.8 : 0;
      _spec.up.copy(_up);
      this.particles.spawn(_spec);
    }
  }

  forget(vesselId: number): void {
    this.lastEmit.delete(String(vesselId));
  }
}
