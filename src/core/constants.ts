/**
 * LEARNING NOTE: Physical constants & tuning values
 *
 * APOGEE simulates spaceflight at REAL scale: Earth has its true 6,371 km radius,
 * the Moon orbits 384,400 km away, and reaching low orbit needs ~9.4 km/s of
 * delta-v, exactly like real rockets. Every magic number the simulation depends on
 * lives here so tuning never means hunting through gameplay code.
 *
 * All values are SI: metres, kilograms, seconds, newtons, kelvin, radians.
 *
 * Key concepts: SI units, standard gravity g0, gravitational parameter mu = G*M
 * Further reading: https://ssd.jpl.nasa.gov/astro_par.html
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;

/** Standard gravity — defines the "seconds" unit of specific impulse (Isp). */
export const G0 = 9.80665;

/** Unix epoch milliseconds of J2000.0 (2000-01-01 12:00 TT, TT≈UTC here). */
export const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_YEAR = 365.25 * SECONDS_PER_DAY;
export const AU = 1.495978707e11;
/** Tilt of Earth's axis relative to its orbit (the ecliptic). */
export const OBLIQUITY = 23.4392811 * DEG;

/** Stefan–Boltzmann constant, used for radiative cooling of hot parts. */
export const STEFAN_BOLTZMANN = 5.670374419e-8;

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------
/** Fixed physics step. Physics must use a constant dt to stay deterministic. */
export const PHYSICS_DT = 1 / 60;
/** Upper bound on physics sub-steps per rendered frame (prevents death spirals). */
export const MAX_PHYSICS_STEPS_PER_FRAME = 20;
/** Physics warp: time accelerates but forces are still integrated step by step. */
export const PHYSICS_WARP_LEVELS = [1, 2, 3, 4] as const;
/** On-rails warp: orbits are propagated analytically (Kepler), so any speed is exact. */
export const RAILS_WARP_LEVELS = [1, 5, 10, 50, 100, 1_000, 10_000, 100_000, 1_000_000] as const;
/** Max rails warp allowed as a function of altitude above the SOI body (m). */
export const RAILS_WARP_ALTITUDE_LIMITS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],          // (altitude threshold, max warp index)
  [140_000, 4],
  [300_000, 5],
  [1_000_000, 6],
  [5_000_000, 7],
  [20_000_000, 8],
];

// ---------------------------------------------------------------------------
// Vessel physics tuning
// ---------------------------------------------------------------------------
/** Ground contact spring: static sag of the whole vessel on its contacts (m). */
export const CONTACT_STATIC_SAG = 0.025;
/** Fraction of critical damping for ground contacts. */
export const CONTACT_DAMPING_RATIO = 0.9;
export const CONTACT_FRICTION = 0.8;
/** Below this vessel speed relative to the surface we consider "settled" (m/s). */
export const LANDED_SPEED_THRESHOLD = 0.15;
export const LANDED_SETTLE_TIME = 1.0;

/** Vessel breaks apart when dynamic pressure * sin(AoA) exceeds this (Pa). */
export const AERO_BREAKUP_LOAD = 9_000;
/** Crossflow drag coefficient for cylinders. */
export const CROSSFLOW_CD = 1.1;
/** Lift slope of fins per radian of angle of attack. */
export const FIN_LIFT_SLOPE = 3.2;
export const FIN_STALL_ANGLE = 22 * DEG;

/** Sutton–Graves convective heating constant for Earth-like air (SI). */
export const SUTTON_GRAVES_K = 1.7415e-4;
/** Specific heat of structure (J/kg/K) and fraction of mass that heats (skin). */
export const STRUCTURE_HEAT_CAPACITY = 900;
export const SKIN_MASS_FRACTION = 0.12;
export const SKIN_EMISSIVITY = 0.8;
/** Energy absorbed per kg of ablator consumed (J/kg). */
export const ABLATOR_HEAT_OF_ABLATION = 4.0e7;
export const AMBIENT_TEMPERATURE_SPACE = 4;

/** Engine thrust ramps with this time constant unless the part overrides it (s). */
export const DEFAULT_ENGINE_SPOOL = 0.6;

/** Default reaction-control torque scaling for SAS (fraction of max). */
export const SAS_MAX_RATE = 0.35; // rad/s max commanded rotation rate
export const SAS_DECEL_FRACTION = 0.6;

// ---------------------------------------------------------------------------
// Rendering tuning
// ---------------------------------------------------------------------------
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 1e13;
/** Physics bubble: debris beyond this distance from the active vessel is dropped. */
export const PHYSICS_BUBBLE_RADIUS = 25_000;
