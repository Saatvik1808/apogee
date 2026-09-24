/**
 * LEARNING NOTE: Data-driven part design
 *
 * Every rocket component is described by DATA, not code: dimensions, mass,
 * engine performance, crash tolerance, and which "modules" it carries (engine,
 * tank, decoupler, parachute...). Gameplay systems read these modules; the renderer
 * builds geometry from the same numbers. Adding a new engine is one table entry.
 *
 * Many parts are *configurable* (tank length & propellant, engine cluster count,
 * decoupler diameter). Derived stats are computed by pure functions from the
 * definition + configuration, so the assembly building, the flight simulation and
 * the delta-v calculator always agree.
 *
 * Engine numbers are modelled on real hardware (Merlin 1D, F-1, RS-25, Raptor 2,
 * RL-10, the Apollo LM descent engine...) under fictional names.
 *
 * Key concepts: data-driven design, component modules, derived properties,
 * engine clustering
 */
import { DEG } from '../core/constants';
import { PROPELLANTS, type PropellantId } from './Propellants';

export type PartCategory = 'command' | 'tanks' | 'engines' | 'boosters' | 'coupling' | 'structural' | 'aero' | 'recovery' | 'utility';

export type PartShape =
  | 'capsule'
  | 'probe'
  | 'ring'
  | 'tank'
  | 'engine'
  | 'srb'
  | 'decoupler'
  | 'radial-decoupler'
  | 'adapter'
  | 'nosecone'
  | 'fairing'
  | 'fin'
  | 'heatshield'
  | 'parachute'
  | 'radial-chute'
  | 'leg'
  | 'tube'
  | 'solar'
  | 'dock'
  | 'rcs'
  | 'cabin'
  | 'airbrake'
  | 'truss';

export type PlumeStyle = 'kerolox' | 'hydrolox' | 'methalox' | 'hypergolic' | 'solid';

export interface EngineSpec {
  propellant: PropellantId;
  /** Vacuum thrust per engine (N). */
  thrustVac: number;
  ispVac: number;
  ispSL: number;
  /** Max gimbal deflection (rad). */
  gimbal: number;
  minThrottle: number;
  /** Number of ignitions available (Infinity = unlimited). */
  ignitions: number;
  /** Spool-up time constant (s). */
  spool: number;
  /** Nozzle exit diameter (m). */
  nozzleExit: number;
  /** Length of one engine incl. nozzle (m). */
  length: number;
  /** Mass of one engine (kg). */
  mass: number;
  /** Visual combustion chambers per engine (RD-180 style twin nozzles). */
  chambers: number;
  plume: PlumeStyle;
  cost: number;
  /** Nozzle geometry: bell (default), linear aerospike, or nuclear-thermal (reactor + bell). */
  style?: 'bell' | 'spike' | 'nuclear';
}

export interface SolidSpec {
  propellantMass: number;
  thrustSL: number;
  ispSL: number;
  ispVac: number;
  gimbal: number;
  nozzleExit: number;
}

export interface ParachuteSpec {
  /** Canopy diameter (m) of a single canopy. */
  canopy: number;
  cd: number;
  /** Full-deploy altitude above terrain (m). */
  deployAltitude: number;
  /** Semi-deploy when static pressure exceeds (Pa). */
  semiPressure: number;
  /** Dynamic pressure at which the canopy tears (Pa). */
  maxQ: number;
  drogue: boolean;
}

export interface PartConfigSchema {
  diameter?: number[];
  diameterBottom?: number[];
  /** [min, max, step] in metres. */
  length?: [number, number, number];
  propellant?: boolean;
  cluster?: number[];
  thrustLimit?: boolean;
  canopies?: number[];
  /** Partial propellant load (0–100 %). */
  fill?: boolean;
  /** Decoupler: propellant may flow across it (asparagus / onion staging). */
  crossfeed?: boolean;
}

export interface PartDef {
  id: string;
  name: string;
  category: PartCategory;
  shape: PartShape;
  description: string;
  cost: number;
  /** Default attach (top) diameter (m). */
  diameter: number;
  /** Bottom diameter for adapters/capsules (m). */
  diameterBottom?: number;
  /** Default height (m). */
  height: number;
  dryMass: number;
  crashTolerance: number;
  maxTemp: number;
  stackTop: boolean;
  stackBottom: boolean;
  radialMount: boolean;
  allowRadialChildren: boolean;
  configurable?: PartConfigSchema;
  command?: { crew: number; torque: number };
  tank?: { fillFactor: number };
  engine?: EngineSpec;
  solid?: SolidSpec;
  decoupler?: { radial: boolean; separationDv: number };
  parachute?: ParachuteSpec;
  heatShield?: { ablatorPerM2: number };
  legs?: { length: number };
  /** `control`: maximum deflection (rad) of a movable fin (control surface). */
  fin?: { area: number; span: number; chord: number; control?: number };
  /** Deployable drag plate: flat-plate area (m²) and drag coefficient when open. */
  airbrake?: { area: number; cd: number };
  /** Passenger cabin (crew but no controls). */
  cabin?: { crew: number };
  reactionWheel?: { torquePerM2: number };
  fairing?: boolean;
  /** Androgynous docking ring: two free faces that meet slowly latch the vessels together. */
  dock?: { size: number };
  /** Reaction-control thruster block: total thrust (N), Isp (s) and its own propellant load (kg). */
  rcs?: { thrust: number; isp: number; propellant: number };
  /** Minimum campaign tier needed (0 = start). */
  tier: number;
}

