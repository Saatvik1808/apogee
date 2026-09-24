/**
 * LEARNING NOTE: Why launch sites matter
 *
 * Earth spins eastward at 465 m/s at the equator (v = ωR·cos(latitude)). Launching
 * east lets a rocket keep that speed for free: +408 m/s from Cape Canaveral
 * (28.6°N), +463 m/s from Kourou (5.2°N). Latitude also sets the LOWEST orbital
 * inclination you can reach directly — you cannot launch into an orbit less
 * inclined than your latitude without an expensive plane change. That is why
 * geostationary launches favour equatorial sites and why Baikonur's satellites
 * start at ~51.6° (the ISS inclination).
 *
 * Key concepts: Earth rotation bonus, launch azimuth, minimum inclination
 */
import type { BodyId } from '../physics/CelestialBody';

export interface LaunchSite {
  id: string;
  name: string;
  short: string;
  body: BodyId;
  /** Geodetic latitude / longitude in degrees (east positive). */
  lat: number;
  lon: number;
  /** Pad surface height above sea level (m). */
  padElevation: number;
  /** Radius of the flattened pad area (m). */
  flattenRadius: number;
  /** Bearing toward the sea (deg from north) and distance to the shoreline (m). */
  seaBearing?: number;
  coastDistance?: number;
  description: string;
}

export const LAUNCH_SITES: LaunchSite[] = [
  {
    id: 'cape',
    name: 'Cape Canaveral · LC-39A',
    short: 'Cape Canaveral',
    body: 'earth',
    lat: 28.6082,
    lon: -80.6041,
    padElevation: 12,
    flattenRadius: 900,
    seaBearing: 80,
    coastDistance: 1700,
    description: 'Florida\'s historic Moon pad. 28.6°N — launch east over the Atlantic for a 408 m/s boost.',
  },
  {
    id: 'kourou',
    name: 'Kourou · ELA-3',
    short: 'Kourou',
    body: 'earth',
    lat: 5.2394,
    lon: -52.7685,
    padElevation: 15,
    flattenRadius: 900,
    seaBearing: 35,
    coastDistance: 2600,
    description: 'Equatorial spaceport in French Guiana. Near-zero inclination orbits and the biggest rotation bonus.',
  },
  {
    id: 'baikonur',
    name: 'Baikonur · Site 1',
    short: 'Baikonur',
    body: 'earth',
    lat: 45.9203,
    lon: 63.3422,
    padElevation: 95,
    flattenRadius: 900,
    description: 'Gagarin\'s Start on the Kazakh steppe. Landlocked: stages fall on land, so plan your recoveries.',
  },
  {
    id: 'vandenberg',
    name: 'Vandenberg · SLC-4E',
    short: 'Vandenberg',
    body: 'earth',
    lat: 34.6321,
    lon: -120.6106,
    padElevation: 110,
    flattenRadius: 900,
    seaBearing: 255,
    coastDistance: 1100,
    description: 'California coast. Launch south over the Pacific into polar and sun-synchronous orbits.',
  },
];

export function getLaunchSite(id: string): LaunchSite {
  return LAUNCH_SITES.find((s) => s.id === id) ?? LAUNCH_SITES[0]!;
}
