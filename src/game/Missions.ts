/**
 * LEARNING NOTE: Missions as data + predicates
 *
 * Each mission is a list of OBJECTIVES; each objective is a predicate over the
 * simulation ("apoapsis ≥ 35,786 km", "landed on the Moon with crew aboard").
 * Objectives are checked in order every frame; some set persistent FLAGS (you
 * reached space) so later objectives can require history ("return safely after
 * landing on the Moon"). The campaign walks the real history of spaceflight:
 * sounding rockets → orbit → crew → geostationary → the Moon → return.
 *
 * Key concepts: declarative game design, predicates, state flags, progression
 */
import type { BodyId } from '../physics/CelestialBody';
import type { FlightSim } from '../sim/FlightSim';
import type { Vessel } from '../sim/Vessel';
import type { FlightEvent } from '../sim/VesselPhysics';
import type { ObjectiveView } from '../ui/FlightHUD';

export interface ObjectiveCtx {
  sim: FlightSim;
  v: Vessel;
  flags: Set<string>;
}

export interface ObjectiveDef {
  text: string;
  check: (c: ObjectiveCtx) => boolean;
}

/** Local solar time of launch; 'lunar' = computed window that puts the Moon in the parking-orbit plane. */
export type LaunchTimeOfDay = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night' | 'lunar';

export interface MissionDef {
  id: string;
  title: string;
  subtitle: string;
  briefing: string;
  site: string;
  template: string;
  timeOfDay: LaunchTimeOfDay;
  objectives: ObjectiveDef[];
  /** Part tier unlocked on completion. */
  unlocksTier: number;
  /** Mission requires a crewed vessel. */
  crewed: boolean;
  difficulty: 1 | 2 | 3 | 4 | 5;
}

const alt = (km: number): ObjectiveDef['check'] => (c) => c.v.maxAltitude >= km * 1000 && c.v.body.id === 'earth';
const onBody = (id: BodyId) => (c: ObjectiveCtx) => c.v.body.id === id;
const orbiting = (id: BodyId, minPeKm: number) => (c: ObjectiveCtx) => {
  const v = c.v;
  if (v.body.id !== id || v.pinned) return false;
  const p0 = c.sim.predictor.patches[0];
  if (!p0 || c.sim.predictor.count === 0) return false;
  const o = p0.orbit;
  return o.isElliptic && o.periapsis - v.body.radius > minPeKm * 1000 && o.apoapsis < v.body.soiRadius && v.totalThrust === 0;
};
const safeHome = (c: ObjectiveCtx) => {
  const v = c.v;
  return v.body.id === 'earth' && (v.situation === 'landed' || v.situation === 'splashed') && v.pinned && v.isControllable && !v.destroyed;
};