export interface PartConfig {
  diameter?: number;
  diameterBottom?: number;
  length?: number;
  propellant?: PropellantId;
  cluster?: number;
  thrustLimit?: number;
  canopies?: number;
  /** Fraction of the propellant capacity loaded at launch (default 1). */
  fill?: number;
  /** Engine gimbal locked (fixed nozzle). */
  gimbalLock?: boolean;
  /** Parachute: altitude above the ground (m) at which it opens fully. */
  deployAlt?: number;
  /** Action groups (1–10) this part responds to. */
  groups?: number[];
  /** Decoupler: let propellant flow across it; the far side drains first. */
  crossfeed?: boolean;
  /** Placement tweak: translation (m) in the attach frame (radial parts: x out, y along the parent axis, z around it). */
  offset?: [number, number, number];
  /** Placement tweak: rotation (degrees) about the part's own x, y and z axes. */
  rot?: [number, number, number];
}

const SIZES = [0.625, 1.25, 2.5, 3.75, 5, 7.5, 10];

function engine(
  id: string,
  name: string,
  description: string,
  e: Omit<EngineSpec, 'chambers' | 'spool' | 'plume'> & { chambers?: number; spool?: number },
  cluster: number[],
  tier: number,
): PartDef {
  const spec: EngineSpec = {
    ...e,
    chambers: e.chambers ?? 1,
    spool: e.spool ?? 0.6,
    plume: e.propellant === 'monoprop' || e.propellant === 'solid' ? 'hypergolic' : e.propellant === 'lh2' ? 'hydrolox' : e.propellant,
  };
  return {
    id,
    name,
    category: 'engines',
    shape: 'engine',
    description,
    cost: e.cost,
    diameter: Math.max(0.6, e.nozzleExit * 1.05),
    height: e.length + 0.25,
    dryMass: e.mass,
    crashTolerance: 9,
    maxTemp: 2400,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: false,
    configurable: { cluster, thrustLimit: true },
    engine: spec,
    tier,
  };
}

