/**
 * LEARNING NOTE: The flight scene — gluing simulation, rendering and UI
 *
 * Each frame:
 *   1. read input → vessel controls (throttle, pitch/yaw/roll, staging…)
 *   2. advance the simulation (fixed steps or on-rails warp)
 *   3. turn simulation events into feedback: HUD log, toasts, sounds, particles
 *   4. place the camera (chase / tower / map) at the vessel's interpolated state
 *   5. floating origin: every renderable = (absolute position − camera position)
 *   6. render the world, post-process, draw the navball
 *
 * The simulation never knows about meshes or HTML — it can run headless in tests.
 *
 * Key concepts: game loop orchestration, separation of concerns, event
 * handling, floating origin
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { G0 } from '../core/constants';
import { clamp } from '../core/math';
import type { CraftData } from '../parts/Craft';
import { analyzeStages, type StageInfo } from '../parts/DeltaV';
import { CelestialBody } from '../physics/CelestialBody';
import { FlightEffects } from '../render/fx/FlightEffects';
import { LaunchPad } from '../render/LaunchPad';
import { buildFairingHalf } from '../render/vessel/PartMeshes';
import { VesselView } from '../render/vessel/VesselView';
import { FlightSim } from '../sim/FlightSim';
import type { Vessel, SASMode } from '../sim/Vessel';
import type { FlightEvent } from '../sim/VesselPhysics';
import { planCircularize, planCorrection, planDeorbit, planMoonTransfer, planReturnToEarth, type PlanResult } from '../sim/Planner';
import { FlightHUD, type HudActions, type ObjectiveView, type PlanKind } from '../ui/FlightHUD';
import { Navball } from '../ui/Navball';
import type { LaunchSite } from '../world/LaunchSites';
import { FlightCamera, MapCamera } from './FlightCamera';
import type { GameContext, GameState } from './GameContext';
import { MapView } from './MapView';
import type { Mesh } from 'three';
import type { MissionRuntime } from './Missions';

export interface FlightParams {
  craft: CraftData;
  site: LaunchSite;
  startUt: number;
  /** Launch azimuth for the ascent autopilot (degrees from north). */
  heading: number;
  mission: MissionRuntime | null;
  onExit: (reason: 'vab' | 'menu' | 'revert') => void;
}

const _abs = new Vector3();
const _q = new Quaternion();
const _origin = new Vector3();
const _tmp = new Vector3();
const _m4 = new Matrix4();

export class FlightState implements GameState {
  readonly sim: FlightSim;
  private readonly ctx: GameContext;
  private readonly params: FlightParams;
  private readonly views = new Map<number, VesselView>();
  private readonly fairingMeshes = new Map<object, Mesh>();
  private readonly pad: LaunchPad | null;
  private readonly effects = new FlightEffects();
  readonly camera = new FlightCamera();
  private readonly mapCam = new MapCamera();
  private readonly mapView: MapView;
  mapMode = false;
  private readonly navball = new Navball();
  private readonly hud: FlightHUD;
  private stageInfo: StageInfo[] = [];
  private stageTimer = 0;
  private realTime = 0;
  private readonly unbindKey: () => void;
  private lastWarpMsg = '';
  private maxQCalled = false;
  private orbitCalled = false;
  private countdown = -1;
  private readonly mission: MissionRuntime | null;
  private shakeLevel = 0;

