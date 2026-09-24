/**
 * LEARNING NOTE: Missions as data + predicates
 *
 * Each mission is a list of OBJECTIVES; each objective is a predicate over the
 * simulation ("apoapsis ≥ 35,786 km", "landed on the Moon with crew aboard").
 * Objectives are checked in order every frame; some set persistent FLAGS (you
 * reached space) so later objectives can require history ("return safely after
 * landing on the Moon"). The campaign walks the arc of spaceflight: sounding
 * rockets → orbit → crew → geostationary → the Moon → Mars.
 *
 * STARS reward skill beyond the minimum. Completing the objectives earns one;
 * each of two BONUS goals earns another. Some bonuses are "latched" the moment
 * they become true (a circular orbit, a close lunar pass); others are judged at
 * the end from flight statistics (peak g-load, touchdown speed, Δv left over).
 * That split mirrors real mission success criteria: "minimum success" versus
 * "full success".
 *
 * Key concepts: declarative game design, predicates, state flags, progression,
 * graded success criteria
 */
import { G0 } from '../core/constants';
import { analyzeStages, totalDv } from '../parts/DeltaV';
import { CelestialBody, type BodyId } from '../physics/CelestialBody';
import type { FlightSim } from '../sim/FlightSim';
import type { Vessel } from '../sim/Vessel';
import type { FlightEvent } from '../sim/VesselPhysics';
import type { ObjectiveView } from '../ui/FlightHUD';
import { getLaunchSite } from '../world/LaunchSites';

export interface ObjectiveCtx {
  sim: FlightSim;
  v: Vessel;
  flags: Set<string>;
}

export interface ObjectiveDef {
  text: string;
  check: (c: ObjectiveCtx) => boolean;
}

/** Flight statistics used to judge "final" bonuses. */
export interface MissionStats {
  maxG: number;
  /** Peak skin temperature as a fraction of the part's limit (0 = ambient, 1 = failure). */
  maxHeat: number;
  /** Surface speed at the last touchdown / splashdown (m/s), NaN if none. */
  touchdownSpeed: number;
  /** Great-circle distance from the launch site at the last landing on the launch body (km). */
  landingDistanceKm: number;
  missionTime: number;
  /** Vacuum Δv left in the vessel when the mission completed (m/s). */
  dvRemaining: number;
}

export interface BonusDef {
  text: string;
  /** 'latch': counts if ever true during the flight · 'final': judged at completion. */
  kind: 'latch' | 'final';
  check: (s: MissionStats, c: ObjectiveCtx) => boolean;
}

/** Local solar time of launch; 'lunar' / 'mars' = computed windows. */
export type LaunchTimeOfDay = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night' | 'lunar' | 'mars';

export interface MissionDef {
  id: string;
  chapter: 1 | 2 | 3 | 4;
  title: string;
  subtitle: string;
  briefing: string;
  site: string;
  template: string;
  timeOfDay: LaunchTimeOfDay;
  /** Launch azimuth for the ascent program (degrees from north); default east. */
  heading?: number;
  /** Target orbit altitude for the ascent program (km). */
  targetKm?: number;
  objectives: ObjectiveDef[];
  bonus: BonusDef[];
  /** Part tier unlocked on completion. */
  unlocksTier: number;
  /** Mission requires a crewed vessel. */
  crewed: boolean;
  difficulty: 1 | 2 | 3 | 4 | 5;
}

const alt = (km: number): ObjectiveDef['check'] => (c) => c.v.maxAltitude >= km * 1000 && c.v.body.id === 'earth';
const onBody = (id: BodyId) => (c: ObjectiveCtx) => c.v.body.id === id;

