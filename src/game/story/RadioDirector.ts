/**
 * LEARNING NOTE: Communications — line of sight, blackout and light time
 *
 * Radio needs a straight line between antennas. Three effects shape what the
 * crew hears:
 *
 *  • OCCULTATION: behind the Moon, the Moon itself blocks the line to Earth.
 *    The test is geometric — does the segment from spacecraft to Earth pass
 *    within one lunar radius of the Moon's centre? Apollo crews were out of
 *    contact for ~45 minutes of every lunar orbit.
 *  • RE-ENTRY BLACKOUT: at orbital speeds the air in front of a capsule is
 *    heated into plasma, and free electrons reflect radio waves. We flag it when
 *    the stagnation heat flux (∝ √ρ · v³) is high.
 *  • LIGHT TIME: radio travels at c. Earth–Moon is 1.3 s; Earth–Mars is 3 to 22
 *    minutes, which is why Mars landers fly themselves.
 *
 * The director matches flight events against the story's radio cues and feeds
 * the radio queue, holding lines while the signal is down.
 *
 * Key concepts: line of sight, ray–sphere tests, plasma blackout, speed-of-light
 * delay, event-driven narrative
 */
import { Vector3 } from 'three';
import type { BodyId } from '../../physics/CelestialBody';
import type { FlightSim } from '../../sim/FlightSim';
import type { SignalState } from '../../ui/StoryUI';
import { GENERIC_RADIO, STORY, type Beat, type RadioCue, type RadioTrigger } from './Story';

const C = 299_792_458;
const _a = new Vector3();
const _b = new Vector3();
const _m = new Vector3();
const _d = new Vector3();

export class RadioDirector {
  private readonly cues: RadioCue[];
  private readonly fired = new Set<RadioCue>();
  private readonly say: (lines: Beat[]) => void;
  signal: SignalState = 'link';
  /** One-way light time to Earth (s). */
  lightTime = 0;
  private started = false;
  private spaceCalled = false;
  private reentryCalled = false;
  private rendezvousCalled = false;
  private losPredicted = false;
  private readonly descentFired = new Set<RadioCue>();

  constructor(missionId: string | null, say: (lines: Beat[]) => void) {
    this.say = say;
    const story = missionId ? STORY[missionId] : undefined;
    const own = story ? story.radio : [];
    // Mission cues override generic cues with the same trigger
    const key = (t: RadioTrigger) => JSON.stringify(t);
    const ownKeys = new Set(own.map((c) => key(c.trigger)));
    this.cues = [...own, ...GENERIC_RADIO.filter((c) => !ownKeys.has(key(c.trigger)))];
  }

  trigger(t: RadioTrigger): void {
    const k = JSON.stringify(t);
    for (const c of this.cues) {
      if (JSON.stringify(c.trigger) !== k) continue;
      if (c.once !== false && this.fired.has(c)) continue;
      this.fired.add(c);
      this.say(c.lines);
    }
  }

  /** Per-frame: start cue, altitude cues, space, re-entry, and comms state. */
  update(sim: FlightSim): void {
    const v = sim.active;
    if (!this.started) {
      this.started = true;
      this.trigger({ on: 'start' });
    }
    if (!this.spaceCalled && v.body.id === 'earth' && v.maxAltitude > 100_000) {
      this.spaceCalled = true;
      this.trigger({ on: 'space' });
    }
    // Descending-through-altitude cues
    for (const c of this.cues) {
      const t = c.trigger;
      if (t.on !== 'descending' || this.descentFired.has(c)) continue;
      if (v.body.id === t.body && v.verticalSpeed < -5 && v.altitude < t.km * 1000 && v.maxAltitude > t.km * 1000 * 1.5) {
        this.descentFired.add(c);
        this.trigger(t);
      }
    }
    // Rendezvous: inside 500 m of a target vessel
    const ti = sim.targetInfo;
    if (!this.rendezvousCalled && ti && ti.distance < 500 && sim.targetVessel) {
      this.rendezvousCalled = true;
      this.trigger({ on: 'rendezvous' });
    }
    // Re-entry: fast and entering the atmosphere
    const atm = v.body.atmosphere;
    const speed = v.surfaceVelocity.length();
    if (!this.reentryCalled && atm && v.body.id === 'earth' && v.altitude < atm.ceiling && v.verticalSpeed < 0 && speed > 6500) {
      this.reentryCalled = true;
      this.trigger({ on: 'reentry' });
    }
    // Communications
    const prev = this.signal;
    let next: SignalState = 'link';
    const plasma = atm ? Math.sqrt(Math.max(0, v.airDensity)) * Math.pow(speed / 1000, 3) : 0;
    if (plasma > 6) next = 'blackout';
    else if (this.occulted(sim, 0)) next = 'los';
    // Warn half a minute before passing behind the Moon
    if (next === 'link' && v.body.id === 'moon') {
      const soon = this.occulted(sim, 30);
      if (soon && !this.losPredicted) {
        this.losPredicted = true;
        this.trigger({ on: 'los' });
      } else if (!soon && this.losPredicted && prev === 'link') {
        // A burn steered clear of the predicted pass: re-arm the warning
        this.losPredicted = false;
      }
    }
    if (next === 'link' && prev === 'los') {
      this.losPredicted = false;
      this.signal = next;
      this.trigger({ on: 'aos' });
    }
    this.signal = next;
    v.absolutePosition(_a);
    this.lightTime = _a.distanceTo(sim.system.earth.position) / C;
  }

  /** Is the Moon between the vessel (extrapolated `ahead` seconds) and Earth? */
  private occulted(sim: FlightSim, ahead: number): boolean {
    const v = sim.active;
    const moon = sim.system.moon;
    v.absolutePosition(_a);
    if (ahead > 0) _a.addScaledVector(v.v, ahead);
    _b.copy(sim.system.earth.position);
    _m.copy(moon.position);
    // Closest point on segment a→b to the Moon's centre
    _d.copy(_b).sub(_a);
    const len2 = _d.lengthSq();
    const s = Math.max(0, Math.min(1, _m.clone().sub(_a).dot(_d) / len2));
    const closest = _a.clone().addScaledVector(_d, s);
    // Ignore the vessel sitting on/very near the Moon's near side
    return s > 0.0005 && closest.distanceTo(_m) < moon.radius * 0.995;
  }

  /** Map a flight event kind to a radio trigger. */
  onSoi(body: BodyId): void {
    this.trigger({ on: 'soi', body });
  }
}
