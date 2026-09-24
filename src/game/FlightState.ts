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
import { Matrix4, Object3D, Quaternion, SpotLight, Vector3 } from 'three';
import { AERO_BREAKUP_LOAD, DEG, DOCK_MAX_ANGLE, DOCK_MAX_SPEED, G0, RAD } from '../core/constants';
import type { FlightPart } from '../sim/FlightPart';
import { clamp } from '../core/math';
import type { CraftData } from '../parts/Craft';
import { analyzeStages, type StageInfo } from '../parts/DeltaV';
import { TEMPLATES } from '../parts/Templates';
import { CelestialBody } from '../physics/CelestialBody';
import { Orbit } from '../physics/Orbit';
import { snapshotVessel, vesselFromSnapshot, type VesselSnapshot } from '../sim/Snapshot';
import { ORBIT_STARTS, type OrbitStart } from './OrbitStart';
import { FlightEffects } from '../render/fx/FlightEffects';
import { LaunchPad } from '../render/LaunchPad';
import { buildFairingHalf } from '../render/vessel/PartMeshes';
import { VesselView } from '../render/vessel/VesselView';
import { FlightSim } from '../sim/FlightSim';
import { burnLeadTime } from '../sim/Maneuver';
import { Vessel, type SASMode } from '../sim/Vessel';
import type { FlightEvent } from '../sim/VesselPhysics';
import { planCapture, planCircularize, planCorrection, planDeorbit, planIntercept, planMarsTransfer, planMatchVelocity, planMoonTransfer, planReturnToEarth, type PlanResult } from '../sim/Planner';
import { FlightHUD, type DockView, type HudActions, type ObjectiveView, type PlanKind, type TargetView } from '../ui/FlightHUD';
import { Navball } from '../ui/Navball';
import { TouchControls, type TouchOps } from '../ui/TouchControls';
import { RadioFeed } from '../ui/StoryUI';
import { h } from '../ui/dom';
import { RadioDirector } from './story/RadioDirector';
import type { LaunchSite } from '../world/LaunchSites';
import { FlightCamera, MapCamera } from './FlightCamera';
import type { GameContext, GameState } from './GameContext';
import { MapView } from './MapView';
import type { Mesh } from 'three';
import type { MissionRuntime, StationSpawn } from './Missions';
import { writeSave } from './Save';

export interface FlightParams {
  craft: CraftData;
  site: LaunchSite;
  startUt: number;
  /** Launch azimuth for the ascent autopilot (degrees from north). */
  heading: number;
  /** Default target orbit altitude for the ascent autopilot (km). */
  targetKm: number;
  /** Orbital plane to follow during ascent (launch windows), or null for a plain heading. */
  planeNormal: Vector3 | null;
  mission: MissionRuntime | null;
  /** Start on the pad or already in orbit (sandbox). */
  orbit: OrbitStart;
  /** A tracking-station vessel to fly instead of a fresh craft. */
  resume: VesselSnapshot | null;
  /** Every other vessel kept in the tracking station (loaded into this flight). */
  others: VesselSnapshot[];
  /** Station a mission places in orbit (unless the tracking station already has it). */
  spawn: StationSpawn | null;
  onExit: (reason: 'vab' | 'menu' | 'revert') => void;
}

const _abs = new Vector3();
const _prop = new Orbit();

/** Carry a restored vessel forward from its saved time to now along its orbit. */
function propagateSnapshot(v: Vessel, s: VesselSnapshot, t: number): void {
  if (v.pinned || t <= s.t) return;
  _prop.setFromState(v.r, v.v, v.body.mu, s.t).getStateAt(t, v.r, v.v);
}