/** Current conic around `id`, if the vessel is coasting in a closed orbit there. */
function orbitAround(c: ObjectiveCtx, id: BodyId) {
  const v = c.v;
  if (v.body.id !== id || v.pinned || c.sim.predictor.count === 0) return null;
  const o = c.sim.predictor.patches[0]!.orbit;
  if (!o.isElliptic || o.apoapsis >= v.body.soiRadius || v.totalThrust > 0) return null;
  return o;
}
const orbiting = (id: BodyId, minPeKm: number) => (c: ObjectiveCtx) => {
  const o = orbitAround(c, id);
  return !!o && o.periapsis - c.v.body.radius > minPeKm * 1000;
};
const incDeg = (c: ObjectiveCtx) => {
  const p = c.sim.predictor.count ? c.sim.predictor.patches[0] : null;
  return p ? (p.orbit.inc * 180) / Math.PI : NaN;
};
const circular = (id: BodyId, maxDiffKm: number) => (c: ObjectiveCtx) => {
  const o = orbitAround(c, id);
  return !!o && o.apoapsis - o.periapsis < maxDiffKm * 1000;
};
/** Predicted periapsis altitude (km) of the current patch. */
const periKm = (c: ObjectiveCtx) => {
  const p = c.sim.predictor.count ? c.sim.predictor.patches[0] : null;
  return p ? (p.orbit.periapsis - c.v.body.radius) / 1000 : Infinity;
};
const safeHome = (c: ObjectiveCtx) => {
  const v = c.v;
  return v.body.id === 'earth' && (v.situation === 'landed' || v.situation === 'splashed') && v.pinned && v.isControllable && !v.destroyed;
};
const landedOn = (id: BodyId) => (c: ObjectiveCtx) => c.flags.has(`${id}-landed`);
const launched = (c: ObjectiveCtx) => !isNaN(c.sim.launchTime);
const dvLeft = (min: number): BonusDef => ({ text: `Finish with at least ${min.toLocaleString('en-US')} m/s of Δv to spare`, kind: 'final', check: (s) => s.dvRemaining >= min });
const gUnder = (g: number, crew: boolean): BonusDef => ({ text: `Keep ${crew ? 'the crew' : 'the vehicle'} below ${g} g`, kind: 'final', check: (s) => s.maxG < g });
const softer = (mps: number): BonusDef => ({ text: `Touch down slower than ${mps} m/s`, kind: 'final', check: (s) => s.touchdownSpeed < mps });