  constructor(ctx: GameContext, params: FlightParams) {
    this.ctx = ctx;
    this.params = params;
    this.mission = params.mission;
    ctx.system.update(params.startUt);
    this.sim = new FlightSim(ctx.system, params.craft, params.site, params.startUt);
    const v = this.sim.active;
    const scene = ctx.space.scene;

    // Launch pad attached to the rotating Earth
    const terrain = ctx.space.terrainFor(params.site.body);
    if (terrain) {
      const len = v.length;
      const radius = Math.max(1, v.refRadius);
      this.pad = new LaunchPad({ concrete: ctx.assets.pbr.concrete }, len, radius);
      const lat = (params.site.lat * Math.PI) / 180;
      const lon = (params.site.lon * Math.PI) / 180;
      const up = CelestialBody.dirFromLatLon(lat, lon, new Vector3());
      const east = new Vector3(up.z, 0, -up.x).normalize();
      const south = new Vector3().crossVectors(east, up).normalize();
      const body = ctx.system.get(params.site.body);
      const h = body.terrain ? body.terrain.heightAt(up) : 0;
      this.pad.group.position.copy(up).multiplyScalar(body.radius + h);
      this.pad.group.quaternion.setFromRotationMatrix(_m4.makeBasis(east, up, south));
      terrain.group.add(this.pad.group);
      this.camera.setupTower(up.clone().multiplyScalar(body.radius + h), 380, 22, 225);
    } else {
      this.pad = null;
    }

    scene.add(this.effects.particles.smokeMesh, this.effects.particles.glowMesh, this.effects.engineLight, this.effects.flash);
    this.addView(v);

    // Camera framing
    this.camera.targetDistance = this.camera.distance = Math.max(12, v.length * 1.6);
    this.camera.minDistance = Math.max(2, v.boundingRadius * 0.6);
    this.camera.yaw = 235;
    this.camera.pitch = 6;

    // Lighting: shadows for vessel & pad
    const gl = ctx.renderer.gl;
    gl.shadowMap.enabled = true;
    const sun = ctx.space.sunLight;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    ctx.space.hemi.visible = false;

    this.mapView = new MapView(ctx, this.sim);
    const actions: HudActions = {
      stage: () => this.doStage(),
      warpUp: () => this.sim.warpUp(),
      warpDown: () => this.sim.warpDown(),
      stopWarp: () => this.sim.stopWarp(),
      togglePause: () => (this.sim.paused = !this.sim.paused),
      toggleSAS: () => this.toggleSAS(),
      setSASMode: (m) => this.setSASMode(m),
      cycleSpeedMode: () => this.cycleSpeedMode(),
      setThrottle: (t) => (this.sim.active.controls.throttle = t),
      toggleMap: () => this.toggleMap(),
      toggleLegs: () => this.toggleLegs(),
      engageAscent: (km, hdg) => {
        this.sim.autopilot.ascent.targetAltitude = Math.max(100, km) * 1000;
        this.sim.autopilot.ascent.heading = hdg;
        this.sim.autopilot.ascent.maxG = this.sim.active.hasCrew ? 4 : 5;
        this.sim.autopilot.engage('ascent', this.sim);
        if (this.sim.active.situation === 'prelaunch') this.startCountdown();
      },
      executeNode: () => {
        if (this.sim.nodes.length) this.sim.autopilot.engage('node', this.sim);
      },
      warpToNode: () => this.warpToNode(),
      engageLanding: () => this.sim.autopilot.engage('land', this.sim),
      plan: (kind) => this.plan(kind),
      deleteNodes: () => {
        for (const n of [...this.sim.nodes]) this.sim.removeNode(n);
      },
      disengageAutopilot: () => {
        this.sim.autopilot.disengage('Autopilot off');
        this.sim.active.controls.throttle = 0;
      },
    };
    this.hud = new FlightHUD(ctx.ui, actions, this.navball);
    this.sim.autopilot.ascent.heading = params.heading;
    this.hud.setAscentDefaults(200, params.heading);
    this.unbindKey = ctx.input.onKey((code) => this.onKey(code));
    this.hud.logEvent(0, `${v.name} on the pad at ${params.site.name}`);
    this.hud.showToast(params.site.short, 'Press SPACE to launch · H for controls', 5);
    ctx.audio.setMusicIntensity(0.6);
    this.refreshStageInfo();
    if (this.mission) this.mission.start(this.sim);
  }