export const PART_DEFS: PartDef[] = [
  // --------------------------------------------------------------- COMMAND
  {
    id: 'probe-sentinel',
    name: 'Sentinel Probe Core',
    category: 'command',
    shape: 'probe',
    description: 'Compact avionics + reaction wheels. Flies uncrewed payloads and sounding rockets.',
    cost: 1_200_000,
    diameter: 1.25,
    height: 0.5,
    dryMass: 120,
    crashTolerance: 12,
    maxTemp: 1400,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    command: { crew: 0, torque: 2_500 },
    tier: 0,
  },
  {
    id: 'probe-mite',
    name: 'Mite Probe Core',
    category: 'command',
    shape: 'probe',
    description: 'Tiny 0.625 m avionics puck for micro-satellites, landers and test vehicles. Can also be mounted on the side of a stack.',
    cost: 450_000,
    diameter: 0.625,
    height: 0.3,
    dryMass: 40,
    crashTolerance: 12,
    maxTemp: 1400,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    command: { crew: 0, torque: 450 },
    tier: 0,
  },
  {
    id: 'capsule-swift',
    name: 'Swift Capsule',
    category: 'command',
    shape: 'capsule',
    description: 'One-seat capsule in the spirit of Mercury: light enough for a small launcher. Needs a heat shield and a parachute to come home.',
    cost: 12_000_000,
    diameter: 0.7,
    diameterBottom: 1.25,
    height: 1.9,
    dryMass: 1_350,
    crashTolerance: 14,
    maxTemp: 1850,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    command: { crew: 1, torque: 5_000 },
    tier: 1,
  },
  {
    id: 'ring-atlas',
    name: 'Atlas Guidance Ring',
    category: 'command',
    shape: 'ring',
    description: 'Heavy guidance unit with large reaction wheels for big uncrewed stacks. Diameter adapts to the stack.',
    cost: 4_000_000,
    diameter: 3.75,
    height: 0.7,
    dryMass: 450,
    crashTolerance: 10,
    maxTemp: 1400,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { diameter: [2.5, 3.75, 5, 7.5, 10] },
    command: { crew: 0, torque: 9_000 },
    tier: 2,
  },
  {
    id: 'capsule-kestrel',
    name: 'Kestrel Capsule',
    category: 'command',
    shape: 'capsule',
    description: 'Two-seat orbital capsule. Blunt-body shape flies stably heat-shield first. Needs a heat shield and parachutes to come home.',
    cost: 28_000_000,
    diameter: 1.0,
    diameterBottom: 2.5,
    height: 2.4,
    dryMass: 2_900,
    crashTolerance: 14,
    maxTemp: 1900,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    command: { crew: 2, torque: 14_000 },
    tier: 1,
  },
  {
    id: 'capsule-condor',
    name: 'Condor Capsule',
    category: 'command',
    shape: 'capsule',
    description: 'Three-seat deep-space command module sized for lunar missions. Rated for 11 km/s re-entry with a proper heat shield.',
    cost: 65_000_000,
    diameter: 1.1,
    diameterBottom: 3.75,
    height: 3.3,
    dryMass: 5_300,
    crashTolerance: 14,
    maxTemp: 2000,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    command: { crew: 3, torque: 30_000 },
    tier: 3,
  },

  // --------------------------------------------------------------- TANKS
  ...SIZES.map((d, i): PartDef => ({
    id: `tank-${Math.round(d * 100)}`,
    name: `Propellant Tank ${d} m`,
    category: 'tanks',
    shape: 'tank',
    description: `${d} m diameter tank. Adjust length and propellant in the inspector (right-click).`,
    cost: 0,
    diameter: d,
    height: d * 2,
    dryMass: 0,
    crashTolerance: 8,
    maxTemp: 1300,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { length: [Math.max(0.5, d * 0.4), d * 9, d < 3 ? 0.25 : 0.5], propellant: true, fill: true },
    tank: { fillFactor: 0.92 },
    tier: d <= 2.5 ? 0 : d <= 5 ? 2 : 3,
  })),

  // --------------------------------------------------------------- ENGINES
  engine('eng-rotor', 'Rotor-1', 'Electric-pump kerolox engine for small launchers. Cheap, light, restartable.', {
    propellant: 'kerolox', thrustVac: 25_800, ispVac: 333, ispSL: 303, gimbal: 5 * DEG, minThrottle: 0.3,
    ignitions: 3, nozzleExit: 0.33, length: 0.9, mass: 35, cost: 300_000,
  }, [1, 3, 5, 7, 9], 0),
  engine('eng-rotor-vac', 'Rotor-1 Vac', 'Vacuum-optimised Rotor with a large nozzle. Poor at sea level.', {
    propellant: 'kerolox', thrustVac: 25_800, ispVac: 343, ispSL: 150, gimbal: 3 * DEG, minThrottle: 0.3,
    ignitions: 6, nozzleExit: 0.62, length: 1.15, mass: 40, cost: 380_000,
  }, [1], 0),
  engine('eng-hawk', 'Hawk-1D', 'Workhorse gas-generator kerolox engine. Deep throttling, multiple restarts. Cluster nine for a medium launcher.', {
    propellant: 'kerolox', thrustVac: 934_000, ispVac: 311, ispSL: 282, gimbal: 5 * DEG, minThrottle: 0.4,
    ignitions: 4, nozzleExit: 0.92, length: 2.4, mass: 470, cost: 1_000_000,
  }, [1, 2, 3, 4, 5, 7, 9], 1),
  engine('eng-hawk-vac', 'Hawk-1D Vac', 'Upper-stage Hawk with a huge niobium nozzle extension. Do not fire at sea level.', {
    propellant: 'kerolox', thrustVac: 981_000, ispVac: 348, ispSL: 100, gimbal: 4 * DEG, minThrottle: 0.39,
    ignitions: 5, nozzleExit: 3.3, length: 4.4, mass: 490, cost: 1_400_000,
  }, [1], 1),
  engine('eng-titan', 'Titan F-1', 'The giant. 7.7 MN from one chamber. No throttle, one ignition — light it and hold on.', {
    propellant: 'kerolox', thrustVac: 7_770_000, ispVac: 304, ispSL: 263, gimbal: 6 * DEG, minThrottle: 1,
    ignitions: 1, nozzleExit: 3.7, length: 5.8, mass: 8_400, cost: 14_000_000, spool: 1.2,
  }, [1, 2, 3, 4, 5, 7], 3),
  engine('eng-volga', 'Volga RD-180', 'Twin-chamber staged-combustion kerolox engine. Excellent Isp for a first stage.', {
    propellant: 'kerolox', thrustVac: 4_150_000, ispVac: 338, ispSL: 311, gimbal: 8 * DEG, minThrottle: 0.47,
    ignitions: 1, nozzleExit: 1.45, length: 3.6, mass: 5_480, cost: 11_000_000, chambers: 2,
  }, [1, 2, 3], 2),
  engine('eng-ember', 'Ember R2', 'Full-flow methalox engine. Enormous chamber pressure, reusable, wide gimbal.', {
    propellant: 'methalox', thrustVac: 2_415_000, ispVac: 350, ispSL: 327, gimbal: 15 * DEG, minThrottle: 0.4,
    ignitions: 6, nozzleExit: 1.3, length: 3.1, mass: 1_630, cost: 1_000_000,
  }, [1, 3, 4, 6, 7, 9, 13], 3),
  engine('eng-ember-vac', 'Ember R2 Vac', 'Vacuum Ember. The highest-Isp dense-propellant engine in the catalogue.', {
    propellant: 'methalox', thrustVac: 2_530_000, ispVac: 380, ispSL: 150, gimbal: 2 * DEG, minThrottle: 0.4,
    ignitions: 6, nozzleExit: 2.4, length: 4.6, mass: 2_100, cost: 1_500_000,
  }, [1, 3], 3),
  engine('eng-aurora', 'Aurora RS-25', 'Staged-combustion hydrolox main engine. Superb Isp at sea level and in vacuum — and superbly expensive.', {
    propellant: 'hydrolox', thrustVac: 2_279_000, ispVac: 452, ispSL: 366, gimbal: 10.5 * DEG, minThrottle: 0.67,
    ignitions: 1, nozzleExit: 2.3, length: 4.3, mass: 3_527, cost: 40_000_000,
  }, [1, 2, 3, 4], 3),
  engine('eng-vega', 'Vega J-2X', 'Restartable hydrolox upper-stage engine. The classic trans-lunar injection motor.', {
    propellant: 'hydrolox', thrustVac: 1_310_000, ispVac: 448, ispSL: 200, gimbal: 7 * DEG, minThrottle: 0.8,
    ignitions: 3, nozzleExit: 3.05, length: 4.7, mass: 2_470, cost: 20_000_000,
  }, [1, 2, 3, 4, 5, 7, 9], 2),
  engine('eng-wren', 'Wren RL-10', 'Tiny, efficient expander-cycle hydrolox engine with an extendable nozzle. Ideal for kick stages.', {
    propellant: 'hydrolox', thrustVac: 110_000, ispVac: 462, ispSL: 90, gimbal: 4 * DEG, minThrottle: 0.3,
    ignitions: 12, nozzleExit: 2.15, length: 4.15, mass: 300, cost: 17_000_000,
  }, [1, 2, 4], 2),
  engine('eng-moth', 'Moth Descent Engine', 'Deep-throttling hypergolic lander engine (10–100%). Built to hover over another world.', {
    propellant: 'hypergolic', thrustVac: 45_000, ispVac: 311, ispSL: 180, gimbal: 6 * DEG, minThrottle: 0.1,
    ignitions: 20, nozzleExit: 1.5, length: 2.1, mass: 180, cost: 8_000_000,
  }, [1, 2, 4], 3),
  engine('eng-kestrel-sps', 'Kestrel SPS', 'Service-propulsion engine: pressure-fed, fixed thrust, dozens of restarts. Orbit insertion and trans-Earth injection.', {
    propellant: 'hypergolic', thrustVac: 91_000, ispVac: 314, ispSL: 150, gimbal: 6 * DEG, minThrottle: 1,
    ignitions: 36, nozzleExit: 2.5, length: 3.9, mass: 300, cost: 10_000_000,
  }, [1], 1),
  engine('eng-lark', 'Lark Ascent Engine', 'Ultra-reliable fixed hypergolic motor for lunar ascent stages.', {
    propellant: 'hypergolic', thrustVac: 16_000, ispVac: 311, ispSL: 170, gimbal: 0, minThrottle: 1,
    ignitions: 10, nozzleExit: 0.9, length: 1.3, mass: 90, cost: 5_000_000,
  }, [1, 2], 3),
  engine('eng-gnat', 'Gnat-2', 'Micro hypergolic engine for 0.625 m stacks: probes, kick stages and small landers. Deep throttling and plenty of restarts.', {
    propellant: 'hypergolic', thrustVac: 18_000, ispVac: 318, ispSL: 250, gimbal: 4 * DEG, minThrottle: 0.1,
    ignitions: 25, nozzleExit: 0.42, length: 0.75, mass: 55, cost: 700_000,
  }, [1, 2, 3, 4], 1),
  engine('eng-puff', 'Puff Thruster', 'Monopropellant hydrazine thruster. Weak and thirsty, but it drinks the same tanks as the RCS and never runs out of restarts.', {
    propellant: 'monoprop', thrustVac: 9_000, ispVac: 235, ispSL: 120, gimbal: 0, minThrottle: 0.05,
    ignitions: Infinity, nozzleExit: 0.3, length: 0.55, mass: 30, cost: 250_000, spool: 0.15,
  }, [1, 2, 4], 1),
  engine('eng-atom', 'Atom NTR', 'Nuclear thermal rocket: a fission reactor heats pure liquid hydrogen to 2,500 K. Twice the Isp of any chemical engine — but heavy, weak and slow to warm up. For upper stages and interplanetary tugs; feed it LH2 tanks.', {
    propellant: 'lh2', thrustVac: 333_000, ispVac: 850, ispSL: 185, gimbal: 3 * DEG, minThrottle: 0.3,
    ignitions: 12, nozzleExit: 1.4, length: 6.4, mass: 9_500, cost: 45_000_000, spool: 4, style: 'nuclear',
  }, [1, 2, 3], 3),
  engine('eng-spike', 'Spike Aerospike', 'Linear aerospike: the open plume adapts to the outside pressure, so it stays efficient from sea level to vacuum. Made for single-stage-to-orbit dreams.', {
    propellant: 'hydrolox', thrustVac: 1_020_000, ispVac: 436, ispSL: 365, gimbal: 5 * DEG, minThrottle: 0.4,
    ignitions: 4, nozzleExit: 2.3, length: 2.2, mass: 3_000, cost: 24_000_000, style: 'spike',
  }, [1, 2, 3], 3),

  // --------------------------------------------------------------- SOLID BOOSTERS
  {
    id: 'srb-pip',
    name: 'Pip SRB',
    category: 'boosters',
    shape: 'srb',
    description: 'Sounding-rocket motor. 5 t of propellant, ~60 s burn — enough to punch through the Kármán line.',
    cost: 700_000,
    diameter: 1.25,
    height: 5,
    dryMass: 800,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { thrustLimit: true },
    solid: { propellantMass: 5_000, thrustSL: 190_000, ispSL: 228, ispVac: 252, gimbal: 0, nozzleExit: 0.7 },
    tier: 0,
  },
  {
    id: 'srb-spark',
    name: 'Spark SRB',
    category: 'boosters',
    shape: 'srb',
    description: 'Small solid booster. 14 t of propellant, ~66 s burn. Cannot be throttled or shut down.',
    cost: 2_000_000,
    diameter: 1.25,
    height: 9,
    dryMass: 1_900,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { thrustLimit: true },
    solid: { propellantMass: 14_000, thrustSL: 520_000, ispSL: 250, ispVac: 274, gimbal: 0, nozzleExit: 0.9 },
    tier: 0,
  },
  {
    id: 'srb-flare',
    name: 'Flare SRB',
    category: 'boosters',
    shape: 'srb',
    description: 'Medium solid booster with vectorable nozzle. 90 t of propellant, ~74 s burn.',
    cost: 12_000_000,
    diameter: 2.5,
    height: 21,
    dryMass: 9_000,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { thrustLimit: true },
    solid: { propellantMass: 90_000, thrustSL: 3_000_000, ispSL: 250, ispVac: 279, gimbal: 3 * DEG, nozzleExit: 1.8 },
    tier: 1,
  },
  {
    id: 'srb-thunder',
    name: 'Thunder SRB',
    category: 'boosters',
    shape: 'srb',
    description: 'Heavy four-segment booster: 500 t of propellant and 10 MN of thrust for two minutes.',
    cost: 40_000_000,
    diameter: 3.75,
    height: 45.5,
    dryMass: 87_000,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { thrustLimit: true },
    solid: { propellantMass: 500_000, thrustSL: 10_000_000, ispSL: 242, ispVac: 268, gimbal: 8 * DEG, nozzleExit: 3.8 },
    tier: 3,
  },

  // --------------------------------------------------------------- COUPLING
  {
    id: 'decoupler-stack',
    name: 'Stage Separator',
    category: 'coupling',
    shape: 'decoupler',
    description: 'Pyrotechnic interstage separator. Everything below it is jettisoned when it fires. Diameter adapts to the stack.',
    cost: 300_000,
    diameter: 2.5,
    height: 0.4,
    dryMass: 0,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { diameter: SIZES, crossfeed: true },
    decoupler: { radial: false, separationDv: 1.5 },
    tier: 0,
  },
  {
    id: 'decoupler-radial',
    name: 'Radial Separator',
    category: 'coupling',
    shape: 'radial-decoupler',
    description: 'Mounts boosters to the side of a core stage and pushes them clear when fired.',
    cost: 250_000,
    diameter: 0.6,
    height: 1.2,
    dryMass: 150,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { crossfeed: true },
    decoupler: { radial: true, separationDv: 4 },
    tier: 0,
  },
  {
    id: 'docking-port',
    name: 'Docking Port',
    category: 'coupling',
    shape: 'dock',
    description: 'Androgynous docking ring. Bring two ports face to face below ~1 m/s and the vessels latch into one; stage the port (or press Undock) to separate again.',
    cost: 900_000,
    diameter: 1.25,
    height: 0.3,
    dryMass: 90,
    crashTolerance: 10,
    maxTemp: 1400,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: false,
    configurable: { diameter: [1.25, 2.5] },
    dock: { size: 1 },
    tier: 2,
  },
  {
    id: 'adapter',
    name: 'Structural Adapter',
    category: 'structural',
    shape: 'adapter',
    description: 'Conical adapter between different stack diameters. Top matches the part above; set the bottom in the inspector.',
    cost: 150_000,
    diameter: 2.5,
    diameterBottom: 3.75,
    height: 1.5,
    dryMass: 0,
    crashTolerance: 8,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { diameter: SIZES, diameterBottom: SIZES },
    tier: 0,
  },
  {
    id: 'tube',
    name: 'Structural Tube',
    category: 'structural',
    shape: 'tube',
    description: 'Hollow structural spacer / interstage. Adjustable diameter and length.',
    cost: 80_000,
    diameter: 2.5,
    height: 2,
    dryMass: 0,
    crashTolerance: 10,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { diameter: SIZES, length: [0.5, 12, 0.25] },
    tier: 0,
  },
  {
    id: 'truss',
    name: 'Truss Segment',
    category: 'structural',
    shape: 'truss',
    description: 'Open lattice girder. Stack it, or hang it off the side of a tank for outriggers, station spines and lander frames. Almost no drag.',
    cost: 60_000,
    diameter: 1.25,
    height: 4,
    dryMass: 0,
    crashTolerance: 12,
    maxTemp: 1600,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { diameter: [0.625, 1.25, 2.5], length: [1, 20, 0.5] },
    tier: 0,
  },
  {
    id: 'reaction-wheel',
    name: 'Reaction Wheel Assembly',
    category: 'utility',
    shape: 'ring',
    description: 'Adds attitude-control torque without propellant. Diameter adapts to the stack.',
    cost: 900_000,
    diameter: 2.5,
    height: 0.45,
    dryMass: 0,
    crashTolerance: 10,
    maxTemp: 1400,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { diameter: SIZES },
    reactionWheel: { torquePerM2: 1_600 },
    tier: 1,
  },

  // --------------------------------------------------------------- AERO
  {
    id: 'nosecone',
    name: 'Ogive Nose Cone',
    category: 'aero',
    shape: 'nosecone',
    description: 'Streamlined nose. Cuts drag dramatically compared with a flat-topped stack.',
    cost: 60_000,
    diameter: 1.25,
    height: 2,
    dryMass: 0,
    crashTolerance: 8,
    maxTemp: 1600,
    stackTop: false,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { diameter: SIZES },
    tier: 0,
  },
  {
    id: 'fairing',
    name: 'Payload Fairing',
    category: 'aero',
    shape: 'fairing',
    description: 'Clamshell fairing that encloses the payload stacked on it. Jettison (stage) once above ~100 km.',
    cost: 5_000_000,
    diameter: 3.75,
    height: 0.35,
    dryMass: 0,
    crashTolerance: 8,
    maxTemp: 1600,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: false,
    configurable: { diameter: SIZES, length: [2, 40, 0.5] },
    fairing: true,
    tier: 1,
  },
  {
    id: 'fin-small',
    name: 'Stabilizer Fin',
    category: 'aero',
    shape: 'fin',
    description: 'Moves the centre of pressure aft so the rocket flies nose-first. Place in symmetry near the bottom.',
    cost: 40_000,
    diameter: 0.2,
    height: 1.6,
    dryMass: 60,
    crashTolerance: 10,
    maxTemp: 1600,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    fin: { area: 1.3, span: 1.2, chord: 1.6 },
    tier: 0,
  },
  {
    id: 'fin-large',
    name: 'Delta Fin',
    category: 'aero',
    shape: 'fin',
    description: 'Large swept fin for heavy vehicles.',
    cost: 150_000,
    diameter: 0.35,
    height: 3.6,
    dryMass: 260,
    crashTolerance: 10,
    maxTemp: 1600,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    fin: { area: 5.5, span: 2.6, chord: 3.6 },
    tier: 1,
  },
  {
    id: 'fin-control',
    name: 'Control Fin',
    category: 'aero',
    shape: 'fin',
    description: 'All-moving fin that steers in the atmosphere (±20°) with the pilot and SAS. Put a symmetric set near the tail — or near the nose as canards.',
    cost: 120_000,
    diameter: 0.2,
    height: 1.3,
    dryMass: 90,
    crashTolerance: 10,
    maxTemp: 1600,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    fin: { area: 1.0, span: 1.0, chord: 1.3, control: 20 * DEG },
    tier: 0,
  },
  {
    id: 'fin-control-large',
    name: 'Heavy Control Fin',
    category: 'aero',
    shape: 'fin',
    description: 'Big all-moving fin (±15°) for heavy boosters and returning first stages.',
    cost: 320_000,
    diameter: 0.3,
    height: 2.6,
    dryMass: 320,
    crashTolerance: 10,
    maxTemp: 1700,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    fin: { area: 3.6, span: 1.9, chord: 2.6, control: 15 * DEG },
    tier: 1,
  },
  {
    id: 'airbrake',
    name: 'Airbrake',
    category: 'aero',
    shape: 'airbrake',
    description: 'Hinged drag panel. Toggle with B (or an action group) to bleed off speed in the atmosphere: booster landings, re-entry and precise descents.',
    cost: 180_000,
    diameter: 0.2,
    height: 1.0,
    dryMass: 60,
    crashTolerance: 10,
    maxTemp: 1800,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    airbrake: { area: 1.1, cd: 1.3 },
    tier: 1,
  },
  {
    id: 'heatshield',
    name: 'Ablative Heat Shield',
    category: 'recovery',
    shape: 'heatshield',
    description: 'Ablator boils away to carry re-entry heat off the vehicle. Mandatory for returning from orbit — and even more from the Moon.',
    cost: 3_000_000,
    diameter: 2.5,
    height: 0.4,
    dryMass: 0,
    crashTolerance: 16,
    maxTemp: 3400,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: false,
    configurable: { diameter: [0.625, 1.25, 2.5, 3.75, 5] },
    heatShield: { ablatorPerM2: 55 },
    tier: 1,
  },

  // --------------------------------------------------------------- RECOVERY
  {
    id: 'chute-main',
    name: 'Main Parachute Pack',
    category: 'recovery',
    shape: 'parachute',
    description: 'Ringsail main canopies (25 m each). Arms when staged; opens fully below the deploy altitude.',
    cost: 800_000,
    diameter: 1.0,
    height: 0.7,
    dryMass: 60,
    crashTolerance: 12,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: false,
    allowRadialChildren: true,
    configurable: { canopies: [1, 2, 3] },
    parachute: { canopy: 25, cd: 0.8, deployAltitude: 3000, semiPressure: 20_000, maxQ: 11_000, drogue: false },
    tier: 0,
  },
  {
    id: 'chute-drogue',
    name: 'Drogue Parachute',
    category: 'recovery',
    shape: 'radial-chute',
    description: 'Small high-speed canopy that stabilises and slows a capsule before the mains open.',
    cost: 300_000,
    diameter: 0.45,
    height: 0.9,
    dryMass: 30,
    crashTolerance: 12,
    maxTemp: 1500,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    parachute: { canopy: 6.5, cd: 0.9, deployAltitude: 9000, semiPressure: 5_000, maxQ: 45_000, drogue: true },
    tier: 1,
  },
  {
    id: 'chute-radial',
    name: 'Radial Parachute',
    category: 'recovery',
    shape: 'radial-chute',
    description: 'Side-mounted 12 m canopy for probes and light stages.',
    cost: 250_000,
    diameter: 0.45,
    height: 1.1,
    dryMass: 40,
    crashTolerance: 12,
    maxTemp: 1500,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    parachute: { canopy: 12, cd: 0.8, deployAltitude: 1500, semiPressure: 20_000, maxQ: 9_000, drogue: false },
    tier: 0,
  },

  // --------------------------------------------------------------- UTILITY
  {
    id: 'hab-module',
    name: 'Habitat Module',
    category: 'utility',
    shape: 'cabin',
    description: 'Pressurised crew cabin with windows, for stations and big landers. Carries crew (4 at 2.5 m, 9 at 3.75 m) but cannot fly the vessel — add a command pod or probe core.',
    cost: 9_000_000,
    diameter: 2.5,
    height: 3.2,
    dryMass: 3_600,
    crashTolerance: 9,
    maxTemp: 1500,
    stackTop: true,
    stackBottom: true,
    radialMount: true,
    allowRadialChildren: true,
    configurable: { diameter: [2.5, 3.75] },
    cabin: { crew: 4 },
    tier: 2,
  },
  {
    id: 'leg-small',
    name: 'Landing Leg',
    category: 'utility',
    shape: 'leg',
    description: 'Shock-absorbing landing leg. Toggle with G. Use 3 or 4 in symmetry.',
    cost: 200_000,
    diameter: 0.3,
    height: 2.2,
    dryMass: 60,
    crashTolerance: 12,
    maxTemp: 1400,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    legs: { length: 2.4 },
    tier: 2,
  },
  {
    id: 'leg-large',
    name: 'Heavy Landing Leg',
    category: 'utility',
    shape: 'leg',
    description: 'Big crushable-honeycomb leg for crewed landers.',
    cost: 600_000,
    diameter: 0.45,
    height: 4.2,
    dryMass: 220,
    crashTolerance: 11,
    maxTemp: 1400,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    legs: { length: 4.6 },
    tier: 3,
  },
  {
    id: 'solar-panel',
    name: 'Solar Array',
    category: 'utility',
    shape: 'solar',
    description: 'Deploys automatically once out of the atmosphere. Looks fantastic in orbit.',
    cost: 400_000,
    diameter: 0.2,
    height: 1.0,
    dryMass: 45,
    crashTolerance: 6,
    maxTemp: 1200,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    tier: 1,
  },
  {
    id: 'rcs-quad',
    name: 'RCS Thruster Quad',
    category: 'utility',
    shape: 'rcs',
    description: 'Four small hydrazine thrusters for translation (H/N, I/K, J/L) and fine attitude control — the tool for docking. Carries 60 kg of its own propellant; toggle with R.',
    cost: 350_000,
    diameter: 0.35,
    height: 0.45,
    dryMass: 40,
    crashTolerance: 8,
    maxTemp: 1400,
    stackTop: false,
    stackBottom: false,
    radialMount: true,
    allowRadialChildren: false,
    rcs: { thrust: 400, isp: 240, propellant: 60 },
    tier: 2,
  },
];