export const MISSIONS: MissionDef[] = [
  // ------------------------------------------------------------ Chapter 1
  {
    id: 'first-light',
    chapter: 1,
    title: 'First Light',
    subtitle: 'Your first rocket',
    briefing:
      'Every space program starts with a sounding rocket. Launch the Pathfinder — a probe core on a solid motor — and climb above 10 km. Solid motors cannot be throttled or shut down: once lit, they burn to depletion.',
    site: 'cape',
    template: 'pathfinder',
    timeOfDay: 'morning',
    objectives: [
      { text: 'Liftoff', check: launched },
      { text: 'Climb above 10 km', check: alt(10) },
    ],
    bonus: [
      { text: 'Climb above 40 km', kind: 'latch', check: (_s, c) => c.v.maxAltitude > 40_000 },
      { text: 'Recover the probe under its parachute', kind: 'latch', check: (_s, c) => c.v.maxAltitude > 10_000 && safeHome(c) },
    ],
    unlocksTier: 0,
    crewed: false,
    difficulty: 1,
  },
  {
    id: 'karman',
    chapter: 1,
    title: 'Edge of Space',
    subtitle: 'Cross the Kármán line and come home',
    briefing:
      'Space officially begins at 100 km — the Kármán line. Reach it, then bring the probe back under its parachute. Stage the chute after re-entry heating is over: opening it at high dynamic pressure will shred it.',
    site: 'cape',
    template: 'pathfinder',
    timeOfDay: 'noon',
    objectives: [
      { text: 'Reach 100 km', check: alt(100) },
      { text: 'Deploy the parachute', check: (c) => c.v.parts.some((p) => p.chuteState === 'semi' || p.chuteState === 'full') },
      { text: 'Land or splash down safely', check: (c) => c.flags.has('space') && safeHome(c) },
    ],
    bonus: [
      { text: 'Reach 150 km', kind: 'latch', check: (_s, c) => c.v.maxAltitude > 150_000 && c.v.body.id === 'earth' },
      { text: 'Land within 150 km of the launch site', kind: 'final', check: (s) => s.landingDistanceKm < 150 },
    ],
    unlocksTier: 0,
    crewed: false,
    difficulty: 1,
  },
  {
    id: 'orbit',
    chapter: 1,
    title: 'Orbital Velocity',
    subtitle: 'Go sideways, fast',
    briefing:
      'Orbit is not about height — it is about horizontal speed: ~7.8 km/s at 200 km, so you fall around the Earth instead of into it. Pitch over gradually (a gravity turn), then burn horizontally near apoapsis. Reach a stable orbit with periapsis above 140 km.',
    site: 'cape',
    template: 'sprite',
    timeOfDay: 'morning',
    objectives: [
      { text: 'Reach space', check: alt(100) },
      { text: 'Stable orbit: periapsis above 140 km', check: orbiting('earth', 140) },
    ],
    bonus: [
      { text: 'Near-circular orbit (apoapsis − periapsis < 50 km)', kind: 'latch', check: (_s, c) => circular('earth', 50)(c) && orbiting('earth', 140)(c) },
      dvLeft(400),
    ],
    unlocksTier: 1,
    crewed: false,
    difficulty: 2,
  },
  // ------------------------------------------------------------ Chapter 2
  {
    id: 'crewed-orbit',
    chapter: 2,
    title: 'Friendship',
    subtitle: 'Put a crew in orbit and bring them home',
    briefing:
      'Fly the Kestrel capsule to orbit, then return. Burn retrograde with the service module to lower periapsis into the atmosphere (~60 km), separate the service module, and let the heat shield take the heat. Parachutes deploy by staging once below ~10 km.',
    site: 'cape',
    template: 'heron',
    timeOfDay: 'dawn',
    objectives: [
      { text: 'Launch with crew aboard', check: (c) => launched(c) && c.v.hasCrew },
      { text: 'Reach a stable orbit', check: orbiting('earth', 140) },
      { text: 'Return the crew safely to Earth', check: (c) => c.flags.has('orbit') && safeHome(c) && c.v.hasCrew },
    ],
    bonus: [gUnder(5, true), { text: 'Land within 1,000 km of Cape Canaveral', kind: 'final', check: (s) => s.landingDistanceKm < 1000 }],
    unlocksTier: 1,
    crewed: true,
    difficulty: 3,
  },
  {
    id: 'weather-eye',
    chapter: 2,
    title: 'Weather Eye',
    subtitle: 'A polar orbit from Vandenberg',
    briefing:
      'Weather satellites fly polar orbits so the whole planet turns beneath them. Launch south from Vandenberg (the ascent program is pre-set to 188°) and reach an orbit inclined 90–105° with periapsis above 400 km. At about 98°, Earth\'s equatorial bulge keeps the orbit aligned with the Sun: sun-synchronous.',
    site: 'vandenberg',
    template: 'nimbus',
    timeOfDay: 'morning',
    heading: 188.3,
    targetKm: 600,
    objectives: [
      { text: 'Reach space', check: alt(100) },
      {
        text: 'Polar orbit: inclination 90–105°, periapsis above 400 km',
        check: (c) => orbiting('earth', 400)(c) && incDeg(c) >= 90 && incDeg(c) <= 105,
      },
    ],
    bonus: [
      { text: 'Sun-synchronous: inclination 97–99.5°', kind: 'latch', check: (_s, c) => orbiting('earth', 400)(c) && incDeg(c) >= 97 && incDeg(c) <= 99.5 },
      { text: 'Near-circular orbit (apoapsis − periapsis < 80 km)', kind: 'latch', check: (_s, c) => orbiting('earth', 400)(c) && circular('earth', 80)(c) },
    ],
    unlocksTier: 1,
    crewed: false,
    difficulty: 3,
  },
  {
    id: 'geo',
    chapter: 2,
    title: 'High Ground',
    subtitle: 'Reach geostationary altitude',
    briefing:
      'Satellites 35,786 km above the equator orbit once per day and appear to hang still in the sky. From a low parking orbit, burn prograde to stretch your apoapsis out to 35,786 km (a Hohmann transfer), then circularize there for a perfect geostationary slot.',
    site: 'kourou',
    template: 'heron-lander',
    timeOfDay: 'noon',
    objectives: [
      { text: 'Reach orbit', check: orbiting('earth', 140) },
      { text: 'Raise apoapsis to 35,786 km', check: (c) => c.flags.has('geo') },
    ],
    bonus: [
      { text: 'Circularize at GEO (periapsis above 35,000 km)', kind: 'latch', check: (_s, c) => orbiting('earth', 35_000)(c) },
      { text: 'Equatorial orbit (inclination below 8°)', kind: 'latch', check: (_s, c) => c.flags.has('geo') && incDeg(c) < 8 },
    ],
    unlocksTier: 2,
    crewed: false,
    difficulty: 3,
  },
  // ------------------------------------------------------------ Chapter 3
  {
    id: 'lunar-flyby',
    chapter: 3,
    title: 'Around the Moon',
    subtitle: 'Reach the Moon\'s sphere of influence',
    briefing:
      'Trans-lunar injection: from low orbit, burn ~3.1 km/s prograde when the Moon is about 110–120° ahead of you. The flight computer\'s "To the Moon" planner finds the burn; "Fine-tune" trims the arrival once you are coasting.',
    site: 'cape',
    template: 'heron-lander',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Reach orbit', check: orbiting('earth', 140) },
      { text: 'Leave low orbit on a lunar trajectory', check: (c) => c.v.body.id === 'earth' && c.v.altitude > 1_000_000 },
      { text: 'Enter the Moon\'s sphere of influence', check: onBody('moon') },
    ],
    bonus: [
      { text: 'Aim for a close pass: lunar periapsis below 1,000 km', kind: 'latch', check: (_s, c) => c.v.body.id === 'moon' && periKm(c) < 1000 && periKm(c) > 0 },
      dvLeft(1000),
    ],
    unlocksTier: 3,
    crewed: false,
    difficulty: 3,
  },
  {
    id: 'lunar-orbit',
    chapter: 3,
    title: 'Lunar Orbiter',
    subtitle: 'Capture into orbit around the Moon',
    briefing:
      'Arriving at the Moon you are on a hyperbola — you will fly past unless you brake. At periapsis burn retrograde (~800 m/s) to capture into a closed lunar orbit. "Circularize at Pe" plans it for you.',
    site: 'cape',
    template: 'heron-lander',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Enter the Moon\'s sphere of influence', check: onBody('moon') },
      { text: 'Stable lunar orbit (periapsis above 15 km)', check: orbiting('moon', 15) },
    ],
    bonus: [{ text: 'Low lunar orbit: apoapsis below 500 km', kind: 'latch', check: (_s, c) => {
      const o = orbitAround(c, 'moon');
      return !!o && o.periapsis - c.v.body.radius > 15_000 && o.apoapsis - c.v.body.radius < 500_000;
    } }, dvLeft(500)],
    unlocksTier: 3,
    crewed: false,
    difficulty: 4,
  },
  {
    id: 'surveyor',
    chapter: 3,
    title: 'Soft Landing',
    subtitle: 'Land a robotic probe on the Moon',
    briefing:
      'No air, no parachutes: every metre per second of landing speed must be cancelled with the engine. From lunar orbit, burn retrograde to drop periapsis, kill horizontal speed, then descend gently (<3 m/s) on the legs. The flight computer\'s LAND program can fly the final descent.',
    site: 'cape',
    template: 'heron-lander',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Reach the Moon', check: onBody('moon') },
      { text: 'Land softly on the Moon', check: landedOn('moon') },
    ],
    bonus: [softer(2), dvLeft(250)],
    unlocksTier: 3,
    crewed: false,
    difficulty: 4,
  },
  {
    id: 'small-step',
    chapter: 3,
    title: 'One Small Step',
    subtitle: 'Land a crew on the Moon',
    briefing:
      'The Colossus stack: 7×F-1 first stage, a hydrogen second stage, a restartable TLI stage, a hypergolic descent stage with landing legs and a Condor capsule with its return module. Budget carefully — this is a real-scale Moon mission.',
    site: 'cape',
    template: 'colossus',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Launch with crew aboard', check: (c) => launched(c) && c.v.hasCrew },
      { text: 'Reach the Moon', check: onBody('moon') },
      { text: 'Land the crew on the Moon', check: (c) => landedOn('moon')(c) && c.v.hasCrew },
    ],
    bonus: [softer(2), gUnder(4.5, true)],
    unlocksTier: 3,
    crewed: true,
    difficulty: 5,
  },
  {
    id: 'home-again',
    chapter: 3,
    title: 'Home Again',
    subtitle: 'Moon landing and safe return',
    briefing:
      'The full Apollo profile in one flight: land on the Moon, lift off on the return module, burn for Earth ("Return home"), and survive an 11 km/s re-entry behind the heat shield before splashing down.',
    site: 'cape',
    template: 'colossus',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Land the crew on the Moon', check: (c) => landedOn('moon')(c) && c.v.hasCrew },
      { text: 'Return to Earth\'s sphere of influence', check: (c) => landedOn('moon')(c) && c.v.body.id === 'earth' },
      { text: 'Splash down or land safely with the crew', check: (c) => landedOn('moon')(c) && safeHome(c) && c.v.hasCrew },
    ],
    bonus: [gUnder(7, true), { text: 'Complete the mission in under 9 days', kind: 'final', check: (s) => s.missionTime < 9 * 86400 }],
    unlocksTier: 3,
    crewed: true,
    difficulty: 5,
  },
  // ------------------------------------------------------------ Chapter 4
  {
    id: 'mars-transfer',
    chapter: 4,
    title: 'Red Horizon',
    subtitle: 'Send a probe to Mars',
    briefing:
      'Launch in the November window, then from parking orbit plan "To Mars" — about 3.6–3.9 km/s that puts the Ares probe on a transfer ellipse around the Sun, arriving 8–12 months later. Trim the approach with "Fine-tune" early in the cruise, and warp: it is a long way.',
    site: 'cape',
    template: 'ares',
    timeOfDay: 'mars',
    objectives: [
      { text: 'Reach orbit', check: orbiting('earth', 140) },
      { text: 'Escape Earth: enter solar orbit', check: (c) => c.flags.has('sun') },
      { text: 'Enter the sphere of influence of Mars', check: onBody('mars') },
    ],
    bonus: [
      { text: 'Aim well: Mars periapsis below 2,000 km on arrival', kind: 'latch', check: (_s, c) => c.v.body.id === 'mars' && periKm(c) > 0 && periKm(c) < 2000 },
      dvLeft(1000),
    ],
    unlocksTier: 3,
    crewed: false,
    difficulty: 4,
  },
  {
    id: 'mars-orbit',
    chapter: 4,
    title: 'Ares Orbiter',
    subtitle: 'Capture into orbit around Mars',
    briefing:
      'Brake at the Martian periapsis to capture. A loose elliptical orbit costs a few hundred m/s; a low circular one over a kilometre per second. Keep periapsis above the thin atmosphere (100 km).',
    site: 'cape',
    template: 'ares',
    timeOfDay: 'mars',
    objectives: [
      { text: 'Escape Earth: enter solar orbit', check: (c) => c.flags.has('sun') },
      { text: 'Enter the sphere of influence of Mars', check: onBody('mars') },
      { text: 'Stable Mars orbit (periapsis above 100 km)', check: orbiting('mars', 100) },
    ],
    bonus: [{ text: 'Tight orbit: apoapsis below 10,000 km', kind: 'latch', check: (_s, c) => {
      const o = orbitAround(c, 'mars');
      return !!o && o.periapsis - c.v.body.radius > 100_000 && o.apoapsis - c.v.body.radius < 10_000_000;
    } }, dvLeft(300)],
    unlocksTier: 3,
    crewed: false,
    difficulty: 5,
  },
  {
    id: 'mars-landing',
    chapter: 4,
    title: 'Seven Minutes',
    subtitle: 'Land on Mars',
    briefing:
      'Entry, descent and landing: aim the approach periapsis around 40 km so the atmosphere catches you, let the heat shield shed most of the speed, open the parachute when slow enough, then finish on the engine and legs. Mars\'s air is 1% of Earth\'s — the chute alone won\'t save you.',
    site: 'cape',
    template: 'ares',
    timeOfDay: 'mars',
    objectives: [
      { text: 'Enter the sphere of influence of Mars', check: onBody('mars') },
      { text: 'Land softly on Mars', check: landedOn('mars') },
    ],
    bonus: [softer(3), { text: 'Keep peak heating below 85 % of the limit', kind: 'final', check: (s) => s.maxHeat < 0.85 }],
    unlocksTier: 3,
    crewed: false,
    difficulty: 5,
  },
];