export const MISSIONS: MissionDef[] = [
  {
    id: 'first-light',
    title: 'First Light',
    subtitle: 'Your first rocket',
    briefing:
      'Every space program starts with a sounding rocket. Launch the Pathfinder — a probe core on a solid motor — and climb above 10 km. Solid motors cannot be throttled or shut down: once lit, they burn to depletion.',
    site: 'cape',
    template: 'pathfinder',
    timeOfDay: 'morning',
    objectives: [
      { text: 'Liftoff', check: (c) => !isNaN(c.sim.launchTime) },
      { text: 'Climb above 10 km', check: alt(10) },
    ],
    unlocksTier: 0,
    crewed: false,
    difficulty: 1,
  },
  {
    id: 'karman',
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
    unlocksTier: 0,
    crewed: false,
    difficulty: 1,
  },
  {
    id: 'orbit',
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
    unlocksTier: 1,
    crewed: false,
    difficulty: 2,
  },
  {
    id: 'crewed-orbit',
    title: 'Friendship',
    subtitle: 'Put a crew in orbit and bring them home',
    briefing:
      'Fly the Kestrel capsule to orbit, then return. Burn retrograde with the service module to lower periapsis into the atmosphere (~60 km), separate the service module, and let the heat shield take the heat. Parachutes deploy by staging once below ~15 km.',
    site: 'cape',
    template: 'heron',
    timeOfDay: 'dawn',
    objectives: [
      { text: 'Launch with crew aboard', check: (c) => !isNaN(c.sim.launchTime) && c.v.hasCrew },
      { text: 'Reach a stable orbit', check: orbiting('earth', 140) },
      { text: 'Return the crew safely to Earth', check: (c) => c.flags.has('orbit') && safeHome(c) && c.v.hasCrew },
    ],
    unlocksTier: 1,
    crewed: true,
    difficulty: 3,
  },
  {
    id: 'geo',
    title: 'High Ground',
    subtitle: 'Reach geostationary altitude',
    briefing:
      'Satellites 35,786 km above the equator orbit once per day and appear to hang still in the sky. Reach that altitude with a probe: from a low parking orbit, burn prograde to stretch your apoapsis out to 35,786 km (a Hohmann transfer).',
    site: 'kourou',
    template: 'heron-lander',
    timeOfDay: 'noon',
    objectives: [
      { text: 'Reach orbit', check: orbiting('earth', 140) },
      { text: 'Raise apoapsis to 35,786 km', check: (c) => c.flags.has('geo') },
    ],
    unlocksTier: 2,
    crewed: false,
    difficulty: 3,
  },
  {
    id: 'lunar-flyby',
    title: 'Around the Moon',
    subtitle: 'Reach the Moon\'s sphere of influence',
    briefing:
      'Trans-lunar injection: from low orbit, burn ~3.1 km/s prograde when the Moon is about 110–120° ahead of you. Open the map (M), add a node (N) and drag prograde Δv until the trajectory shows a Moon encounter, then execute it.',
    site: 'cape',
    template: 'heron-lander',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Reach orbit', check: orbiting('earth', 140) },
      { text: 'Enter the Moon\'s sphere of influence', check: onBody('moon') },
    ],
    unlocksTier: 3,
    crewed: false,
    difficulty: 3,
  },
  {
    id: 'lunar-orbit',
    title: 'Lunar Orbiter',
    subtitle: 'Capture into orbit around the Moon',
    briefing:
      'Arriving at the Moon you are on a hyperbola — you will fly past unless you brake. At periapsis burn retrograde (~800 m/s) to capture into a closed lunar orbit.',
    site: 'cape',
    template: 'heron-lander',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Enter the Moon\'s sphere of influence', check: onBody('moon') },
      { text: 'Stable lunar orbit (periapsis above 15 km)', check: orbiting('moon', 15) },
    ],
    unlocksTier: 3,
    crewed: false,
    difficulty: 4,
  },
  {
    id: 'surveyor',
    title: 'Soft Landing',
    subtitle: 'Land a robotic probe on the Moon',
    briefing:
      'No air, no parachutes: every metre per second of landing speed must be cancelled with the engine. From lunar orbit, burn retrograde to drop periapsis, kill horizontal speed, then descend gently (<3 m/s) on the legs. The flight computer\'s LAND program can fly the final descent.',
    site: 'cape',
    template: 'heron-lander',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Reach the Moon', check: onBody('moon') },
      { text: 'Land softly on the Moon', check: (c) => c.flags.has('moon-landed') },
    ],
    unlocksTier: 3,
    crewed: false,
    difficulty: 4,
  },
  {
    id: 'small-step',
    title: 'One Small Step',
    subtitle: 'Land a crew on the Moon',
    briefing:
      'The Colossus stack: 7×F-1 first stage, a hydrogen second stage, a restartable TLI stage, a hypergolic descent stage with landing legs and a Condor capsule with its return module. Budget carefully — this is a real-scale Moon mission.',
    site: 'cape',
    template: 'colossus',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Launch with crew aboard', check: (c) => !isNaN(c.sim.launchTime) && c.v.hasCrew },
      { text: 'Reach the Moon', check: onBody('moon') },
      { text: 'Land the crew on the Moon', check: (c) => c.flags.has('moon-landed') && c.v.hasCrew },
    ],
    unlocksTier: 3,
    crewed: true,
    difficulty: 5,
  },
  {
    id: 'home-again',
    title: 'Home Again',
    subtitle: 'Moon landing and safe return',
    briefing:
      'The full Apollo profile in one flight: land on the Moon, lift off on the return module, burn for Earth (trans-Earth injection), and survive an 11 km/s re-entry behind the heat shield before splashing down.',
    site: 'cape',
    template: 'colossus',
    timeOfDay: 'lunar',
    objectives: [
      { text: 'Land the crew on the Moon', check: (c) => c.flags.has('moon-landed') && c.v.hasCrew },
      { text: 'Return to Earth\'s sphere of influence', check: (c) => c.flags.has('moon-landed') && c.v.body.id === 'earth' },
      { text: 'Splash down or land safely with the crew', check: (c) => c.flags.has('moon-landed') && safeHome(c) && c.v.hasCrew },
    ],
    unlocksTier: 3,
    crewed: true,
    difficulty: 5,
  },
];