  private addView(v: Vessel): void {
    const view = new VesselView(v);
    this.views.set(v.id, view);
    this.ctx.space.scene.add(view.group);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private plan(kind: PlanKind): { ok: boolean; message: string } {
    const sim = this.sim;
    if (sim.active.totalThrust > 0) return { ok: false, message: 'Cut the engines before planning' };
    const planners: Record<PlanKind, () => PlanResult> = {
      'circ-ap': () => planCircularize(sim, 'ap'),
      'circ-pe': () => planCircularize(sim, 'pe'),
      tli: () => planMoonTransfer(sim),
      mcc: () => planCorrection(sim),
      tei: () => planReturnToEarth(sim),
      deorbit: () => planDeorbit(sim),
    };
    const r = planners[kind]();
    if (r.ok) {
      this.hud.logEvent(sim.missionTime, r.message, 'good');
      this.ctx.audio.click();
    }
    return r;
  }

  private startCountdown(): void {
    if (this.countdown >= 0 || this.sim.active.situation !== 'prelaunch') return;
    this.countdown = 5;
    this.ctx.audio.say('Terminal count. T minus five', 'count');
  }

  private doStage(): void {
    const v = this.sim.active;
    if (v.situation === 'prelaunch' && v.controls.throttle <= 0) v.controls.throttle = 1;
    if (this.sim.stage()) this.refreshStageInfo();
  }

  private toggleSAS(): void {
    const c = this.sim.active.controls;
    c.sas = !c.sas;
    if (c.sas) this.sim.attitude.resetHold(this.sim.active);
    this.ctx.audio.click();
  }

  private setSASMode(m: SASMode): void {
    const c = this.sim.active.controls;
    c.sas = true;
    c.sasMode = m;
    if (this.sim.autopilot.mode !== 'off' && this.sim.autopilot.mode !== 'node') this.sim.autopilot.disengage();
    this.sim.attitude.resetHold(this.sim.active);
    this.ctx.audio.click();
  }

  private cycleSpeedMode(): void {
    const c = this.sim.active.controls;
    c.speedMode = c.speedMode === 'surface' ? 'orbit' : c.speedMode === 'orbit' ? (this.sim.target ? 'target' : 'surface') : 'surface';
    this.manualSpeedMode = true;
  }

  private manualSpeedMode = false;

  private toggleLegs(): void {
    const v = this.sim.active;
    const any = v.parts.some((p) => p.legsDeployed);
    for (const p of v.parts) if (p.def.legs) p.legsDeployed = !any;
  }

  private toggleMap(): void {
    this.mapMode = !this.mapMode;
    if (this.mapMode) {
      const v = this.sim.active;
      this.mapCam.targetDistance = this.mapCam.distance = v.body.radius * 4;
    }
    this.mapView.setVisible(this.mapMode);
  }

  private warpToNode(): void {
    const n = this.sim.nodes[0];
    if (!n) return;
    this.mapView.warpTarget = n.time - 90;
  }

  private onKey(code: string): void {
    const v = this.sim.active;
    switch (code) {
      case 'Space':
        if (v.situation === 'prelaunch' && this.countdown < 0 && this.sim.autopilot.mode === 'off') this.doStage();
        else if (v.situation !== 'prelaunch') this.doStage();
        break;
      case 'KeyT':
        this.toggleSAS();
        break;
      case 'KeyZ':
        v.controls.throttle = 1;
        break;
      case 'KeyX':
        v.controls.throttle = 0;
        break;
      case 'KeyG':
        this.toggleLegs();
        break;
      case 'Comma':
        this.sim.warpDown();
        break;
      case 'Period':
        this.sim.warpUp();
        break;
      case 'Slash':
        this.sim.stopWarp();
        break;
      case 'KeyM':
        this.toggleMap();
        break;
      case 'KeyV':
        this.camera.mode = this.camera.mode === 'chase' ? 'tower' : this.camera.mode === 'tower' ? 'free' : 'chase';
        this.hud.showToast(`${this.camera.mode} camera`, '', 1.4);
        break;
      case 'KeyP':
        this.sim.paused = !this.sim.paused;
        break;
      case 'KeyH':
      case 'F1':
        this.hud.toggleHelp();
        break;
      case 'F2':
        // Screenshot mode: hide every overlay
        this.hud.root.style.display = this.hud.root.style.display === 'none' ? '' : 'none';
        break;
      case 'KeyN':
        if (this.mapMode) this.mapView.addNodeAtCursor();
        break;
      case 'Delete':
      case 'Backspace':
        if (this.mapMode) this.mapView.deleteSelectedNode();
        break;
      case 'Escape':
        this.ctx.ui.dispatchEvent(new CustomEvent('apogee:pause'));
        break;
    }
  }

  private readControls(dt: number): void {
    const inp = this.ctx.input;
    const c = this.sim.active.controls;
    const ap = this.sim.autopilot;
    c.pitch = (inp.isDown('KeyS') ? 1 : 0) - (inp.isDown('KeyW') ? 1 : 0);
    c.yaw = (inp.isDown('KeyD') ? 1 : 0) - (inp.isDown('KeyA') ? 1 : 0);
    c.roll = (inp.isDown('KeyE') ? 1 : 0) - (inp.isDown('KeyQ') ? 1 : 0);
    if (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight')) c.throttle = clamp(c.throttle + dt * 0.7, 0, 1);
    if (inp.isDown('ControlLeft') || inp.isDown('ControlRight')) c.throttle = clamp(c.throttle - dt * 0.7, 0, 1);
    // Any manual steering or throttle input overrides the autopilot
    if (ap.mode !== 'off' && (c.pitch !== 0 || c.yaw !== 0 || c.roll !== 0)) ap.disengage('Manual override');
    // Auto speed mode (surface near the ground, orbit higher up)
    if (!this.manualSpeedMode) {
      const v = this.sim.active;
      const lim = v.body.atmosphere ? 36_000 : 12_000;
      const want = v.altitude < lim ? 'surface' : 'orbit';
      if (c.speedMode !== 'target') c.speedMode = want;
    }
  }

  private refreshStageInfo(): void {
    const v = this.sim.active;
    const g = G0;
    this.stageInfo = analyzeStages(v.toSimParts(), v.nextStage, g).filter((s) => s.stage >= v.nextStage - 1);
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  update(realDt: number): void {
    const sim = this.sim;
    this.realTime += realDt;
    this.readControls(realDt);
    // Countdown for autopilot launches
    if (this.countdown >= 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= realDt;
      const after = Math.ceil(this.countdown);
      if (after !== before && after > 0) this.hud.showToast(`T−${after}`, '', 0.9);
      if (this.countdown <= 0) {
        this.countdown = -1;
        this.ctx.audio.say('Ignition. Liftoff!', 'liftoff');
      }
    }
    const apWasLaunch = sim.autopilot.mode === 'ascent' && sim.active.situation === 'prelaunch';
    if (apWasLaunch && this.countdown > 0) {
      // Hold the autopilot until the countdown ends
      const save = sim.autopilot.mode;
      sim.autopilot.mode = 'off';
      const t0 = sim.time;
      sim.update(realDt);
      sim.autopilot.mode = save;
      void t0;
    } else {
      const t0 = sim.time;
      if (this.mapView.warpTarget !== null) this.mapView.driveWarp();
      sim.update(realDt);
      void t0;
    }
    const simDt = sim.paused ? 0 : Math.min(0.25, realDt * sim.warp.rate);
    if (sim.warpMessage && sim.warpMessage !== this.lastWarpMsg) {
      this.hud.logEvent(sim.missionTime, sim.warpMessage, 'warn');
    }
    this.lastWarpMsg = sim.warpMessage;
    sim.warpMessage = '';
    for (const e of sim.events) this.handleEvent(e);
    sim.events.length = 0;
    this.syncViews();
    this.stageTimer -= realDt;
    if (this.stageTimer <= 0) {
      this.stageTimer = 0.5;
      this.refreshStageInfo();
    }
    this.checkMilestones();
    if (this.mission) this.mission.update(sim, realDt, (text, kind) => this.hud.logEvent(sim.missionTime, text, kind), (t, s) => this.hud.showToast(t, s, 4));

    // Camera
    const v = sim.active;
    const inp = this.ctx.input;
    const drag = inp.takeDrag();
    const wheel = inp.takeWheel();
    sim.renderState(v, _abs, _q);
    if (this.mapMode) {
      this.mapView.updateCamera(this.mapCam, realDt, drag.dx, drag.dy, wheel);
    } else {
      if (this.camera.mode === 'tower') {
        const d = _abs.distanceTo(_tmp.copy(this.camera.towerBF).applyQuaternion(v.body.rotation).add(v.body.position));
        if (d > 25_000 || v.body.id !== this.params.site.body) this.camera.mode = 'chase';
      }
      if (this.camera.mode === 'tower') this.camera.updateTower(_abs, v.body, realDt);
      else {
        this.camera.fov += (55 - this.camera.fov) * Math.min(1, realDt * 3);
        this.camera.updateOrbit(_abs, v.body, realDt, drag.dx, drag.dy, wheel);
      }
    }
    // Shake: thrust × air density × proximity
    const nearPad = Math.max(0, 1 - Math.max(0, v.radarAltitude) / 3000);
    const target = v.destroyed ? 0 : Math.min(1.5, (v.totalThrust / Math.max(1, v.mass * 9.81)) * 0.25 * (v.airDensity > 0.01 ? 1 : 0.15) * (0.4 + nearPad) + Math.min(1, v.dynamicPressure / 40_000) * 0.3);
    this.shakeLevel += (target - this.shakeLevel) * Math.min(1, realDt * 4);
    this.camera.shake = this.mapMode ? 0 : this.shakeLevel;

    // Effects read nozzle positions from the meshes: place them for this frame's camera first
    this.placeViews(this.cameraAbs);
    this.effects.update(sim, this.views, this.cameraAbs, simDt, realDt);
    const hemi = this.ctx.space.hemi.color;
    this.effects.particles.update(simDt, this.cameraAbs, this.ctx.space.sunDir, this.ctx.space.sunColorAtCamera, _tmp.set(hemi.r, hemi.g, hemi.b));

    // Audio
    let solidThrust = 0;
    for (const p of v.parts) if (p.isSolid) solidThrust += p.thrust;
    const camDist = this.mapMode ? 1e6 : this.camera.distance;
    const airFactor = v.body.atmosphere ? Math.min(1, v.staticPressure / v.body.atmosphere.seaLevelPressure) : 0;
    this.ctx.audio.updateFlight(v.destroyed ? 0 : v.totalThrust, Math.sqrt(airFactor), v.dynamicPressure, camDist, v.totalThrust > 0 ? solidThrust / v.totalThrust : 0, realDt);
    this.ctx.audio.updateMusic(realDt);
    this.ctx.audio.setMusicIntensity(v.totalThrust > 0 && v.inAtmosphere ? 0.25 : 0.8);

    this.hud.update(
      sim,
      {
        missionTitle: this.mission ? this.mission.def.title : 'Sandbox Flight',
        missionSub: this.mission ? this.mission.def.subtitle : `${v.name} · ${this.params.site.short}`,
        objectives: this.mission ? this.mission.objectiveViews() : this.sandboxObjectives(),
        stageInfo: this.stageInfo,
        navballSize: this.navballSize(),
        mapView: this.mapMode,
      },
      realDt,
    );
    this.mapView.update(realDt, this.mapMode);
    inp.endFrame();
  }

  private sandboxObjectives(): ObjectiveView[] {
    const v = this.sim.active;
    return [
      { text: 'Reach space (100 km)', state: v.maxAltitude > 100_000 ? 'done' : 'active' },
      { text: 'Achieve a stable orbit', state: v.situation === 'orbiting' || this.orbitCalled ? 'done' : 'pending' },
    ];
  }

  private navballSize(): number {
    const h = window.innerHeight;
    return Math.round(clamp(h * 0.2, 150, 230));
  }

  private checkMilestones(): void {
    const v = this.sim.active;
    if (!this.maxQCalled && v.dynamicPressure > 8_000 && v.maxQ > v.dynamicPressure * 1.02 && v.verticalSpeed > 0) {
      this.maxQCalled = true;
      this.hud.showToast('Max Q', `${(v.maxQ / 1000).toFixed(1)} kPa`, 3);
      this.hud.logEvent(this.sim.missionTime, `Max Q: ${(v.maxQ / 1000).toFixed(1)} kPa`);
      this.ctx.audio.say('Max Q', 'maxq');
    }
    if (!this.orbitCalled && v.situation === 'orbiting' && v.body.id === this.params.site.body) {
      this.orbitCalled = true;
      this.hud.showToast('Orbit achieved', '', 4);
      this.hud.logEvent(this.sim.missionTime, 'Stable orbit achieved', 'good');
      this.ctx.audio.say('Orbit achieved. Nice work.', 'orbit');
    }
  }

  private handleEvent(e: FlightEvent): void {
    const met = this.sim.missionTime;
    const active = e.vessel === this.sim.active;
    const air = e.vessel.airDensity > 1e-4;
    switch (e.kind) {
      case 'liftoff':
        this.hud.showToast('Liftoff', this.params.craft.name, 3);
        this.hud.logEvent(met, 'Liftoff!', 'good');
        this.ctx.audio.say('Liftoff! We have liftoff.', 'liftoff');
        break;
      case 'stage':
        if (active) {
          this.hud.logEvent(met, e.message);
          this.ctx.audio.stageSep(air);
        }
        break;
      case 'decouple':
        if (active) this.ctx.audio.say('Stage separation', 'sep', 8);
        this.effects.onEvent(e, this.cameraAbs);
        break;
      case 'fairing':
        this.hud.logEvent(met, 'Fairing separation');
        this.effects.onEvent(e, this.cameraAbs);
        break;
      case 'flameout':
        if (active) {
          this.hud.logEvent(met, e.message, 'warn');
          if (!this.sim.active.parts.some((p) => p.isEngine && p.thrust > 0)) this.ctx.audio.say('Engine cutoff', 'meco', 6);
        }
        break;
      case 'crash':
      case 'overheat':
      case 'breakup':
        this.hud.logEvent(met, e.message, 'bad');
        this.effects.onEvent(e, this.cameraAbs);
        if (e.vessel === this.sim.active || !e.vessel.debris) this.ctx.audio.explosion(true);
        break;
      case 'vessel-destroyed':
        if (active) {
          this.hud.showToast('Vessel lost', e.message, 6);
          this.hud.logEvent(met, e.message, 'bad');
          this.effects.onEvent(e, this.cameraAbs);
        }
        break;
      case 'chute-semi':
      case 'chute-full':
        if (active) {
          this.hud.logEvent(met, e.message, 'good');
          this.ctx.audio.chute();
        }
        break;
      case 'chute-torn':
        if (active) this.hud.logEvent(met, e.message, 'bad');
        break;
      case 'splashdown':
      case 'touchdown':
        if (active) {
          this.hud.logEvent(met, e.message, 'good');
          this.ctx.audio.thud();
        }
        break;
      case 'landed':
        if (active) {
          this.hud.showToast(e.message, '', 4);
          this.ctx.audio.say(e.vessel.body.id === 'earth' ? (e.vessel.inWater ? 'Splashdown' : 'Touchdown') : 'Contact light. Engine stop.', 'landed');
        }
        break;
      case 'soi-change':
        if (active) {
          this.hud.showToast(e.vessel.body.name, e.message, 4);
          this.hud.logEvent(met, e.message, 'good');
        }
        break;
      case 'no-ignitions':
        if (active) this.hud.logEvent(met, e.message, 'bad');
        break;
      default:
        break;
    }
    if (this.mission) this.mission.onEvent(e, this.sim);
  }

  private syncViews(): void {
    const scene = this.ctx.space.scene;
    const alive = new Set<number>();
    for (const v of this.sim.vessels) {
      alive.add(v.id);
      if (!this.views.has(v.id)) this.addView(v);
    }
    for (const [id, view] of this.views) {
      if (!alive.has(id)) {
        scene.remove(view.group);
        view.dispose();
        this.views.delete(id);
        this.effects.forget(id);
      }
    }
    // Fairing halves
    const live = new Set<object>();
    for (const f of this.sim.fairings) {
      live.add(f);
      if (!this.fairingMeshes.has(f)) {
        const m = buildFairingHalf(f.diameter, f.length, f.side);
        scene.add(m);
        this.fairingMeshes.set(f, m);
      }
    }
    for (const [f, m] of this.fairingMeshes) {
      if (!live.has(f)) {
        scene.remove(m);
        m.geometry.dispose();
        this.fairingMeshes.delete(f);
      }
    }
  }

  /** Position vessel meshes relative to the camera (floating origin). */
  private placeViews(camAbs: Vector3): void {
    const pr = this.pressureRatioAt(this.sim.active);
    for (const v of this.sim.vessels) {
      const view = this.views.get(v.id);
      if (!view) continue;
      this.sim.renderState(v, _abs, _q);
      _origin.copy(v.com).negate().applyQuaternion(_q).add(_abs).sub(camAbs);
      view.update(_origin, _q, v === this.sim.active ? pr : this.pressureRatioAt(v), this.realTime);
      view.group.visible = !v.destroyed && (!this.mapMode || _origin.length() < 2e5);
      view.group.updateMatrixWorld(true);
    }
    for (const [f, m] of this.fairingMeshes) {
      const fp = f as { pos: Vector3; q: Quaternion };
      m.position.copy(fp.pos).sub(camAbs);
      m.quaternion.copy(fp.q);
    }
  }

  get cameraAbs(): Vector3 {
    return this.mapMode ? this.mapCam.position : this.camera.position;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render(): void {
    const ctx = this.ctx;
    const cam = ctx.renderer.camera;
    const camAbs = this.cameraAbs;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(this.mapMode ? this.mapCam.quaternion : this.camera.quaternion);
    const fov = this.mapMode ? 50 : this.camera.fov;
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();

    this.placeViews(camAbs);
    ctx.space.update(camAbs, cam, this.realTime, ctx.renderer.pixelRatio);

    // Launch pad lights & crew arm
    if (this.pad) {
      const body = ctx.system.get(this.params.site.body);
      const up = _tmp.copy(this.pad.group.position).normalize().applyQuaternion(body.rotation);
      this.pad.update(up.dot(ctx.space.sunDir), 1 / 60, !isNaN(this.sim.launchTime));
    }

    // Shadow camera follows the active vessel
    const v = this.sim.active;
    this.sim.renderState(v, _abs, _q);
    const sun = ctx.space.sunLight;
    const center = _tmp.copy(_abs).sub(camAbs);
    const ext = Math.min(400, Math.max(40, v.length * 0.9 + (v.radarAltitude < 200 ? 80 : 10)));
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(ctx.space.sunDir, ext * 3);
    const sc = sun.shadow.camera;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 1;
    sc.far = ext * 6;
    sc.updateProjectionMatrix();
    sun.target.updateMatrixWorld();

    // Environment map
    const env = this.envParams(v);
    ctx.space.scene.environment = ctx.env.update(env, 1 / 60) ?? null;

    this.mapView.render(camAbs);
    ctx.post.render(ctx.space.scene, cam, ctx.space.atmFrame, ctx.space.compFrame);

    // Navball overlay. three.js viewports are in CSS pixels (it applies the pixel
    // ratio itself) with the origin at the bottom-left of the canvas.
    const rect = this.hud.ballFrame.getBoundingClientRect();
    const canvasRect = ctx.renderer.canvas.getBoundingClientRect();
    const size = rect.width;
    const x = rect.left - canvasRect.left;
    const y = canvasRect.bottom - rect.bottom;
    if (size > 0) this.navball.render(ctx.renderer.gl, x, y, size);
  }

  private pressureRatioAt(v: Vessel): number {
    const atm = v.body.atmosphere;
    return atm ? v.staticPressure / atm.seaLevelPressure : 0;
  }

  private envParams(v: Vessel) {
    const space = this.ctx.space;
    const body = v.body;
    const up = _tmp.copy(v.r).normalize().clone();
    const R = body.radius;
    const h = Math.max(1, v.altitude);
    const sinA = R / (R + h);
    const horizonCos = -Math.sqrt(Math.max(0, 1 - sinA * sinA));
    const muS = up.dot(space.sunDir);
    const luts = body.id === 'mars' ? space.marsLUTs : space.earthLUTs;
    const amb: [number, number, number] = [0, 0, 0];
    const hasAtm = !!body.atmosphere;
    if (hasAtm) luts.sampleAmbient(muS, amb);
    const sr = space.sunColorAtCamera;
    const s = Math.max(sr.x, 1e-3);
    const spaceF = hasAtm ? clamp((v.altitude - 20_000) / 60_000, 0, 1) : 1;
    const zen = new Vector3(amb[0], amb[1], amb[2]).multiplyScalar((20 * 0.7) / Math.PI);
    const hor = zen.clone().multiplyScalar(1.6).add(new Vector3(0.05, 0.05, 0.06).multiplyScalar(Math.max(0, muS + 0.1) * 20 * 0.1));
    const albedo = new Vector3(...body.albedo);
    const ground = albedo.multiplyScalar(((20 * Math.max(0, muS) + 20 * amb[2]) / Math.PI) * 0.9);
    return {
      up,
      sunDir: space.sunDir.clone(),
      skyZenith: zen,
      skyHorizon: hasAtm ? hor.multiplyScalar(1 - spaceF * 0.7) : new Vector3(0, 0, 0),
      ground,
      sun: sr.clone().multiplyScalar(1 / Math.max(20, s)),
      horizonCos,
      space: spaceF,
    };
  }

  dispose(): void {
    const scene = this.ctx.space.scene;
    for (const view of this.views.values()) {
      scene.remove(view.group);
      view.dispose();
    }
    this.views.clear();
    for (const m of this.fairingMeshes.values()) scene.remove(m);
    scene.remove(this.effects.particles.smokeMesh, this.effects.particles.glowMesh, this.effects.engineLight, this.effects.flash);
    this.effects.particles.dispose();
    if (this.pad) this.pad.group.removeFromParent();
    this.hud.root.remove();
    this.mapView.dispose();
    this.unbindKey();
    this.ctx.audio.silenceFlight();
    this.ctx.space.sunLight.castShadow = false;
    this.ctx.space.hemi.visible = true;
    scene.environment = null;
  }
}