export const CHAPTER_OF = (id: string): number => MISSIONS.find((m) => m.id === id)?.chapter ?? 1;

export type MissionStatus = 'active' | 'success' | 'failed';

const DEG = Math.PI / 180;
const _dir = { x: 0, y: 0, z: 0 };

export class MissionRuntime {
  readonly def: MissionDef;
  readonly flags = new Set<string>();
  private readonly done: boolean[];
  private readonly bonusLatched: boolean[];
  status: MissionStatus = 'active';
  failReason = '';
  onFinish: ((status: MissionStatus) => void) | null = null;
  /** Called when objective `index` completes (radio cues hook in here). */
  onObjective: ((index: number) => void) | null = null;
  private finishTimer = -1;
  /** Seconds spent above the crew's survivable sustained g-load. */
  private highG = 0;
  readonly stats: MissionStats = { maxG: 0, maxHeat: 0, touchdownSpeed: NaN, landingDistanceKm: NaN, missionTime: 0, dvRemaining: 0 };
  /** Stars earned (1 + bonuses), set on success. */
  stars = 0;

  constructor(def: MissionDef) {
    this.def = def;
    this.done = def.objectives.map(() => false);
    this.bonusLatched = def.bonus.map(() => false);
  }

  start(sim: FlightSim): void {
    void sim;
  }