export const PART_MAP: ReadonlyMap<string, PartDef> = new Map(PART_DEFS.map((p) => [p.id, p]));

export function getPartDef(id: string): PartDef {
  const d = PART_MAP.get(id);
  if (!d) throw new Error(`Unknown part ${id}`);
  return d;
}

export const CATEGORY_LABELS: Record<PartCategory, string> = {
  command: 'Command',
  tanks: 'Propellant',
  engines: 'Engines',
  boosters: 'Solid Boosters',
  coupling: 'Coupling',
  structural: 'Structural',
  aero: 'Aerodynamics',
  recovery: 'Recovery',
  utility: 'Utility',
};

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

export interface ClusterLayout {
  /** Nozzle centre offsets (x, z) within the mount (m). */
  offsets: Array<[number, number]>;
  mountDiameter: number;
}

export function clusterLayout(count: number, nozzle: number): ClusterLayout {
  const s = nozzle * 1.08;
  const offsets: Array<[number, number]> = [];
  const ring = (n: number, r: number, phase = 0) => {
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      offsets.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
  };
  let ringR = 0;
  switch (count) {
    case 1:
      offsets.push([0, 0]);
      break;
    case 2:
      offsets.push([-s / 2, 0], [s / 2, 0]);
      ringR = s / 2;
      break;
    case 3:
      ringR = s / Math.sqrt(3);
      ring(3, ringR, Math.PI / 2);
      break;
    case 4:
      ringR = s / Math.SQRT2;
      ring(4, ringR, Math.PI / 4);
      break;
    case 5:
      offsets.push([0, 0]);
      ringR = s * 1.02;
      ring(4, ringR, Math.PI / 4);
      break;
    case 6:
      ringR = s * 1.02;
      ring(6, ringR);
      break;
    case 7:
      offsets.push([0, 0]);
      ringR = s * 1.02;
      ring(6, ringR);
      break;
    case 9:
      offsets.push([0, 0]);
      ringR = (8 * s) / (2 * Math.PI) * 1.06;
      ring(8, ringR);
      break;
    case 13:
      offsets.push([0, 0]);
      ringR = (12 * s) / (2 * Math.PI) * 1.04;
      ring(12, ringR);
      break;
    default: {
      ringR = (count * s) / (2 * Math.PI) * 1.05;
      ring(count, ringR);
    }
  }
  const mountDiameter = Math.max(nozzle * 1.05, 2 * (ringR + nozzle / 2) * 1.04);
  return { offsets, mountDiameter };
}

