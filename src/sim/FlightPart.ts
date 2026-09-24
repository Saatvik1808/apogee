/**
 * LEARNING NOTE: Runtime state vs. design data
 *
 * In the assembly building a part is pure DESIGN data (what it is). Once it flies
 * it also carries STATE: how much propellant is left, whether the engine is lit
 * and how far it has spooled up, how hot its skin is, whether its parachute is
 * packed or open. Keeping the two separate means the design can be reloaded and
 * relaunched from scratch at any time ("revert to launch").
 *
 * Key concepts: separation of static definitions and mutable runtime state
 */
import { Quaternion, Vector3 } from 'three';
import type { AttachKind } from '../parts/Craft';
import type { PartConfig, PartDef, PartStats } from '../parts/PartCatalog';
import type { PropellantId } from '../parts/Propellants';

export type ChuteState = 'stowed' | 'armed' | 'semi' | 'full' | 'cut';

export class FlightPart {
  /** Unique within its vessel (renumbered when two vessels dock). */
  uid: number;
  readonly def: PartDef;
  readonly config: PartConfig;
  readonly stats: PartStats;
  parent: FlightPart | null = null;
  readonly children: FlightPart[] = [];
  attach: AttachKind;
  angle: number;
  offsetY: number;
  symmetry: number;
  /** Centre position in the vessel frame. */
  readonly position = new Vector3();
  /** Part orientation relative to the vessel frame. */
  readonly rotation = new Quaternion();
  stage: number;

  // --- resources --------------------------------------------------------------
  propellant: PropellantId | null;
  fuel: number;
  fuelCapacity: number;
  /** Fuel-flow group (section id); recomputed after staging. */
  group = 0;

  // --- engine -----------------------------------------------------------------
  isEngine: boolean;
  isSolid: boolean;
  engineIgnited = false;
  /** Current spooled throttle 0..1 (fraction of max thrust). */
  engineThrottle = 0;
  /** Commanded throttle after min-throttle clamping. */
  engineTarget = 0;
  engineRunning = false;
  flameout = false;
  ignitionsLeft: number;
  /** Current gimbal deflection as tangent components in the part frame (x, z). */
  gimbalX = 0;
  gimbalZ = 0;
  /** Thrust currently produced (N) — visuals & telemetry. */
  thrust = 0;
  /** Mass flow this step (kg/s). */
  massFlow = 0;

  // --- thermal ----------------------------------------------------------------
  temperature = 288;
  ablator: number;
  /** Heat flux reaching the part this step (W/m²) — visuals. */
  heatFlux = 0;

  // --- mechanisms -------------------------------------------------------------
  chuteState: ChuteState = 'stowed';
  /** 0..1 canopy inflation. */
  chuteDeploy = 0;
  legsDeployed = false;
  legDeploy = 0;
  solarDeploy = 0;
  fairingAttached: boolean;
  /** Inside an attached fairing (no aero, no heating). */
  shielded = false;
  destroyed = false;
  /** Visual hint: interstage shell carried by a stack decoupler (set by the renderer). */
  interstage: { radius: number; height: number } | null = null;

  // --- docking ----------------------------------------------------------------
  /** Partner port while docked. */
  dockedTo: FlightPart | null = null;
  /** Root of the docked vessel's part subtree — the split point for undocking. */
  dockRoot: FlightPart | null = null;
  /** Name of the vessel this part was the root of before it docked (restored on undock). */
  vesselName: string | null = null;

  constructor(
    uid: number,
    def: PartDef,
    config: PartConfig,
    stats: PartStats,
    attach: AttachKind,
    stage: number,
  ) {
    this.uid = uid;
    this.def = def;
    this.config = config;
    this.stats = stats;
    this.attach = attach;
    this.angle = 0;
    this.offsetY = 0;
    this.symmetry = 0;
    this.stage = stage;
    this.propellant = stats.propellant && stats.propellantCapacity > 0 ? stats.propellant : null;
    this.fuel = stats.propellantCapacity;
    this.fuelCapacity = stats.propellantCapacity;
    this.isEngine = def.shape === 'engine' || def.shape === 'srb';
    this.isSolid = def.shape === 'srb';
    this.ignitionsLeft = def.engine ? def.engine.ignitions : 1;
    this.ablator = stats.ablator;
    this.fairingAttached = !!def.fairing;
  }

  /** Current total mass (dry + propellant + remaining ablator already in dryMass). */
  get mass(): number {
    const ablatorSpent = this.stats.ablator - this.ablator;
    return this.stats.dryMass - ablatorSpent + this.fuel - (this.fairingAttached ? 0 : this.fairingShellMass);
  }

  get fairingShellMass(): number {
    if (!this.def.fairing) return 0;
    return Math.max(0, this.stats.dryMass - 60 * this.fairingDiameter);
  }

  get radius(): number {
    return Math.max(this.stats.diameterTop, this.stats.diameterBottom, 0.2) / 2;
  }

  get height(): number {
    return this.stats.height;
  }

  get fairingLength(): number {
    return this.config.length ?? 0;
  }

  get fairingDiameter(): number {
    return this.config.diameter ?? this.def.diameter;
  }
}