  onEvent(e: FlightEvent, sim: FlightSim): void {
    if (e.vessel !== sim.active) return;
    const v = e.vessel;
    if (e.kind === 'landed') this.flags.add(`${v.body.id}-landed`);
    if ((e.kind === 'touchdown' || e.kind === 'splashdown') && e.speed !== undefined) {
      this.stats.touchdownSpeed = e.speed;
      if (v.body.id === 'earth') {
        // Great-circle distance from the launch site
        const site = getLaunchSite(this.def.site);
        const bf = v.r.clone().applyQuaternion(v.body.rotationInverse);
        const ll = CelestialBody.latLon(bf);
        const s1 = CelestialBody.dirFromLatLon(site.lat * DEG, site.lon * DEG, bf.clone());
        const s2 = CelestialBody.dirFromLatLon(ll.lat, ll.lon, bf.clone());
        this.stats.landingDistanceKm = (Math.acos(Math.max(-1, Math.min(1, s1.dot(s2)))) * v.body.radius) / 1000;
      }
    }
    if (e.kind === 'vessel-destroyed' && this.status === 'active') {
      this.status = 'failed';
      this.failReason = e.message;
      this.finishTimer = 3.5;
    }
  }

  private ctxFor(sim: FlightSim): ObjectiveCtx {
    return { sim, v: sim.active, flags: this.flags };
  }