export type MissionStatus = 'active' | 'success' | 'failed';

export class MissionRuntime {
  readonly def: MissionDef;
  readonly flags = new Set<string>();
  private readonly done: boolean[];
  status: MissionStatus = 'active';
  failReason = '';
  onFinish: ((status: MissionStatus) => void) | null = null;
  private finishTimer = -1;

  constructor(def: MissionDef) {
    this.def = def;
    this.done = def.objectives.map(() => false);
  }

  start(sim: FlightSim): void {
    void sim;
  }

  onEvent(e: FlightEvent, sim: FlightSim): void {
    if (e.vessel !== sim.active) return;
    if (e.kind === 'landed' && e.vessel.body.id === 'moon') this.flags.add('moon-landed');
    if (e.kind === 'vessel-destroyed' && this.status === 'active') {
      this.status = 'failed';
      this.failReason = e.message;
      this.finishTimer = 3.5;
    }
  }

  update(sim: FlightSim, dt: number, log: (t: string, k: 'good' | 'bad' | 'info' | 'warn') => void, toast: (t: string, s: string) => void): void {
    const v = sim.active;
    const c: ObjectiveCtx = { sim, v, flags: this.flags };
    if (v.maxAltitude > 100_000 && v.body.id === 'earth') this.flags.add('space');
    if (orbiting('earth', 140)(c)) this.flags.add('orbit');
    const p0 = sim.predictor.patches[0];
    if (p0 && sim.predictor.count && v.body.id === 'earth' && p0.orbit.apoapsis - v.body.radius >= 35_786_000) this.flags.add('geo');
    if (v.body.id === 'moon' && (v.situation === 'landed') && v.pinned) this.flags.add('moon-landed');
    if (this.status === 'active') {
      for (let i = 0; i < this.def.objectives.length; i++) {
        if (this.done[i]) continue;
        // Objectives complete in order
        if (i > 0 && !this.done[i - 1]) break;
        if (this.def.objectives[i]!.check(c)) {
          this.done[i] = true;
          log(`Objective complete: ${this.def.objectives[i]!.text}`, 'good');
          if (this.done.every(Boolean)) {
            this.status = 'success';
            toast('Mission complete', this.def.title);
            this.finishTimer = 4;
          }
        }
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

/** UTC start time for a given local solar time at the site longitude. */
export function launchUtFor(dateUtc: Date, lonDeg: number, tod: LaunchTimeOfDay): number {
  // 'lunar' is resolved by the launch-window search; its entry is the scan start
  const hours: Record<LaunchTimeOfDay, number> = { dawn: 6.3, morning: 9.5, noon: 12.5, afternoon: 15.5, dusk: 18.4, night: 22, lunar: 0 };
  const localSolar = hours[tod];
  const utcHours = localSolar - lonDeg / 15;
  const d = new Date(Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate(), 0, 0, 0));
  return (d.getTime() + utcHours * 3600_000 - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
}