export interface PartStats {
  /** Height along the stack axis (m). */
  height: number;
  diameterTop: number;
  diameterBottom: number;
  dryMass: number;
  /** Propellant capacity (kg) and type (tanks & SRBs). */
  propellant: PropellantId | null;
  propellantCapacity: number;
  cost: number;
  /** Engine data after cluster/limit configuration. */
  engineCount: number;
  thrustVac: number;
  thrustSL: number;
  ispVac: number;
  ispSL: number;
  /** Reaction/attitude torque (N·m). */
  torque: number;
  ablator: number;
  crew: number;
}

function num<T extends number>(v: T | undefined, d: T): T {
  return v === undefined || !isFinite(v) ? d : v;
}

export function defaultConfig(def: PartDef): PartConfig {
  const c: PartConfig = {};
  const s = def.configurable;
  if (!s) return c;
  if (s.diameter) c.diameter = def.diameter;
  if (s.diameterBottom) c.diameterBottom = def.diameterBottom ?? def.diameter;
  if (s.length) c.length = def.shape === 'fairing' ? Math.max(4, def.diameter * 2.2) : def.height;
  if (s.propellant) c.propellant = 'kerolox';
  if (s.cluster) c.cluster = 1;
  if (s.thrustLimit) c.thrustLimit = 1;
  if (s.canopies) c.canopies = def.id === 'chute-main' ? 2 : 1;
  return c;
}

