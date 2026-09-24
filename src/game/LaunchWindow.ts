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

export interface LaunchWindow {
  /** Liftoff time (UT seconds since J2000). */
  ut: number;
  /** Launch azimuth, degrees clockwise from north. */
  heading: number;
  /** Resulting orbital inclination (degrees). */
  inclination: number;
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
  const earth = system.earth;
  const moon = system.moon;
  const saved = system.time;
  let best: LaunchWindow = { ut: from, heading: 90, inclination: Math.abs(site.lat) };
  let bestCost = Infinity;
  for (let k = 0; k <= 288; k++) {
    const t = from + k * 300;
    system.update(t);
    CelestialBody.dirFromLatLon(site.lat * DEG, site.lon * DEG, _s).applyQuaternion(earth.rotation).normalize();
    moon.relativeStateAt(t + TRANSFER_TIME, _m);
    _m.normalize();
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
      best = { ut: t, heading, inclination: Math.acos(Math.min(1, Math.abs(_n.dot(POLE)))) / DEG };
    }
  }
  system.update(saved);
  return best;
}
