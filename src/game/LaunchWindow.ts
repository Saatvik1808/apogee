/**
 * LEARNING NOTE: Launch windows
 *
 * A rocket can only reach orbital planes that contain its launch site at the
 * instant of liftoff. Rotating the launch direction (azimuth) tilts the plane
 * about the site, and waiting lets Earth's rotation carry the site around — so
 * picking WHEN and in WHICH DIRECTION to launch picks the plane.
 *
 * To reach the Moon cheaply the parking orbit has to contain the point where the
 * Moon will be when the spacecraft arrives, ~3½ days later; otherwise the
 * transfer ellipse misses it sideways (a plane change later costs a fortune).
 * The required plane's normal is  n = ŝ × m̂  (site direction × Moon's future
 * direction), and the launch direction is n × ŝ. We scan a day in five-minute
 * steps for the moment that direction points closest to due east, where Earth's
 * 400 m/s surface speed helps most. Apollo launch windows were computed the same
 * way — just with far better ephemerides.
 *
 * Key concepts: orbital planes, launch azimuth, launch windows, plane changes
 */
import { Vector3 } from 'three';
import { CelestialBody } from '../physics/CelestialBody';
import type { SolarSystem } from '../physics/SolarSystem';
import type { LaunchSite } from '../world/LaunchSites';
import { MARS_ARRIVAL_WEIGHT, MARS_TOF_MAX, MARS_TOF_MIN, porkchop } from '../physics/Lambert';

export interface LaunchWindow {
  /** Liftoff time (UT seconds since J2000). */
  ut: number;
  /** Launch azimuth, degrees clockwise from north. */
  heading: number;
  /** Resulting orbital inclination (degrees). */
  inclination: number;
  /** Target orbital plane (unit normal, inertial frame) for plane-following ascent guidance. */
  normal: Vector3;
}

const DEG = Math.PI / 180;
const TRANSFER_TIME = 3.5 * 86400;

const _s = new Vector3();
const _m = new Vector3();
const _n = new Vector3();
const _d = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const POLE = new Vector3(0, 1, 0);

/** Earliest good lunar launch time within ~1 day after `from`. */
export function lunarLaunchWindow(system: SolarSystem, site: LaunchSite, from: number): LaunchWindow {
  const moon = system.moon;
  return planeLaunchWindow(system, site, from, (t, out) => {
    moon.relativeStateAt(t + TRANSFER_TIME, out);
    return out.normalize();
  });
}

/**
 * Launch time/azimuth (within a day after `from`) whose parking-orbit plane
 * contains the direction `target(t)` — the Moon's future position, or the
 * departure asymptote of an interplanetary transfer.
 */
export function planeLaunchWindow(system: SolarSystem, site: LaunchSite, from: number, target: (t: number, out: Vector3) => Vector3): LaunchWindow {
  const earth = system.earth;
  const saved = system.time;
  let best: LaunchWindow = { ut: from, heading: 90, inclination: Math.abs(site.lat), normal: new Vector3(0, 1, 0) };
  let bestCost = Infinity;
  for (let k = 0; k <= 288; k++) {
    const t = from + k * 300;
    system.update(t);
    CelestialBody.dirFromLatLon(site.lat * DEG, site.lon * DEG, _s).applyQuaternion(earth.rotation).normalize();
    target(t, _m);
    _n.crossVectors(_s, _m);
    if (_n.lengthSq() < 1e-4) continue; // Moon straight overhead/underfoot: plane undefined
    _n.normalize();
    _d.crossVectors(_n, _s).normalize();
    _east.crossVectors(POLE, _s).normalize();
    _north.crossVectors(_s, _east);
    if (_d.dot(_east) < 0) {
      // Fly the plane in its eastward (prograde) sense
      _d.negate();
      _n.negate();
    }
    const heading = Math.atan2(_d.dot(_east), _d.dot(_north)) / DEG;
    const cost = Math.abs(heading - 90) + k * 0.02; // gently prefer earlier windows
    if (cost < bestCost) {
      bestCost = cost;
      best = { ut: t, heading, inclination: Math.acos(Math.min(1, Math.abs(_n.dot(POLE)))) / DEG, normal: _n.clone() };
    }
  }
  system.update(saved);
  return best;
}

export interface MarsWindow extends LaunchWindow {
  /** Planned trans-Mars injection (departure) and Mars arrival times (UT). */
  depart: number;
  arrive: number;
  /** Departure hyperbolic excess speed (m/s). */
  vInf: number;
}

/**
 * Next Earth → Mars transfer window after `from` (porkchop search with Lambert's
 * problem), then the launch time on the day before departure that puts the
 * parking orbit in the plane of the departure asymptote.
 */
export function marsLaunchWindow(system: SolarSystem, site: LaunchSite, from: number): MarsWindow {
  const saved = system.time;
  const src = (b: CelestialBody) => ({ stateAt: (t: number, r: Vector3, v: Vector3) => b.relativeStateAt(t, r, v) });
  const day = 86400;
  const tr = porkchop(from, 800 * day, MARS_TOF_MIN, MARS_TOF_MAX, system.sun.mu, src(system.earth), src(system.mars), MARS_ARRIVAL_WEIGHT);
  system.update(saved);
  if (!tr) {
    const w = planeLaunchWindow(system, site, from, (_t, out) => out.set(1, 0, 0));
    return { ...w, depart: from + day, arrive: from + 220 * day, vInf: 3000 };
  }
  const vInfDir = tr.vInfDepart.clone().normalize();
  // Launch within about half a day of the optimal departure; the injection burn
  // follows an orbit or two after reaching the parking orbit
  const w = planeLaunchWindow(system, site, tr.depart - 0.6 * day, (_t, out) => out.copy(vInfDir));
  return { ...w, depart: tr.depart, arrive: tr.arrive, vInf: Math.sqrt(tr.c3) };
}