/** Propellant actually loaded at launch: the capacity times the tweakable fill level. */
export function loadedPropellant(stats: PartStats, cfg: PartConfig): number {
  const f = cfg.fill;
  return stats.propellantCapacity * (f === undefined || !isFinite(f) ? 1 : Math.max(0, Math.min(1, f)));
}

/** Parts that respond to action groups (and what a group press does to them). */
export function actionKind(def: PartDef): 'engine' | 'decouple' | 'chute' | 'fairing' | 'legs' | 'solar' | 'brake' | 'dock' | null {
  if (def.shape === 'engine' || def.shape === 'srb') return 'engine';
  if (def.decoupler) return 'decouple';
  if (def.parachute) return 'chute';
  if (def.fairing) return 'fairing';
  if (def.legs) return 'legs';
  if (def.shape === 'solar') return 'solar';
  if (def.airbrake) return 'brake';
  if (def.dock) return 'dock';
  return null;
}

export function computePartStats(def: PartDef, cfg: PartConfig): PartStats {
  const st: PartStats = {
    height: def.height,
    diameterTop: def.diameter,
    diameterBottom: def.diameterBottom ?? def.diameter,
    dryMass: def.dryMass,
    propellant: null,
    propellantCapacity: 0,
    cost: def.cost,
    engineCount: 0,
    thrustVac: 0,
    thrustSL: 0,
    ispVac: 0,
    ispSL: 0,
    torque: def.command?.torque ?? 0,
    ablator: 0,
    crew: def.command?.crew ?? def.cabin?.crew ?? 0,
  };
  const d = num(cfg.diameter, def.diameter);
  switch (def.shape) {
    case 'tank': {
      const L = num(cfg.length, def.height);
      const prop = cfg.propellant ?? 'kerolox';
      const spec = PROPELLANTS[prop];
      const r = d / 2;
      const volume = Math.PI * r * r * L * (def.tank?.fillFactor ?? 0.92);
      st.height = L;
      st.diameterTop = st.diameterBottom = d;
      st.propellant = prop;
      st.propellantCapacity = volume * spec.density;
      // Square–cube law: large tanks need less structure per cubic metre
      const scale = Math.pow(2.5 / d, 0.35);
      st.dryMass = volume * spec.tankMassPerM3 * scale + 25 * d * d;
      st.cost = Math.round((volume * 9_000 + 60_000) * spec.costFactor);
      break;
    }
    case 'engine': {
      const e = def.engine!;
      const n = num(cfg.cluster, 1);
      const limit = num(cfg.thrustLimit, 1);
      const lay = clusterLayout(n, e.nozzleExit);
      st.engineCount = n;
      st.diameterTop = n === 1 ? Math.max(0.6, Math.min(e.nozzleExit * 0.75, 1.25)) : lay.mountDiameter;
      st.diameterBottom = lay.mountDiameter;
      st.height = e.length + (n > 1 ? 0.45 : 0.2);
      st.dryMass = e.mass * n + (n > 1 ? 40 * lay.mountDiameter * lay.mountDiameter : 0);
      st.thrustVac = e.thrustVac * n * limit;
      st.ispVac = e.ispVac;
      st.ispSL = e.ispSL;
      st.thrustSL = st.thrustVac * (e.ispSL / e.ispVac);
      st.cost = e.cost * n + (n > 1 ? 200_000 * n : 0);
      st.propellant = e.propellant;
      break;
    }
    case 'srb': {
      const s = def.solid!;
      const limit = num(cfg.thrustLimit, 1);
      st.propellant = 'solid';
      st.propellantCapacity = s.propellantMass;
      st.engineCount = 1;
      st.thrustSL = s.thrustSL * limit;
      st.thrustVac = st.thrustSL * (s.ispVac / s.ispSL);
      st.ispVac = s.ispVac;
      st.ispSL = s.ispSL;
      break;
    }
    case 'decoupler': {
      st.diameterTop = st.diameterBottom = d;
      st.height = 0.25 + 0.06 * d;
      st.dryMass = 45 * d * d + 30;
      st.cost = 150_000 + 40_000 * d * d;
      break;
    }
    case 'adapter': {
      const db = num(cfg.diameterBottom, def.diameterBottom ?? d);
      st.diameterTop = d;
      st.diameterBottom = db;
      st.height = Math.max(0.5, Math.abs(db - d) * 0.9 + 0.3);
      const area = Math.PI * ((d + db) / 2) * st.height;
      st.dryMass = area * 14 + 20;
      st.cost = 100_000 + area * 4_000;
      break;
    }
    case 'tube': {
      const L = num(cfg.length, def.height);
      st.diameterTop = st.diameterBottom = d;
      st.height = L;
      st.dryMass = Math.PI * d * L * 12 + 20;
      st.cost = 60_000 + Math.PI * d * L * 3_000;
      break;
    }
    case 'ring': {
      st.diameterTop = st.diameterBottom = d;
      if (def.reactionWheel) {
        st.dryMass = 60 + 55 * d * d;
        st.torque = def.reactionWheel.torquePerM2 * d * d;
        st.cost = def.cost * (0.5 + d / 2.5);
        st.height = 0.3 + 0.05 * d;
      } else {
        st.dryMass = def.dryMass * (d / 3.75) ** 2;
        st.torque = (def.command?.torque ?? 0) * (d / 3.75) ** 2;
        st.height = 0.4 + 0.08 * d;
      }
      break;
    }
    case 'nosecone': {
      st.diameterTop = 0;
      st.diameterBottom = d;
      st.height = d * 1.6;
      st.dryMass = 22 * d * d + 10;
      st.cost = 40_000 + 15_000 * d * d;
      break;
    }
    case 'fairing': {
      const L = num(cfg.length, 8);
      st.diameterTop = st.diameterBottom = d;
      st.height = 0.3;
      st.dryMass = 11 * Math.PI * d * L * 0.85 + 60 * d;
      st.cost = 1_000_000 + 250_000 * d * L * 0.3;
      break;
    }
    case 'heatshield': {
      const area = Math.PI * (d / 2) ** 2;
      st.diameterTop = st.diameterBottom = d;
      st.height = 0.2 + 0.06 * d;
      st.dryMass = 50 * area + 20;
      st.ablator = (def.heatShield?.ablatorPerM2 ?? 50) * area;
      st.cost = 500_000 + 400_000 * area;
      break;
    }
    case 'parachute': {
      const n = num(cfg.canopies, 1);
      st.dryMass = def.dryMass + 75 * n;
      st.cost = def.cost * n;
      break;
    }
    case 'dock': {
      st.diameterTop = st.diameterBottom = d;
      st.height = 0.25 + 0.05 * d;
      st.dryMass = 40 * d * d + 30;
      st.cost = 400_000 + 300_000 * d;
      break;
    }
    case 'rcs': {
      const r = def.rcs!;
      st.propellant = 'monoprop';
      st.propellantCapacity = r.propellant;
      break;
    }
    case 'truss': {
      const L = num(cfg.length, def.height);
      st.diameterTop = st.diameterBottom = d;
      st.height = L;
      st.dryMass = 18 * d * L + 10;
      st.cost = 40_000 + 12_000 * d * L;
      break;
    }
    case 'cabin': {
      const k = (d / def.diameter) ** 2;
      st.diameterTop = st.diameterBottom = d;
      st.height = def.height * Math.sqrt(d / def.diameter);
      st.dryMass = def.dryMass * k;
      st.crew = Math.round((def.cabin?.crew ?? 0) * k);
      st.cost = def.cost * k;
      break;
    }
    case 'capsule':
    case 'probe':
    default:
      break;
  }
  st.dryMass += st.ablator;
  return st;
}

/** Radius of the part's surface at local height y (y=0 centre, ±h/2 ends). */
export function surfaceRadiusAt(def: PartDef, stats: PartStats, y: number): number {
  const h = stats.height;
  const t = Math.min(1, Math.max(0, (y + h / 2) / h)); // 0 bottom → 1 top
  switch (def.shape) {
    case 'nosecone': {
      // Ogive: r = R * sqrt(1 - t^2) roughly
      const R = stats.diameterBottom / 2;
      return R * Math.sqrt(Math.max(0, 1 - t * t));
    }
    case 'capsule':
    case 'adapter':
      return (stats.diameterBottom / 2) * (1 - t) + (stats.diameterTop / 2) * t;
    case 'engine':
      return Math.max(stats.diameterTop, stats.diameterBottom) / 2 * 0.8;
    case 'radial-decoupler':
      return 0.15;
    default:
      return Math.max(stats.diameterTop, stats.diameterBottom) / 2;
  }
}