  update(sim: FlightSim, dt: number, log: (t: string, k: 'good' | 'bad' | 'info' | 'warn') => void, toast: (t: string, s: string) => void): void {
    const v = sim.active;
    const c = this.ctxFor(sim);
    if (v.maxAltitude > 100_000 && v.body.id === 'earth') this.flags.add('space');
    if (orbiting('earth', 140)(c)) this.flags.add('orbit');
    if (v.body.id === 'sun') this.flags.add('sun');
    const p0 = sim.predictor.patches[0];
    // Apoapsis is infinite on an escape trajectory: only a closed orbit counts as "raised"
    if (p0 && sim.predictor.count && v.body.id === 'earth' && p0.orbit.isElliptic && p0.orbit.apoapsis - v.body.radius >= 35_786_000) this.flags.add('geo');
    if ((v.situation === 'landed' || v.situation === 'splashed') && v.pinned && v.body.id !== 'earth') this.flags.add(`${v.body.id}-landed`);
    // Statistics (only once the rocket has left the pad)
    if (!isNaN(sim.launchTime)) {
      this.stats.maxG = Math.max(this.stats.maxG, v.gForce);
      for (const p of v.parts) if (!p.isEngine) this.stats.maxHeat = Math.max(this.stats.maxHeat, (p.temperature - 288) / Math.max(1, p.def.maxTemp - 288));
      this.stats.missionTime = sim.missionTime;
      for (let i = 0; i < this.def.bonus.length; i++) {
        const b = this.def.bonus[i]!;
        if (b.kind === 'latch' && !this.bonusLatched[i] && b.check(this.stats, c)) {
          this.bonusLatched[i] = true;
          log(`Bonus: ${b.text}`, 'good');
        }
      }
    }
    if (this.status === 'active') {
      for (let i = 0; i < this.def.objectives.length; i++) {
        if (this.done[i]) continue;
        // Objectives complete in order
        if (i > 0 && !this.done[i - 1]) break;
        if (this.def.objectives[i]!.check(c)) {
          this.done[i] = true;
          log(`Objective complete: ${this.def.objectives[i]!.text}`, 'good');
          this.onObjective?.(i);
          if (this.done.every(Boolean)) {
            this.status = 'success';
            this.finalize(sim);
            toast('Mission complete', `${'★'.repeat(this.stars)}${'☆'.repeat(3 - this.stars)}`);
            this.finishTimer = 4;
          }
        }
      }
      // Sustained acceleration above ~12 g incapacitates a crew (brief spikes are survivable)
      if (v.hasCrew && !v.pinned) this.highG = v.gForce > 12 ? this.highG + dt : Math.max(0, this.highG - dt * 0.5);
      if (this.def.crewed && this.highG > 3 && this.status === 'active') {
        this.status = 'failed';
        this.failReason = 'The crew was incapacitated by a sustained g-load above 12 g.';
        this.finishTimer = 3;
      }
      if (this.def.crewed && !isNaN(sim.launchTime) && !v.hasCrew && !v.destroyed && this.status === 'active') {
        this.status = 'failed';
        this.failReason = 'The crew module was lost.';
        this.finishTimer = 3;
      }
    }
    if (this.finishTimer > 0) {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0 && this.onFinish) this.onFinish(this.status);
    }
  }

  /** Judge the final bonuses and count stars (can be called again after "keep flying"). */
  finalize(sim: FlightSim): number {
    if (this.status !== 'success') return 0;
    const v = sim.active;
    this.stats.dvRemaining = totalDv(analyzeStages(v.toSimParts(), v.nextStage, G0));
    this.stats.missionTime = sim.missionTime;
    const c = this.ctxFor(sim);
    let stars = 1;
    this.def.bonus.forEach((b, i) => {
      const ok = b.kind === 'latch' ? this.bonusLatched[i] : b.check(this.stats, c);
      if (ok) stars++;
    });
    this.stars = Math.max(this.stars, Math.min(3, stars));
    return this.stars;
  }

  /** Bonus goals with their current state (for the HUD / results screen). */
  bonusViews(sim: FlightSim | null): Array<{ text: string; ok: boolean }> {
    return this.def.bonus.map((b, i) => ({
      text: b.text,
      ok: b.kind === 'latch' ? !!this.bonusLatched[i] : !!sim && this.status === 'success' && b.check(this.stats, this.ctxFor(sim)),
    }));
  }

  objectiveViews(): ObjectiveView[] {
    let activeSet = false;
    return this.def.objectives.map((o, i) => {
      let state: ObjectiveView['state'] = 'pending';
      if (this.done[i]) state = 'done';
      else if (this.status === 'failed') state = 'failed';
      else if (!activeSet) {
        state = 'active';
        activeSet = true;
      }
      return { text: o.text, state };
    });
  }
}
void _dir;

/** UTC start time for a given local solar time at the site longitude. */
export function launchUtFor(dateUtc: Date, lonDeg: number, tod: LaunchTimeOfDay): number {
  // 'lunar' / 'mars' are resolved by window searches; their entry is the scan start
  const hours: Record<LaunchTimeOfDay, number> = { dawn: 6.3, morning: 9.5, noon: 12.5, afternoon: 15.5, dusk: 18.4, night: 22, lunar: 0, mars: 0 };
  const localSolar = hours[tod];
  const utcHours = localSolar - lonDeg / 15;
  const d = new Date(Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate(), 0, 0, 0));
  return (d.getTime() + utcHours * 3600_000 - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
}