function newPid(): string {
  return `v${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
const _q = new Quaternion();
const _origin = new Vector3();
const _tmp = new Vector3();
const _m4 = new Matrix4();
// Pilot frame of the docking-port view, in the vessel frame (forward, up, right)
const _fL = new Vector3();
const _uL = new Vector3();
const _rL = new Vector3();
const _camPos = new Vector3();
const _camFwd = new Vector3();
const _camUp = new Vector3();

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
  private readonly touch: TouchControls;
  private readonly radioFeed: RadioFeed;
  readonly radio: RadioDirector;
  private stagedOnce = false;
  /** Crew g-stress 0..1 (drives the grey-out vignette). */
  private gStress = 0;
  private highGCalled = false;
  private readonly greyEl: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private readonly heatEl: HTMLDivElement;
  private flashLevel = 0;
  private prevMach = 0;
  private readonly unbindBack: () => void;
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
  /** Save the vessels of this flight to the tracking station on exit (false when reverting). */
  persistOnExit = true;
  /** Tracking-station ids loaded into this flight (dropped from the save if they no longer exist). */
  private readonly loadedPids = new Set<string>();

  constructor(ctx: GameContext, params: FlightParams) {
    this.ctx = ctx;
    this.params = params;
    this.mission = params.mission;
    ctx.system.update(params.startUt);
    this.sim = new FlightSim(ctx.system, params.craft, params.site, params.startUt);
    let v = this.sim.active;
    const scene = ctx.space.scene;
    const inSpace = params.orbit !== 'pad' || !!params.resume;
    if (params.resume) {
      // Resume a vessel from the tracking station where (and when) it was left
      const snap = params.resume;
      const nv = vesselFromSnapshot(snap, ctx.system.get(snap.body));
      propagateSnapshot(nv, snap, params.startUt);
      this.sim.replaceActive(nv);
      v = nv;
      this.loadedPids.add(snap.pid);
    } else if (params.orbit !== 'pad') {
      const spec = ORBIT_STARTS[params.orbit];
      this.sim.placeInOrbit(v, ctx.system.get(spec.body), spec.altKm * 1000, spec.incDeg);
    }
    if (inSpace) this.sim.launchTime = params.startUt;
    // Everything earlier flights left in space rides along (on rails until it comes close)
    for (const s of params.others) {
      if (params.resume && s.pid === params.resume.pid) continue;
      const ov = vesselFromSnapshot(s, ctx.system.get(s.body));
      propagateSnapshot(ov, s, params.startUt);
      if (!ov.pinned) {
        ov.railsOrbit.setFromState(ov.r, ov.v, ov.body.mu, params.startUt);
        ov.onRails = true;
      }
      this.loadedPids.add(s.pid);
      this.sim.addVessel(ov);
    }
    this.spawnStation(params);

    // Launch pad attached to the rotating Earth
    const terrain = inSpace ? undefined : ctx.space.terrainFor(params.site.body);
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
    // Docking floodlight (always in the scene so switching it on never recompiles shaders)
    this.dockLight.castShadow = false;
    this.dockLight.intensity = 0;
    this.dockLight.target = this.dockLightTarget;
    scene.add(this.dockLight, this.dockLightTarget);
    this.addView(v);

    // Camera framing
    this.camera.targetDistance = this.camera.distance = Math.max(12, v.length * 1.6);
    this.camera.minDistance = Math.max(2, v.boundingRadius * 0.6);
    this.camera.yaw = 235;
    this.camera.pitch = 6;

    // Lighting: shadows for vessel & pad
    const gl = ctx.renderer.gl;
    gl.shadowMap.enabled = ctx.renderer.shadowsEnabled;
    const sun = ctx.space.sunLight;
    sun.castShadow = ctx.renderer.shadowsEnabled;
    sun.shadow.mapSize.set(ctx.renderer.shadowSize, ctx.renderer.shadowSize);
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
        // Follow the window's plane only while the player keeps its heading
        this.sim.autopilot.ascent.planeNormal = params.planeNormal && Math.abs(hdg - params.heading) < 0.2 ? params.planeNormal : null;
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
      cycleTarget: () => this.cycleTarget(),
      toggleRcs: () => this.toggleRcs(),
      undock: () => this.undockActive(),
      switchVessel: (d) => this.switchVessel(d),
      toggleAlign: () => this.toggleAlign(),
      toggleDockCam: () => this.toggleDockCam(),
    };
    this.hud = new FlightHUD(ctx.ui, actions, this.navball, ctx.platform.touch);
    this.hudTouch = ctx.platform.touch;
    this.touch = new TouchControls(ctx.ui, ctx.platform, {
      stage: () => this.doStage(),
      setThrottle: (t) => (this.sim.active.controls.throttle = t),
      toggleMap: () => this.toggleMap(),
      cycleCamera: () => this.cycleCamera(),
      pause: () => ctx.ui.dispatchEvent(new CustomEvent('apogee:pause')),
      togglePanel: (p) => this.hud.togglePanel(p),
      setPhotoMode: (on) => this.hud.setVisible(!on),
      toggleRcs: () => this.toggleRcs(),
      cycleTarget: () => this.cycleTarget(),
      toggleAlign: () => this.toggleAlign(),
      toggleDockCam: () => this.toggleDockCam(),
      undock: () => this.undockActive(),
      switchVessel: () => this.switchVessel(1),
    });
    this.touch.setVisible(ctx.platform.touch);
    this.radioFeed = new RadioFeed(ctx.ui, (high) => ctx.audio.quindar(high));
    this.greyEl = h('div', { class: 'greyout' });
    this.heatEl = h('div', { class: 'heatout' });
    this.flashEl = h('div', { class: 'flashout' });
    ctx.ui.append(this.heatEl, this.greyEl, this.flashEl);
    this.radio = new RadioDirector(params.mission ? params.mission.def.id : null, (lines) => this.radioFeed.say(lines));
    if (params.mission) params.mission.onObjective = (i) => this.radio.trigger({ on: 'objective', index: i });
    this.unbindBack = ctx.platform.pushBack(() => {
      if (this.touch.photoMode) this.touch.setPhoto(false);
      else if (this.mapMode) this.toggleMap();
      else ctx.ui.dispatchEvent(new CustomEvent('apogee:pause'));
      return true;
    });
    this.sim.autopilot.ascent.heading = params.heading;
    this.hud.setAscentDefaults(params.targetKm, params.heading);
    this.unbindKey = ctx.input.onKey((code) => this.onKey(code));
    if (inSpace) {
      this.camera.mode = 'chase';
      this.hud.logEvent(0, `${v.name} in flight around ${v.body.name}`);
      this.hud.showToast(v.name, ctx.platform.touch ? 'Flying from orbit' : 'Flying from orbit · F1 for controls', 5);
    } else {
      this.hud.logEvent(0, `${v.name} on the pad at ${params.site.name}`);
      const wx = this.sim.physics.wind?.report;
      if (wx) this.hud.logEvent(0, `Weather: surface wind ${wx.surfaceSpeed.toFixed(0)} m/s from ${wx.surfaceFrom.toFixed(0).padStart(3, '0')}°, jet stream ${wx.jetSpeed.toFixed(0)} m/s at ${(wx.jetAltitude / 1000).toFixed(1)} km`, wx.jetSpeed > 50 ? 'warn' : 'info');
      this.hud.showToast(params.site.short, ctx.platform.touch ? 'Tap STAGE to launch' : 'Press SPACE to launch · F1 for controls', 5);
    }
    const others = this.sim.vessels.length - 1;
    if (others > 0) this.hud.logEvent(0, `${others} other vessel${others === 1 ? '' : 's'} in this flight — map view: click a label to target it`);
    ctx.audio.setMusicIntensity(0.6);
    this.refreshStageInfo();
    if (this.mission) this.mission.start(this.sim);
  }

  private addView(v: Vessel): void {
    const view = new VesselView(v);
    this.views.set(v.id, view);
    this.ctx.space.scene.add(view.group);
  }

  /**
   * Put a mission's station in orbit unless an earlier flight already left it
   * there. It goes into the launch site's orbital plane: a due-east launch
   * reaches the apex of an orbit inclined at the site's latitude, whose
   * ascending node lies 90° of longitude west of the pad — evaluated for the pad
   * ~10 minutes after liftoff, when the ascent reaches orbit.
   */
  private spawnStation(params: FlightParams): void {
    const spawn = params.spawn;
    if (!spawn) return;
    const sim = this.sim;
    const existing = sim.vessels.find((x) => x.missionTag === spawn.tag && x !== sim.active);
    if (existing) {
      sim.target = existing;
      return;
    }
    const tpl = TEMPLATES.find((t) => t.id === spawn.template);
    if (!tpl) return;
    const body = this.ctx.system.get(spawn.body);
    const sv = Vessel.fromCraft(tpl.build(), body);
    sv.name = spawn.name;
    sv.missionTag = spawn.tag;
    this.ctx.system.update(params.startUt + 600);
    const siteDir = CelestialBody.dirFromLatLon(params.site.lat * DEG, params.site.lon * DEG, _tmp).applyQuaternion(body.rotation);
    this.ctx.system.update(params.startUt);
    const lonI = Math.atan2(-siteDir.z, siteDir.x) * RAD;
    sim.placeInOrbit(sv, body, spawn.altKm * 1000, Math.max(spawn.incDeg, Math.abs(params.site.lat)), lonI - 90, 90 + spawn.nuDeg);
    sv.railsOrbit.setFromState(sv.r, sv.v, body.mu, params.startUt);
    sv.onRails = true;
    for (const p of sv.parts) if (p.def.shape === 'solar') p.solarDeploy = 1;
    sim.addVessel(sv);
    sim.target = sv;
  }

  private cycleTarget(): void {
    const sim = this.sim;
    const sys = this.ctx.system;
    const options: Array<CelestialBody | Vessel | null> = [null, sys.moon, sys.mars];
    for (const x of sim.vessels) if (x !== sim.active && !x.destroyed && !x.debris) options.push(x);
    const i = options.indexOf(sim.target);
    sim.target = options[(i + 1) % options.length] ?? null;
    this.hud.showToast(sim.target ? `Target: ${sim.target.name}` : 'Target cleared', '', 1.5);
    this.ctx.audio.click();
  }

  private toggleRcs(): void {
    const v = this.sim.active;
    if (!v.parts.some((p) => !!p.def.rcs)) {
      this.hud.showToast('No RCS thrusters', 'Add RCS quads in the assembly building', 2.5);
      return;
    }
    v.controls.rcs = !v.controls.rcs;
    this.hud.showToast(v.controls.rcs ? 'RCS armed' : 'RCS off', v.controls.rcs ? 'H/N fore-aft · I/K up-down · J/L left-right' : '', 2);
    this.ctx.audio.click();
  }

  private undockActive(): void {
    const ports = this.sim.dockedPorts();
    if (!ports.length) return;
    this.sim.undock(ports[0]!);
    this.refreshStageInfo();
  }

  private switchVessel(dir: 1 | -1): void {
    const nv = this.sim.cycleActive(dir);
    if (!nv) this.hud.showToast('No other vessel to fly', '', 1.5);
  }

  private targetView(): TargetView | null {
    const sim = this.sim;
    const t = sim.target;
    if (!t) return null;
    const info = sim.targetInfo;
    return {
      name: t.name,
      isVessel: !!sim.targetVessel,
      distance: info ? info.distance : NaN,
      relSpeed: info ? info.relSpeed : NaN,
      caDistance: info ? info.caDistance : NaN,
      caIn: info ? info.caTime - sim.time : NaN,
    };
  }

  /**
   * Leave this flight's spacecraft in the tracking station: anything in a stable
   * orbit (or resting on another world) is saved with its full state, and
   * vessels loaded from the station that no longer exist — docked into another,
   * lost, or brought home — are dropped from it. The campaign clock moves on.
   */
  private persistVessels(): void {
    const save = this.ctx.save;
    const camp = save.campaign;
    const sim = this.sim;
    const keep = new Map(camp.vessels.map((s) => [s.pid, s] as const));
    const live = new Set<string>();
    for (const v of sim.vessels) {
      if (v.destroyed || v.debris || !v.isControllable) continue;
      const inSpace = !v.pinned && (v.situation === 'orbiting' || v.situation === 'escaping' || (v.body.id !== 'earth' && !v.inAtmosphere && v.situation !== 'landed'));
      const onWorld = v.pinned && v.body.id !== 'earth' && (v.situation === 'landed' || v.situation === 'splashed');
      if (!inSpace && !onWorld) continue;
      const pid = v.pid ?? newPid();
      v.pid = pid;
      live.add(pid);
      const mission = v.missionTag ?? (v === sim.active && this.mission ? this.mission.def.id : null);
      keep.set(pid, snapshotVessel(v, sim.time, pid, mission));
    }
    for (const pid of this.loadedPids) if (!live.has(pid)) keep.delete(pid);
    camp.vessels = [...keep.values()];
    camp.ut = Math.max(camp.ut, sim.time);
    writeSave(save);
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
      capture: () => planCapture(sim),
      tli: () => planMoonTransfer(sim),
      tmi: () => planMarsTransfer(sim, this.marsTargetAlt()),
      mcc: () => planCorrection(sim, this.marsTargetAlt()),
      tei: () => planReturnToEarth(sim),
      deorbit: () => planDeorbit(sim),
      intercept: () => planIntercept(sim),
      match: () => planMatchVelocity(sim),
    };
    const r = planners[kind]();
    if (r.ok) {
      this.hud.logEvent(sim.missionTime, r.message, 'good');
      this.ctx.audio.click();
    }
    return r;
  }

  /** Arrival periapsis to aim for at Mars: low for atmospheric entry when landing. */
  private marsTargetAlt(): number {
    return this.mission?.def.id === 'mars-landing' ? 40_000 : 300_000;
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
  /** Real seconds of the frame being rendered (set in update, read in render). */
  private frameDt = 1 / 60;

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

  private cycleCamera(): void {
    const m = this.camera.mode;
    // chase → tower → free → docking port (when the vessel has a free port) → chase
    this.camera.mode = m === 'chase' ? 'tower' : m === 'tower' ? 'free' : m === 'free' && this.pickDockCamPort() ? 'dock' : 'chase';
    this.hud.showToast(this.camera.mode === 'dock' ? 'Port camera' : `${this.camera.mode} camera`, '', 1.4);
  }

  /** Short description of what the next STAGE press will do. */
  private nextStageLabel(): string {
    const v = this.sim.active;
    if (v.situation === 'prelaunch' && isNaN(this.sim.launchTime)) return 'LAUNCH';
    const uids = v.stages[v.nextStage];
    if (!uids) return '';
    let engines = 0;
    let decouple = false;
    let chute = false;
    let fairing = false;
    for (const u of uids) {
      const p = v.partByUid(u);
      if (!p) continue;
      if (p.isEngine) engines += p.config.cluster ?? 1;
      else if (p.def.decoupler) decouple = true;
      else if (p.def.parachute) chute = true;
      else if (p.def.fairing) fairing = true;
    }
    const parts: string[] = [];
    if (decouple) parts.push('SEP');
    if (engines) parts.push(`IGN ×${engines}`);
    if (chute) parts.push('CHUTE');
    if (fairing) parts.push('FAIRING');
    return parts.join(' · ');
  }

  private warpToNode(): void {
    const n = this.sim.nodes[0];
    if (!n) return;
    // Stop early enough to start a long burn on time (half its Δv before the node)
    this.mapView.warpTarget = n.time - burnLeadTime(this.sim.active, n.remaining.length());
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
        this.cycleCamera();
        break;
      case 'KeyP':
        this.sim.paused = !this.sim.paused;
        break;
      case 'F1':
        this.hud.toggleHelp();
        break;
      case 'BracketRight':
        this.switchVessel(1);
        break;
      case 'BracketLeft':
        this.switchVessel(-1);
        break;
      case 'KeyR':
        this.toggleRcs();
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
    if (this.ctx.platform.touch) {
      // Analog stick adds to the keys (a keyboard may be attached to a tablet)
      const t = this.touch;
      t.sensitivity = this.ctx.save.settings.stickSensitivity;
      c.pitch = clamp(c.pitch + t.stickY, -1, 1);
      c.yaw = clamp(c.yaw + t.stickX, -1, 1);
      c.roll = clamp(c.roll + t.roll, -1, 1);
    }
    if (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight')) c.throttle = clamp(c.throttle + dt * 0.7, 0, 1);
    if (inp.isDown('ControlLeft') || inp.isDown('ControlRight')) c.throttle = clamp(c.throttle - dt * 0.7, 0, 1);
    // RCS translation, read in the PILOT frame (right, up, forward): H/N forward-back,
    // I/K up-down, J/L left-right — plus the touch translation stick
    let px = 0;
    let pu = 0;
    let pf = 0;
    if (c.rcs && !this.mapMode) {
      pf = (inp.isDown('KeyH') ? 1 : 0) - (inp.isDown('KeyN') ? 1 : 0);
      pu = (inp.isDown('KeyI') ? 1 : 0) - (inp.isDown('KeyK') ? 1 : 0);
      px = (inp.isDown('KeyL') ? 1 : 0) - (inp.isDown('KeyJ') ? 1 : 0);
      if (this.ctx.platform.touch) {
        px = clamp(px + this.touch.tx, -1, 1);
        pu = clamp(pu + this.touch.tu, -1, 1);
        pf = clamp(pf + this.touch.tf, -1, 1);
      }
    }
    // Pilot frame → vessel frame. Normally they coincide (right = +X, up = dorsal
    // +Z, forward = nose +Y); looking out of a docking port they follow the port
    // view, so "up and right" on screen is "up and right" in the window even for a
    // port on the vessel's tail.
    if (this.camera.mode === 'dock' && this.dockCamPort && this.pilotBasis(this.dockCamPort, this.dockCamFace)) {
      c.tx = _rL.x * px + _uL.x * pu + _fL.x * pf;
      c.ty = _rL.y * px + _uL.y * pu + _fL.y * pf;
      c.tz = _rL.z * px + _uL.z * pu + _fL.z * pf;
    } else {
      c.tx = px;
      c.ty = pf;
      c.tz = pu;
    }
    // Any manual steering or throttle input overrides the autopilot
    if (ap.mode !== 'off' && (c.pitch !== 0 || c.yaw !== 0 || c.roll !== 0)) ap.disengage('Manual override');
    // Auto speed mode: target-relative near a target vessel (what docking needs),
    // surface near the ground, orbit higher up
    if (!this.manualSpeedMode) {
      const v = this.sim.active;
      const ti = this.sim.targetInfo;
      if (ti && this.sim.targetVessel && ti.distance < 3_000) c.speedMode = 'target';
      else {
        const lim = v.body.atmosphere ? 36_000 : 12_000;
        c.speedMode = v.altitude < lim ? 'surface' : 'orbit';
      }
    }
  }

  /**
   * The docking-port view frame in vessel coordinates: forward along the port's
   * open face, up along the dorsal side made perpendicular to it, right =
   * forward × up (so it matches the camera's screen axes). Results in _fL/_uL/_rL.
   */
  private pilotBasis(port: FlightPart, face: 1 | -1): boolean {
    if (!this.sim.active.parts.includes(port)) return false;
    _fL.set(0, face, 0).applyQuaternion(port.rotation);
    _uL.set(0, 0, 1).addScaledVector(_fL, -_fL.z);
    if (_uL.lengthSq() < 1e-6) _uL.set(1, 0, 0).addScaledVector(_fL, -_fL.x);
    _uL.normalize();
    _rL.crossVectors(_fL, _uL);
    return true;
  }

  /** Our docking port for the port camera: the one lined up with the target, else the free port facing most forward. */
  private dockCamPort: FlightPart | null = null;
  private dockCamFace: 1 | -1 = 1;

  private pickDockCamPort(): boolean {
    const sim = this.sim;
    const v = sim.active;
    const d = sim.dock;
    if (d.valid && d.own && v.parts.includes(d.own)) {
      this.dockCamPort = d.own;
      this.dockCamFace = d.ownFace;
      return true;
    }
    this.dockCamPort = null;
    let best = -2;
    for (const p of v.parts) {
      const f = v.freePortFace(p);
      if (!f) continue;
      _tmp.set(0, f, 0).applyQuaternion(p.rotation);
      if (_tmp.y > best) {
        best = _tmp.y;
        this.dockCamPort = p;
        this.dockCamFace = f;
      }
    }
    return !!this.dockCamPort;
  }

  /** Absolute pose of a docking port's face at render time: centre → _camPos, axis → _camFwd, view-up → _camUp. */
  private portFacePose(p: FlightPart, face: 1 | -1): boolean {
    if (!this.pilotBasis(p, face)) return false;
    const v = this.sim.active;
    this.sim.renderState(v, _abs, _q);
    _camPos.set(0, (face * p.height) / 2, 0).applyQuaternion(p.rotation).add(p.position).sub(v.com).applyQuaternion(_q).add(_abs);
    _camFwd.copy(_fL).applyQuaternion(_q);
    _camUp.copy(_uL).applyQuaternion(_q);
    return true;
  }

  /** Port camera: in front of our docking port, looking along it, screen-up = the vessel's dorsal side. */
  private updateDockCam(dt: number): boolean {
    if (!this.pickDockCamPort() || !this.dockCamPort) return false;
    if (!this.portFacePose(this.dockCamPort, this.dockCamFace)) return false;
    _camPos.addScaledVector(_camFwd, 0.35);
    this.camera.updateDock(_camPos, _camFwd, _camUp, dt);
    return true;
  }

  private readonly dockLight = new SpotLight(0xfff2de, 0, 0, 0.55, 0.9, 2);
  private readonly dockLightTarget = new Object3D();

  /**
   * Docking floodlight: half of every orbit is night, and an unlit target is
   * invisible against black space. Like the lights on a real crew vehicle, it
   * shines along our port axis whenever a target port is within a few hundred
   * metres (or the port camera is on). Its intensity follows the range squared,
   * so the target stays evenly lit (≈ 1/25 of sunlight — plenty for eyes adapted
   * to the dark) from far out to contact.
   */
  private updateDockLight(camAbs: Vector3): void {
    const d = this.sim.dock;
    const want = (d.valid && d.distance < 400) || this.camera.mode === 'dock';
    const port = d.valid && d.own ? d.own : this.dockCamPort;
    const face = d.valid && d.own ? d.ownFace : this.dockCamFace;
    if (!want || !port || !this.portFacePose(port, face)) {
      this.dockLight.intensity = 0;
      return;
    }
    const range = d.valid ? Math.max(2, d.distance) : 30;
    this.dockLight.intensity = Math.min(60_000, 0.8 * range * range);
    this.dockLight.position.copy(_camPos).sub(camAbs).addScaledVector(_camFwd, 0.2);
    this.dockLightTarget.position.copy(this.dockLight.position).addScaledVector(_camFwd, 10);
    this.dockLightTarget.updateMatrixWorld();
  }

  private toggleAlign(): void {
    const c = this.sim.active.controls;
    if (c.sas && c.sasMode === 'port') {
      this.setSASMode('stability');
      this.hud.showToast('Port alignment off', '', 1.5);
      return;
    }
    if (!this.sim.dock.valid) {
      this.hud.showToast('No docking port in range', 'Target a vessel with a free port of the same size', 2.5);
      return;
    }
    this.setSASMode('port');
    this.hud.showToast('Aligning with the target port', 'SAS holds our port facing theirs — translate with RCS', 2.5);
  }

  private toggleDockCam(): void {
    if (this.camera.mode === 'dock') {
      this.camera.mode = 'chase';
      this.hud.showToast('chase camera', '', 1.4);
      return;
    }
    if (!this.pickDockCamPort()) {
      this.hud.showToast('No free docking port', 'Add a docking port in the assembly building', 2.5);
      return;
    }
    this.camera.mode = 'dock';
    this.hud.showToast('Port camera', 'Looking out of the docking port', 1.8);
  }

  /** Reused readout objects (no allocation per frame). */
  private readonly dockView: DockView = { target: '', distance: 0, closing: 0, lateral: 0, angleDeg: 0, x: 0, y: 0, vx: 0, vy: 0, capture: false, align: false, dockCam: false };
  private readonly touchOps: TouchOps = { rcsAvailable: false, rcs: false, targets: false, dock: false, align: false, dockCam: false, docked: false, canSwitch: false };

  private buildDockView(): DockView | null {
    const sim = this.sim;
    const d = sim.dock;
    const tv = sim.targetVessel;
    if (!d.valid || !tv) return null;
    const o = this.dockView;
    o.target = tv.name;
    o.distance = d.distance;
    o.closing = d.closing;
    o.lateral = d.lateral;
    o.angleDeg = (d.angle * 180) / Math.PI;
    o.x = d.offset.x;
    o.y = d.offset.y;
    o.vx = d.relVel.x;
    o.vy = d.relVel.y;
    o.capture = d.angle < DOCK_MAX_ANGLE && sim.targetInfo !== null && sim.targetInfo.relSpeed < DOCK_MAX_SPEED;
    const c = sim.active.controls;
    o.align = c.sas && c.sasMode === 'port';
    o.dockCam = this.camera.mode === 'dock';
    return o;
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
    this.frameDt = realDt;
    // Layout is clean at the start of a frame (the browser laid out before this
    // callback), so reading the navball's screen rectangle here is free; reading
    // it after the HUD wrote its markers would force a full layout every frame
    this.readBallRect();
    this.applyLiveSettings();
    // Wall-clock time that the game world experiences: nothing but the camera
    // and the HUD moves while paused (no countdown, no g-load, no mission clock)
    const dt = sim.paused ? 0 : realDt;
    this.readControls(dt);
    // Countdown for autopilot launches
    if (this.countdown >= 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
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
    if (this.mission) this.mission.update(sim, dt, (text, kind) => this.hud.logEvent(sim.missionTime, text, kind), (t, s) => this.hud.showToast(t, s, 4));

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
      if (this.camera.mode === 'dock' && !this.updateDockCam(realDt)) this.camera.mode = 'chase';
      if (this.camera.mode === 'tower') this.camera.updateTower(_abs, v.body, realDt);
      else if (this.camera.mode !== 'dock') {
        this.camera.fov += (55 - this.camera.fov) * Math.min(1, realDt * 3);
        this.camera.updateOrbit(_abs, v.body, realDt, drag.dx, drag.dy, wheel);
      }
    }
    // Shake: thrust × air density × proximity
    const nearPad = Math.max(0, 1 - Math.max(0, v.radarAltitude) / 3000);
    const heatBuffet = Math.min(0.7, v.heatFlux / 2.5e6);
    const target = v.destroyed ? 0 : Math.min(1.5, (v.totalThrust / Math.max(1, v.mass * 9.81)) * 0.25 * (v.airDensity > 0.01 ? 1 : 0.15) * (0.4 + nearPad) + Math.min(1, v.dynamicPressure / 40_000) * 0.3 + heatBuffet);
    this.shakeLevel += (target - this.shakeLevel) * Math.min(1, realDt * 4);
    this.camera.shake = this.mapMode ? 0 : this.shakeLevel;
    this.updateScreenEffects(v, realDt);

    // Effects read nozzle positions from the meshes: place them for this frame's camera first
    this.placeViews(this.cameraAbs);
    this.effects.density = this.ctx.space.quality.effects;
    this.effects.update(sim, this.views, this.cameraAbs, simDt, realDt);
    const hemi = this.ctx.space.hemi.color;
    this.effects.particles.update(simDt, this.cameraAbs, this.ctx.space.sunDir, this.ctx.space.sunColorAtCamera, _tmp.set(hemi.r, hemi.g, hemi.b));

    // Audio
    let solidThrust = 0;
    for (const p of v.parts) if (p.isSolid) solidThrust += p.thrust;
    const camDist = this.mapMode ? 1e6 : this.camera.distance;
    const airFactor = v.body.atmosphere ? Math.min(1, v.staticPressure / v.body.atmosphere.seaLevelPressure) : 0;
    // Paused: the engines fall silent too (the physics no longer runs, so totalThrust would stay frozen at full roar)
    const audible = !sim.paused && !v.destroyed;
    this.ctx.audio.updateFlight(audible ? v.totalThrust : 0, Math.sqrt(airFactor), audible ? v.dynamicPressure : 0, camDist, v.totalThrust > 0 ? solidThrust / v.totalThrust : 0, realDt);
    this.ctx.audio.updateMusic(realDt);
    this.ctx.audio.setMusicIntensity(v.totalThrust > 0 && v.inAtmosphere ? 0.25 : 0.8);

    // Per-frame vessel counts for the HUD and the touch ops column (allocation-free loops)
    let controllable = 0;
    let otherVessels = 0;
    for (const x of sim.vessels) {
      if (x.destroyed || x.debris) continue;
      if (x.isControllable) controllable++;
      if (x !== v) otherVessels++;
    }
    let hasRcs = false;
    let docked = false;
    for (const p of v.parts) {
      if (p.def.rcs) hasRcs = true;
      if (p.dockedTo) docked = true;
    }

    this.hud.update(
      sim,
      {
        missionTitle: this.mission ? this.mission.def.title : 'Sandbox Flight',
        missionSub: this.mission ? this.mission.def.subtitle : `${v.name} · ${this.params.site.short}`,
        objectives: this.mission ? this.mission.objectiveViews() : this.sandboxObjectives(),
        stageInfo: this.stageInfo,
        navballSize: this.navballSize(),
        mapView: this.mapMode,
        target: this.targetView(),
        rcs: v.controls.rcs,
        docked,
        vessels: controllable,
        dock: this.mapMode ? null : this.buildDockView(),
      },
      realDt,
    );
    this.mapView.update(realDt, this.mapMode);
    this.radio.update(sim);
    this.updateGStress(dt);
    this.radioFeed.setSignal(this.radio.signal);
    this.radioFeed.update(dt);
    this.hud.setSignal(this.radio.signal, this.radio.lightTime);
    // Touch UI follows the setting live; taps in the map place maneuver nodes
    const touchOn = this.ctx.platform.touch;
    this.touch.setVisible(touchOn);
    if (touchOn) {
      const nextUids = v.stages[v.nextStage];
      const o = this.touchOps;
      o.rcsAvailable = hasRcs && !v.destroyed;
      o.rcs = v.controls.rcs;
      o.targets = otherVessels > 0;
      o.dock = sim.dock.valid && !this.mapMode;
      o.align = v.controls.sas && v.controls.sasMode === 'port';
      o.dockCam = this.camera.mode === 'dock';
      o.docked = docked;
      o.canSwitch = controllable > 1;
      this.touch.update(realDt, v.controls.throttle, this.nextStageLabel(), !!nextUids && !v.destroyed, this.hud.panels, this.mapMode, o);
    }
    for (const tap of inp.takeTaps()) {
      if (this.mapMode) this.mapView.addNodeAt(tap.x, tap.y, tap.touch ? 60 : 30);
    }
    inp.takePan(); // two-finger pan is not used in flight: drop it, or the VAB gets it later
    inp.endFrame();
  }

  /** Navball viewport in canvas pixels (origin bottom-left), refreshed once per frame. */
  private readonly ballRect = { x: 0, y: 0, size: 0 };

  private readBallRect(): void {
    if (this.hud.root.style.display === 'none') {
      this.ballRect.size = 0;
      return;
    }
    const rect = this.hud.ballFrame.getBoundingClientRect();
    const canvasRect = this.ctx.renderer.canvas.getBoundingClientRect();
    this.ballRect.size = rect.width;
    this.ballRect.x = rect.left - canvasRect.left;
    this.ballRect.y = canvasRect.bottom - rect.bottom;
  }

  private hudTouch: boolean;

  /**
   * Settings changed from the pause menu take effect in the running flight:
   * shadows on/off and their resolution, and the touch HUD layout.
   */
  private applyLiveSettings(): void {
    const r = this.ctx.renderer;
    const gl = r.gl;
    const sun = this.ctx.space.sunLight;
    if (gl.shadowMap.enabled !== r.shadowsEnabled || sun.shadow.mapSize.x !== r.shadowSize) {
      gl.shadowMap.enabled = r.shadowsEnabled;
      sun.castShadow = r.shadowsEnabled;
      sun.shadow.mapSize.set(r.shadowSize, r.shadowSize);
      if (sun.shadow.map) {
        // Force the shadow target to be rebuilt at the new size
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    const touchOn = this.ctx.platform.touch;
    if (touchOn !== this.hudTouch) {
      this.hudTouch = touchOn;
      this.hud.root.classList.toggle('touch', touchOn);
    }
  }

  /**
   * Crew physiology: sustained "eyeballs-down" acceleration drains blood from the
   * head — vision greys out around 5–6 g and blacks out near 9 g. Trained crews
   * lying on their backs (eyeballs-in, as in a capsule) tolerate more, so the
   * effect builds over a couple of seconds rather than instantly.
   */
  private updateGStress(dt: number): void {
    const v = this.sim.active;
    const crewed = v.hasCrew && !v.destroyed && !v.pinned;
    const target = crewed ? clamp((v.gForce - 4.5) / 5, 0, 1) : 0;
    const tau = target > this.gStress ? 2.5 : 0.8;
    this.gStress += (target - this.gStress) * (1 - Math.exp(-dt / tau));
    this.greyEl.style.opacity = (this.gStress * 0.92).toFixed(3);
    if (crewed && v.gForce > 7 && this.gStress > 0.35 && !this.highGCalled) {
      this.highGCalled = true;
      this.radio.trigger({ on: 'highg' });
    }
  }

  /** Re-entry heat tint, screen flash decay, master alarm and sonic booms. */
  private updateScreenEffects(v: Vessel, dt: number): void {
    // Plasma glow creeping in from the edges during re-entry
    const heat = this.mapMode ? 0 : clamp((v.heatFlux - 2.5e5) / 1.8e6, 0, 0.7);
    this.heatEl.style.opacity = heat.toFixed(3);
    // Flash from nearby explosions
    this.flashLevel *= Math.exp(-dt * 6);
    this.flashEl.style.opacity = (this.mapMode ? 0 : this.flashLevel).toFixed(3);
    // Master alarm: airframe heat, aerodynamic overload or crew g-load
    let skinHeat = 0;
    for (const p of v.parts) if (!p.isEngine) skinHeat = Math.max(skinHeat, (p.temperature - 288) / Math.max(1, p.def.maxTemp - 288));
    let warn = '';
    if (!v.destroyed && !v.pinned) {
      if (skinHeat > 0.72) warn = 'Heat warning';
      else if (v.aeroLoad > AERO_BREAKUP_LOAD * 0.7) warn = 'Structural load';
      else if (v.hasCrew && v.gForce > 8) warn = 'Crew g-load';
    }
    this.hud.setWarning(warn);
    this.ctx.audio.updateAlarm(!!warn && !this.sim.paused, dt);
    // Sonic boom when the shock passes (either direction through Mach 1)
    const m = v.mach;
    if (v.airDensity > 0.03 && ((this.prevMach < 1 && m >= 1) || (this.prevMach > 1 && m <= 1)) && this.prevMach > 0) {
      const dist = this.mapMode ? 1e6 : this.camera.distance;
      this.ctx.audio.sonicBoom(dist);
      this.camera.kick(0.35 / (1 + dist / 2000));
    }
    this.prevMach = m;
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
    if (this.ctx.platform.touch && h < 600) return Math.round(clamp(h * 0.27, 90, 150));
    return Math.round(clamp(h * 0.2, 150, 230));
  }

  private checkMilestones(): void {
    const v = this.sim.active;
    if (!this.maxQCalled && v.dynamicPressure > 8_000 && v.maxQ > v.dynamicPressure * 1.02 && v.verticalSpeed > 0) {
      this.maxQCalled = true;
      this.hud.showToast('Max Q', `${(v.maxQ / 1000).toFixed(1)} kPa`, 3);
      this.hud.logEvent(this.sim.missionTime, `Max Q: ${(v.maxQ / 1000).toFixed(1)} kPa`);
      this.ctx.audio.say('Max Q', 'maxq');
      this.radio.trigger({ on: 'maxq' });
    }
    if (!this.orbitCalled && v.situation === 'orbiting' && v.body.id === this.params.site.body) {
      this.orbitCalled = true;
      this.hud.showToast('Orbit achieved', '', 4);
      this.ctx.platform.haptic('success');
      this.hud.logEvent(this.sim.missionTime, 'Stable orbit achieved', 'good');
      this.ctx.audio.say('Orbit achieved. Nice work.', 'orbit');
      this.radio.trigger({ on: 'orbit' });
    }
  }

  private handleEvent(e: FlightEvent): void {
    const met = this.sim.missionTime;
    const active = e.vessel === this.sim.active;
    const air = e.vessel.airDensity > 1e-4;
    switch (e.kind) {
      case 'liftoff':
        this.ctx.platform.haptic('heavy');
        this.hud.showToast('Liftoff', this.params.craft.name, 3);
        this.hud.logEvent(met, 'Liftoff!', 'good');
        this.ctx.audio.say('Liftoff! We have liftoff.', 'liftoff');
        this.radio.trigger({ on: 'liftoff' });
        break;
      case 'stage':
        if (active) {
          this.hud.logEvent(met, e.message);
          this.ctx.audio.stageSep(air);
        }
        break;
      case 'ignition':
        this.effects.onEvent(e, this.cameraAbs);
        if (active && !isNaN(this.sim.launchTime)) {
          this.ctx.audio.ignition();
          this.camera.kick(0.25);
          this.ctx.platform.haptic('light');
        }
        break;
      case 'decouple':
        if (active) {
          this.ctx.audio.say('Stage separation', 'sep', 8);
          this.camera.kick(0.4);
          this.ctx.platform.haptic('medium');
        }
        if (active && !this.stagedOnce && !isNaN(this.sim.launchTime)) {
          this.stagedOnce = true;
          this.radio.trigger({ on: 'staging' });
        }
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
          this.camera.kick(0.15);
        }
        break;
      case 'crash':
      case 'overheat':
      case 'breakup':
        this.hud.logEvent(met, e.message, 'bad');
        this.effects.onEvent(e, this.cameraAbs);
        if (e.vessel === this.sim.active || !e.vessel.debris) {
          this.ctx.audio.explosion(true);
          this.ctx.platform.haptic('error');
          // Blast felt by the camera: jolt and a flash that fade with distance
          const d = Math.max(20, e.vessel.absolutePosition(_tmp).distanceTo(this.cameraAbs));
          this.camera.kick(Math.min(2.5, 400 / d));
          this.flashLevel = Math.min(0.9, this.flashLevel + 250 / d);
        }
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
          this.radio.trigger({ on: 'chute' });
        }
        break;
      case 'chute-torn':
        if (active) this.hud.logEvent(met, e.message, 'bad');
        break;
      case 'splashdown':
      case 'touchdown':
        this.effects.onEvent(e, this.cameraAbs);
        if (active) {
          this.hud.logEvent(met, e.message, 'good');
          if (e.kind === 'splashdown') this.ctx.audio.splash();
          else this.ctx.audio.thud();
          this.camera.kick(Math.min(2, 0.3 + (e.speed ?? 0) / 4));
          this.ctx.platform.haptic('medium');
        }
        break;
      case 'landed':
        if (active) {
          this.hud.showToast(e.message, '', 4);
          this.ctx.audio.say(e.vessel.body.id === 'earth' ? (e.vessel.inWater ? 'Splashdown' : 'Touchdown') : 'Contact light. Engine stop.', 'landed');
          this.radio.trigger({ on: 'landed', body: e.vessel.body.id });
        }
        break;
      case 'soi-change':
        if (active) {
          this.hud.showToast(e.vessel.body.name, e.message, 4);
          this.hud.logEvent(met, e.message, 'good');
          this.radio.onSoi(e.vessel.body.id);
        }
        break;
      case 'no-ignitions':
        if (active) this.hud.logEvent(met, e.message, 'bad');
        break;
      case 'docked':
        if (active) {
          // The port we were looking out of is now closed: back to the outside view,
          // and port alignment has nothing left to align to
          if (this.camera.mode === 'dock') this.camera.mode = 'chase';
          if (e.vessel.controls.sasMode === 'port') e.vessel.controls.sasMode = 'stability';
          this.hud.showToast('Hard dock', e.message, 4);
          this.hud.logEvent(met, e.message, 'good');
          this.ctx.audio.thud();
          this.camera.kick(0.3);
          this.ctx.platform.haptic('medium');
          this.radio.trigger({ on: 'docked' });
          this.refreshStageInfo();
        }
        break;
      case 'undocked':
        if (active) {
          this.hud.showToast('Undocked', e.message, 3);
          this.hud.logEvent(met, e.message);
          this.ctx.audio.stageSep(false);
          this.radio.trigger({ on: 'undocked' });
          this.refreshStageInfo();
        }
        break;
      case 'switch':
        this.hud.showToast('Now flying', e.vessel.name, 2.5);
        this.hud.logEvent(met, e.message);
        this.camera.targetDistance = Math.max(12, e.vessel.length * 1.6);
        this.camera.minDistance = Math.max(2, e.vessel.boundingRadius * 0.6);
        this.refreshStageInfo();
        this.ctx.audio.click();
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

    // Vessel meshes were already placed for this camera in update() (the effects
    // need them there); nothing moved since, so no second pass
    ctx.space.update(camAbs, cam, this.realTime, ctx.renderer.pixelRatio);

    // Launch pad lights & crew arm
    if (this.pad) {
      const body = ctx.system.get(this.params.site.body);
      const up = _tmp.copy(this.pad.group.position).normalize().applyQuaternion(body.rotation);
      this.pad.update(up.dot(ctx.space.sunDir), this.frameDt, !isNaN(this.sim.launchTime));
    }

    this.updateDockLight(camAbs);

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

    // Environment map (re-rendered a few times a second; its parameters are only
    // computed when a refresh is actually due)
    if (ctx.env.due(this.frameDt)) ctx.space.scene.environment = ctx.env.render(this.envParams(v));
    else ctx.space.scene.environment = ctx.env.texture;

    this.mapView.render(camAbs);
    ctx.post.render(ctx.space.scene, cam, ctx.space.atmFrame, ctx.space.compFrame);

    // Navball overlay. three.js viewports are in CSS pixels (it applies the pixel
    // ratio itself) with the origin at the bottom-left of the canvas.
    const b = this.ballRect;
    if (b.size > 0) this.navball.render(ctx.renderer.gl, b.x, b.y, b.size);
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
    if (this.persistOnExit) this.persistVessels();
    // "Keep flying" after success can still earn bonus stars; and a flight left
    // within seconds of success (before the debrief appeared) still counts as done
    const m = this.mission;
    if (m && m.status === 'success') {
      const stars = m.finalize(this.sim);
      const camp = this.ctx.save.campaign;
      let changed = false;
      if (!camp.completed.includes(m.def.id)) {
        camp.completed.push(m.def.id);
        changed = true;
      }
      if (stars > (camp.scores[m.def.id] ?? 0)) {
        camp.scores[m.def.id] = stars;
        changed = true;
      }
      if (changed) writeSave(this.ctx.save);
    }
    const scene = this.ctx.space.scene;
    for (const view of this.views.values()) {
      scene.remove(view.group);
      view.dispose();
    }
    this.views.clear();
    for (const fm of this.fairingMeshes.values()) {
      scene.remove(fm);
      fm.geometry.dispose();
    }
    this.fairingMeshes.clear();
    scene.remove(this.effects.particles.smokeMesh, this.effects.particles.glowMesh, this.effects.engineLight, this.effects.flash);
    scene.remove(this.dockLight, this.dockLightTarget);
    this.dockLight.dispose();
    this.effects.particles.dispose();
    if (this.pad) this.pad.dispose();
    this.navball.dispose();
    this.ctx.audio.cancelSpeech();
    this.ctx.audio.resetCallouts();
    this.hud.root.remove();
    this.touch.dispose();
    this.radioFeed.dispose();
    this.greyEl.remove();
    this.heatEl.remove();
    this.flashEl.remove();
    this.ctx.audio.updateAlarm(false, 0);
    this.unbindBack();
    this.mapView.dispose();
    this.unbindKey();
    this.ctx.audio.silenceFlight();
    this.ctx.space.sunLight.castShadow = false;
    this.ctx.space.hemi.visible = true;
    scene.environment = null;
  }
}
