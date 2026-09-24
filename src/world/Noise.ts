/**
 * LEARNING NOTE: Gradient noise for natural detail
 *
 * Real elevation data at planetary scale has ~2–7 km per pixel — far too coarse to
 * land on. We add procedural detail with SIMPLEX NOISE: a smooth pseudo-random
 * function that is continuous everywhere and cheap to evaluate. Summing octaves of
 * noise at doubling frequency and halving amplitude ("fractional Brownian
 * motion") produces the self-similar roughness of real terrain.
 *
 * It must be deterministic (same input → same output) because both the renderer
 * and the physics query the same terrain and must agree to the centimetre.
 *
 * Key concepts: simplex noise, octaves, fBm, determinism
 * Further reading: Stefan Gustavson, "Simplex noise demystified" (2005)
 */

const F3 = 1 / 3;
const G3 = 1 / 6;
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class SimplexNoise {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed = 1337) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed >>> 0;
    for (let i = 255; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255]!;
      this.permMod12[i] = this.perm[i]! % 12;
    }
  }

  /** 3D simplex noise in [-1, 1]. */
  noise3(xin: number, yin: number, zin: number): number {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi = pm[ii + perm[jj + perm[kk]!]!]! * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi]! * x0 + GRAD3[gi + 1]! * y0 + GRAD3[gi + 2]! * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi = pm[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]! * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi]! * x1 + GRAD3[gi + 1]! * y1 + GRAD3[gi + 2]! * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi = pm[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]! * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi]! * x2 + GRAD3[gi + 1]! * y2 + GRAD3[gi + 2]! * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi = pm[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]! * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[gi]! * x3 + GRAD3[gi + 1]! * y3 + GRAD3[gi + 2]! * z3);
    }
    return 32 * n;
  }

  /**
   * fBm over octaves whose wavelength ≥ minWavelength.
   * @param x,y,z position in metres
   * @param baseWavelength largest wavelength (m)
   */
  fbm(x: number, y: number, z: number, baseWavelength: number, octaves: number, minWavelength: number, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let wl = baseWavelength;
    for (let o = 0; o < octaves; o++) {
      if (wl < minWavelength) {
        // Smoothly fade the octave that straddles the LOD cutoff to avoid popping
        break;
      }
      const f = 1 / wl;
      const fade = Math.min(1, (wl - minWavelength) / minWavelength);
      sum += amp * fade * this.noise3(x * f + o * 17.1, y * f - o * 9.7, z * f + o * 3.3);
      amp *= gain;
      wl *= 0.5;
    }
    return sum;
  }

  /** Ridged multifractal (sharp crests) for mountains. */
  ridged(x: number, y: number, z: number, baseWavelength: number, octaves: number, minWavelength: number): number {
    let amp = 0.5;
    let sum = 0;
    let wl = baseWavelength;
    let prev = 1;
    for (let o = 0; o < octaves; o++) {
      if (wl < minWavelength) break;
      const f = 1 / wl;
      let n = 1 - Math.abs(this.noise3(x * f + o * 5.3, y * f + o * 1.7, z * f - o * 8.1));
      n *= n;
      const fade = Math.min(1, (wl - minWavelength) / minWavelength);
      sum += n * amp * prev * fade;
      prev = n;
      amp *= 0.5;
      wl *= 0.5;
    }
    return sum;
  }
}
