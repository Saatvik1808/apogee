/**
 * LEARNING NOTE: Modelling the atmosphere
 *
 * Air density falls off roughly exponentially with altitude (halving about every
 * 5.5 km near the ground). Density drives drag and heating; pressure changes
 * engine performance (nozzles designed for vacuum perform poorly at sea level);
 * temperature sets the speed of sound and therefore the Mach number.
 *
 * Earth uses the U.S. Standard Atmosphere 1976: seven layers with linear
 * temperature lapse rates up to 86 km (solved in closed form with the barometric
 * formula), then a tabulated density profile up to 1000 km interpolated in log
 * space. Mars uses a simple exponential fit to Viking/Curiosity data.
 *
 * Key concepts: barometric formula, lapse rate, scale height, dynamic pressure
 * q = ½ρv², speed of sound a = √(γRT), Mach number
 * Further reading: https://ntrs.nasa.gov/citations/19770009539 (USSA 1976)
 */

export interface AtmosphereSample {
  /** Pressure (Pa) */
  pressure: number;
  /** Density (kg/m³) */
  density: number;
  /** Temperature (K) */
  temperature: number;
  /** Speed of sound (m/s) */
  speedOfSound: number;
}

export interface AtmosphereModel {
  /** Altitude above which the atmosphere is treated as vacuum for gameplay (m). */
  readonly ceiling: number;
  readonly seaLevelPressure: number;
  sample(altitude: number, out: AtmosphereSample): AtmosphereSample;
}

export function createAtmosphereSample(): AtmosphereSample {
  return { pressure: 0, density: 0, temperature: 0, speedOfSound: 300 };
}

const R_AIR = 287.053;
const GAMMA_AIR = 1.4;
const G0 = 9.80665;
const R_EARTH_GEOPOTENTIAL = 6356766;

// Base geopotential altitude (m), base temperature (K), lapse (K/m), base pressure (Pa)
const USSA_LAYERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 288.15, -0.0065, 101325],
  [11000, 216.65, 0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.956420],
  [84852, 186.946, 0, 0.3734],
];

// Upper atmosphere (geometric altitude km, density kg/m³, temperature K)
const UPPER: ReadonlyArray<readonly [number, number, number]> = [
  [86, 6.958e-6, 186.87],
  [90, 3.416e-6, 186.87],
  [100, 5.604e-7, 195.08],
  [110, 9.708e-8, 240.0],
  [120, 2.222e-8, 360.0],
  [130, 8.152e-9, 469.27],
  [140, 3.831e-9, 559.63],
  [150, 2.076e-9, 634.39],
  [160, 1.233e-9, 696.29],
  [180, 5.194e-10, 790.07],
  [200, 2.541e-10, 854.56],
  [250, 6.073e-11, 941.33],
  [300, 1.916e-11, 976.01],
  [400, 2.803e-12, 995.83],
  [500, 5.215e-13, 999.24],
  [600, 1.137e-13, 999.85],
  [700, 3.07e-14, 999.97],
  [800, 1.136e-14, 999.99],
  [900, 5.759e-15, 1000],
  [1000, 3.561e-15, 1000],
];
const UPPER_LOG = UPPER.map(([h, rho, t]) => [h * 1000, Math.log(rho), t] as const);

export class EarthAtmosphere implements AtmosphereModel {
  readonly ceiling = 140_000;
  readonly seaLevelPressure = 101325;

  sample(altitude: number, out: AtmosphereSample): AtmosphereSample {
    const h = Math.max(-1000, altitude);
    if (h < 86000) {
      // Geometric → geopotential altitude
      const hg = (R_EARTH_GEOPOTENTIAL * h) / (R_EARTH_GEOPOTENTIAL + h);
      let layer = USSA_LAYERS[0]!;
      for (let i = USSA_LAYERS.length - 1; i >= 0; i--) {
        const l = USSA_LAYERS[i]!;
        if (hg >= l[0]) {
          layer = l;
          break;
        }
      }
      const [hb, tb, lapse, pb] = layer;
      const dh = hg - hb;
      const t = tb + lapse * dh;
      let p: number;
      if (Math.abs(lapse) < 1e-12) {
        p = pb * Math.exp((-G0 * dh) / (R_AIR * tb));
      } else {
        p = pb * Math.pow(tb / t, G0 / (R_AIR * lapse));
      }
      out.temperature = t;
      out.pressure = p;
      out.density = p / (R_AIR * t);
      out.speedOfSound = Math.sqrt(GAMMA_AIR * R_AIR * t);
      return out;
    }
    if (h >= 1_000_000) {
      out.temperature = 1000;
      out.density = 0;
      out.pressure = 0;
      out.speedOfSound = 600;
      return out;
    }
    let i = 0;
    while (i < UPPER_LOG.length - 2 && UPPER_LOG[i + 1]![0] <= h) i++;
    const a = UPPER_LOG[i]!;
    const b = UPPER_LOG[i + 1]!;
    const f = (h - a[0]) / (b[0] - a[0]);
    const rho = Math.exp(a[1] + (b[1] - a[1]) * f);
    const t = a[2] + (b[2] - a[2]) * f;
    out.temperature = t;
    out.density = rho;
    // Pressure from ideal gas with rough mean molar mass drop — negligible for gameplay
    out.pressure = rho * R_AIR * t;
    out.speedOfSound = Math.sqrt(GAMMA_AIR * R_AIR * Math.min(t, 300));
    return out;
  }
}

/** Mars: thin CO₂ atmosphere (≈0.6% of Earth's surface pressure). */
export class MarsAtmosphere implements AtmosphereModel {
  readonly ceiling = 120_000;
  readonly seaLevelPressure = 610;

  sample(altitude: number, out: AtmosphereSample): AtmosphereSample {
    const h = Math.max(-8000, altitude);
    // NASA Glenn Mars model (Mars Global Surveyor fit)
    let t: number;
    let p: number;
    if (h > 7000) {
      t = -23.4 - 0.00222 * h + 273.15;
    } else {
      t = -31 - 0.000998 * h + 273.15;
    }
    t = Math.max(t, 130);
    p = 610 * Math.exp(-0.00009 * h);
    if (h > 80_000) p *= Math.exp(-(h - 80_000) / 7000);
    const R_CO2 = 188.92;
    out.temperature = t;
    out.pressure = p;
    out.density = p / (R_CO2 * t);
    out.speedOfSound = Math.sqrt(1.29 * R_CO2 * t);
    return out;
  }
}
