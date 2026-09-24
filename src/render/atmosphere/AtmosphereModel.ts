/**
 * LEARNING NOTE: Physically based atmospheric scattering
 *
 * The sky is blue because air molecules scatter short wavelengths far more than
 * long ones (Rayleigh scattering ∝ 1/λ⁴). Sunsets are red because sunlight crossing
 * hundreds of km of air loses its blue before reaching you. Haze and the bright halo
 * around the Sun come from aerosols (Mie scattering, strongly forward-peaked).
 * Ozone absorbs orange light high up, which keeps the twilight sky blue.
 *
 * Rendering it: for every pixel we march along the view ray and add light scattered
 * toward the eye at each step, attenuated by the air between (transmittance
 * T = e^(−∫σ_t ds)). The expensive inner question — "how much sunlight reaches this
 * point?" — only depends on altitude and sun angle, so we PRECOMPUTE it into a
 * lookup table (LUT). A second LUT approximates light that scattered many times
 * (Hillaire 2020), which is what makes the horizon glow and the twilight sky rich.
 *
 * LUTs are computed on the CPU at start-up (tens of milliseconds) and uploaded as
 * textures; the same data gives the CPU the sunlight colour at the rocket.
 *
 * Key concepts: Rayleigh & Mie scattering, phase functions, optical depth,
 * transmittance, single vs. multiple scattering, lookup tables
 * Further reading: Bruneton, "Precomputed Atmospheric Scattering" (2017 impl.);
 * Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique" (EGSR 2020).
 */
import { ClampToEdgeWrapping, DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat } from 'three';

export interface AtmosphereParams {
  bottomRadius: number;
  topRadius: number;
  rayleighScattering: [number, number, number];
  rayleighScale: number;
  mieScattering: [number, number, number];
  mieExtinction: [number, number, number];
  mieScale: number;
  mieG: number;
  absorption: [number, number, number];
  absorptionCenter: number;
  absorptionWidth: number;
  groundAlbedo: [number, number, number];
  /** Multiplier for the sun's radiance at the top of this atmosphere. */
  sunIntensity: number;
}

export const EARTH_ATMOSPHERE: AtmosphereParams = {
  bottomRadius: 6_371_000,
  topRadius: 6_471_000,
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighScale: 8000,
  mieScattering: [3.996e-6, 3.996e-6, 3.996e-6],
  mieExtinction: [4.44e-6, 4.44e-6, 4.44e-6],
  mieScale: 1200,
  mieG: 0.8,
  absorption: [0.65e-6, 1.881e-6, 0.085e-6],
  absorptionCenter: 25_000,
  absorptionWidth: 15_000,
  groundAlbedo: [0.3, 0.3, 0.3],
  sunIntensity: 1,
};

/** Mars: thin CO₂ with reddish dust — butterscotch days, blue sunsets. */
export const MARS_ATMOSPHERE: AtmosphereParams = {
  bottomRadius: 3_396_000,
  topRadius: 3_396_000 + 90_000,
  rayleighScattering: [0.19918e-6, 0.1357e-6, 0.0575e-6],
  rayleighScale: 11_000,
  // Dust absorbs blue: scattering stronger in red, extinction flatter
  mieScattering: [6.2e-6, 4.2e-6, 2.5e-6],
  mieExtinction: [7.0e-6, 6.6e-6, 6.3e-6],
  mieScale: 11_000,
  mieG: 0.72,
  absorption: [0, 0, 0],
  absorptionCenter: 0,
  absorptionWidth: 1,
  groundAlbedo: [0.35, 0.22, 0.14],
  sunIntensity: 0.43,
};

export const TRANSMITTANCE_W = 256;
export const TRANSMITTANCE_H = 64;
export const MS_SIZE = 32;
export const AMBIENT_SIZE = 64;

type Vec3 = [number, number, number];

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export class AtmosphereLUTs {
  readonly params: AtmosphereParams;
  readonly transmittance: Float32Array;
  readonly multiScattering: Float32Array;
  /** Ground irradiance from the sky (not direct sun) vs. sun zenith cosine. */
  readonly ambient: Float32Array;
  readonly transmittanceTexture: DataTexture;
  readonly multiScatteringTexture: DataTexture;
  readonly ambientTexture: DataTexture;

  constructor(params: AtmosphereParams) {
    this.params = params;
    this.transmittance = new Float32Array(TRANSMITTANCE_W * TRANSMITTANCE_H * 4);
    this.multiScattering = new Float32Array(MS_SIZE * MS_SIZE * 4);
    this.ambient = new Float32Array(AMBIENT_SIZE * 4);
    this.computeTransmittance();
    this.computeMultiScattering();
    this.computeAmbient();
    this.transmittanceTexture = this.toTexture(this.transmittance, TRANSMITTANCE_W, TRANSMITTANCE_H);
    this.multiScatteringTexture = this.toTexture(this.multiScattering, MS_SIZE, MS_SIZE);
    this.ambientTexture = this.toTexture(this.ambient, AMBIENT_SIZE, 1);
  }

  private toTexture(data: Float32Array, w: number, h: number): DataTexture {
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) half[i] = DataUtils.toHalfFloat(data[i]!);
    const t = new DataTexture(half, w, h, RGBAFormat, HalfFloatType);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  // ---------------------------------------------------------------------------
  densityAt(h: number, out: Vec3): Vec3 {
    const p = this.params;
    out[0] = Math.exp(-Math.max(0, h) / p.rayleighScale);
    out[1] = Math.exp(-Math.max(0, h) / p.mieScale);
    out[2] = Math.max(0, 1 - Math.abs(h - p.absorptionCenter) / p.absorptionWidth);
    return out;
  }

  extinctionAt(h: number, out: Vec3): Vec3 {
    const p = this.params;
    const d = this.densityAt(h, _d);
    for (let c = 0; c < 3; c++) {
      out[c] = p.rayleighScattering[c]! * d[0] + p.mieExtinction[c]! * d[1] + p.absorption[c]! * d[2];
    }
    return out;
  }

  scatteringAt(h: number, out: Vec3): Vec3 {
    const p = this.params;
    const d = this.densityAt(h, _d);
    for (let c = 0; c < 3; c++) out[c] = p.rayleighScattering[c]! * d[0] + p.mieScattering[c]! * d[1];
    return out;
  }

  distanceToTop(r: number, mu: number): number {
    const top = this.params.topRadius;
    const disc = r * r * (mu * mu - 1) + top * top;
    return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
  }

  distanceToBottom(r: number, mu: number): number {
    const bottom = this.params.bottomRadius;
    const disc = r * r * (mu * mu - 1) + bottom * bottom;
    return Math.max(0, -r * mu - Math.sqrt(Math.max(0, disc)));
  }

  rayIntersectsGround(r: number, mu: number): boolean {
    const b = this.params.bottomRadius;
    return mu < 0 && r * r * (mu * mu - 1) + b * b >= 0;
  }

  // ---------------------------------------------------------------------------
  private computeTransmittance(): void {
    const p = this.params;
    const H = Math.sqrt(p.topRadius * p.topRadius - p.bottomRadius * p.bottomRadius);
    const ext: Vec3 = [0, 0, 0];
    const N = 300;
    for (let j = 0; j < TRANSMITTANCE_H; j++) {
      for (let i = 0; i < TRANSMITTANCE_W; i++) {
        const xMu = (i + 0.5) / TRANSMITTANCE_W;
        const xR = (j + 0.5) / TRANSMITTANCE_H;
        const rho = H * xR;
        const r = Math.sqrt(rho * rho + p.bottomRadius * p.bottomRadius);
        const dMin = p.topRadius - r;
        const dMax = rho + H;
        const d = dMin + xMu * (dMax - dMin);
        const mu = d === 0 ? 1 : clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
        const dist = this.distanceToTop(r, mu);
        let tr = 0;
        let tg = 0;
        let tb = 0;
        const dx = dist / N;
        for (let k = 0; k <= N; k++) {
          const t = k * dx;
          const rr = Math.sqrt(t * t + 2 * r * mu * t + r * r);
          this.extinctionAt(rr - p.bottomRadius, ext);
          const w = k === 0 || k === N ? 0.5 : 1;
          tr += ext[0] * w;
          tg += ext[1] * w;
          tb += ext[2] * w;
        }
        const o = (j * TRANSMITTANCE_W + i) * 4;
        this.transmittance[o] = Math.exp(-tr * dx);
        this.transmittance[o + 1] = Math.exp(-tg * dx);
        this.transmittance[o + 2] = Math.exp(-tb * dx);
        this.transmittance[o + 3] = 1;
      }
    }
  }

  /** Bilinear CPU lookup of transmittance from (r, μ) to the top of the atmosphere. */
  sampleTransmittance(r: number, mu: number, out: Vec3): Vec3 {
    const p = this.params;
    r = clamp(r, p.bottomRadius, p.topRadius);
    const H = Math.sqrt(p.topRadius * p.topRadius - p.bottomRadius * p.bottomRadius);
    const rho = Math.sqrt(Math.max(0, r * r - p.bottomRadius * p.bottomRadius));
    const d = this.distanceToTop(r, mu);
    const dMin = p.topRadius - r;
    const dMax = rho + H;
    const xMu = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0;
    const xR = rho / H;
    const fx = clamp(xMu * TRANSMITTANCE_W - 0.5, 0, TRANSMITTANCE_W - 1);
    const fy = clamp(xR * TRANSMITTANCE_H - 0.5, 0, TRANSMITTANCE_H - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, TRANSMITTANCE_W - 1);
    const y1 = Math.min(y0 + 1, TRANSMITTANCE_H - 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const T = this.transmittance;
    for (let c = 0; c < 3; c++) {
      const v00 = T[(y0 * TRANSMITTANCE_W + x0) * 4 + c]!;
      const v10 = T[(y0 * TRANSMITTANCE_W + x1) * 4 + c]!;
      const v01 = T[(y1 * TRANSMITTANCE_W + x0) * 4 + c]!;
      const v11 = T[(y1 * TRANSMITTANCE_W + x1) * 4 + c]!;
      out[c] = (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
    }
    return out;
  }

  /** Sunlight transmittance with a soft planet-shadow terminator. */
  sunTransmittance(r: number, muS: number, out: Vec3): Vec3 {
    const p = this.params;
    const rr = Math.max(r, p.bottomRadius + 1);
    const muHorizon = -Math.sqrt(Math.max(0, 1 - (p.bottomRadius / rr) ** 2));
    this.sampleTransmittance(rr, Math.max(muS, muHorizon + 1e-4), out);
    const sinH = p.bottomRadius / rr;
    const cosH = -Math.sqrt(Math.max(0, 1 - sinH * sinH));
    const sunRad = 0.00465;
    const vis = clamp((muS - cosH) / (2 * sunRad) + 0.5, 0, 1);
    out[0] *= vis;
    out[1] *= vis;
    out[2] *= vis;
    return out;
  }

  // ---------------------------------------------------------------------------
  private computeMultiScattering(): void {
    const p = this.params;
    const NDIR = 64;
    const NSTEP = 20;
    const dirs: Array<[number, number, number]> = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NDIR; i++) {
      const y = 1 - (2 * (i + 0.5)) / NDIR;
      const rad = Math.sqrt(1 - y * y);
      const th = golden * i;
      dirs.push([Math.cos(th) * rad, y, Math.sin(th) * rad]);
    }
    const sc: Vec3 = [0, 0, 0];
    const ex: Vec3 = [0, 0, 0];
    const ts: Vec3 = [0, 0, 0];
    const isoPhase = 1 / (4 * Math.PI);
    for (let j = 0; j < MS_SIZE; j++) {
      for (let i = 0; i < MS_SIZE; i++) {
        const muS = -1 + (2 * (i + 0.5)) / MS_SIZE;
        const h = ((j + 0.5) / MS_SIZE) * (p.topRadius - p.bottomRadius);
        const r = p.bottomRadius + h;
        const sunDir: Vec3 = [0, muS, Math.sqrt(Math.max(0, 1 - muS * muS))];
        const L2: Vec3 = [0, 0, 0];
        const fms: Vec3 = [0, 0, 0];
        for (const w of dirs) {
          const mu = w[1];
          const hitsGround = this.rayIntersectsGround(r, mu);
          const tMax = hitsGround ? this.distanceToBottom(r, mu) : this.distanceToTop(r, mu);
          const dt = tMax / NSTEP;
          const T: Vec3 = [1, 1, 1];
          for (let k = 0; k < NSTEP; k++) {
            const t = (k + 0.5) * dt;
            // position relative to planet centre: (0, r, 0) + w·t
            const px = w[0] * t;
            const py = r + w[1] * t;
            const pz = w[2] * t;
            const pr = Math.sqrt(px * px + py * py + pz * pz);
            const ph = pr - p.bottomRadius;
            this.scatteringAt(ph, sc);
            this.extinctionAt(ph, ex);
            const muSp = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / pr;
            this.sunTransmittance(pr, muSp, ts);
            for (let c = 0; c < 3; c++) {
              const stepT = Math.exp(-ex[c]! * dt);
              // analytic integration of the segment
              const sInt = (sc[c]! * (1 - stepT)) / Math.max(ex[c]!, 1e-12);
              L2[c] += T[c]! * sInt * ts[c]! * isoPhase;
              fms[c] += T[c]! * sInt;
              T[c] *= stepT;
            }
          }
          if (hitsGround) {
            // Ground bounce: Lambertian albedo lit by attenuated sun
            const gx = w[0] * tMax;
            const gy = r + w[1] * tMax;
            const gz = w[2] * tMax;
            const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
            const muG = (gx * sunDir[0] + gy * sunDir[1] + gz * sunDir[2]) / gr;
            this.sunTransmittance(gr, muG, ts);
            const cosG = Math.max(0, muG);
            for (let c = 0; c < 3; c++) L2[c] += (T[c]! * ts[c]! * cosG * p.groundAlbedo[c]!) / Math.PI;
          }
        }
        const o = (j * MS_SIZE + i) * 4;
        for (let c = 0; c < 3; c++) {
          // Ψ_ms = L_2nd / (1 − f_ms): geometric series of infinitely many bounces
          const l2 = L2[c]! / NDIR;
          const f = fms[c]! / NDIR;
          this.multiScattering[o + c] = l2 / (1 - Math.min(0.99, f));
        }
        this.multiScattering[o + 3] = 1;
      }
    }
  }

  /**
   * Sky irradiance on a horizontal surface at ground level (single + multiple
   * scattering integrated over the upper hemisphere), vs. sun zenith cosine.
   */
  private computeAmbient(): void {
    const p = this.params;
    const r = p.bottomRadius + 1;
    const NSTEP = 16;
    const dirs: Array<[number, number, number]> = [];
    for (let i = 0; i < 48; i++) {
      // cosine-weighted-ish hemisphere set
      const u = (i + 0.5) / 48;
      const y = Math.sqrt(u);
      const rad = Math.sqrt(1 - y * y);
      const th = i * 2.39996;
      dirs.push([Math.cos(th) * rad, y, Math.sin(th) * rad]);
    }
    const sc: Vec3 = [0, 0, 0];
    const ex: Vec3 = [0, 0, 0];
    const ts: Vec3 = [0, 0, 0];
    for (let i = 0; i < AMBIENT_SIZE; i++) {
      const muS = -0.35 + (1.35 * (i + 0.5)) / AMBIENT_SIZE;
      const sunDir: Vec3 = [0, muS, Math.sqrt(Math.max(0, 1 - muS * muS))];
      const E: Vec3 = [0, 0, 0];
      for (const w of dirs) {
        const tMax = this.distanceToTop(r, w[1]);
        const dt = tMax / NSTEP;
        const T: Vec3 = [1, 1, 1];
        const L: Vec3 = [0, 0, 0];
        const nu = w[0] * sunDir[0] + w[1] * sunDir[1] + w[2] * sunDir[2];
        const phR = (3 / (16 * Math.PI)) * (1 + nu * nu);
        const g = p.mieG;
        const phM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + nu * nu))) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * nu, 1.5));
        for (let k = 0; k < NSTEP; k++) {
          const t = (k + 0.5) * dt;
          const px = w[0] * t;
          const py = r + w[1] * t;
          const pz = w[2] * t;
          const pr = Math.sqrt(px * px + py * py + pz * pz);
          const ph = pr - p.bottomRadius;
          const d = this.densityAt(ph, _d);
          this.extinctionAt(ph, ex);
          this.scatteringAt(ph, sc);
          const muSp = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / pr;
          this.sunTransmittance(pr, muSp, ts);
          const ms = this.sampleMS(ph, muSp);
          for (let c = 0; c < 3; c++) {
            const rs = p.rayleighScattering[c]! * d[0];
            const msc = p.mieScattering[c]! * d[1];
            const S = ts[c]! * (rs * phR + msc * phM) + sc[c]! * ms[c]!;
            const stepT = Math.exp(-ex[c]! * dt);
            L[c] += (T[c]! * S * (1 - stepT)) / Math.max(ex[c]!, 1e-12);
            T[c] *= stepT;
          }
        }
        // Cosine-weighted sampling → E = π · mean(L)
        for (let c = 0; c < 3; c++) E[c] += L[c]!;
      }
      const o = i * 4;
      for (let c = 0; c < 3; c++) this.ambient[o + c] = (Math.PI * E[c]!) / dirs.length;
      this.ambient[o + 3] = 1;
    }
  }

  sampleMS(h: number, muS: number): Vec3 {
    const p = this.params;
    const fx = clamp(((muS + 1) / 2) * MS_SIZE - 0.5, 0, MS_SIZE - 1);
    const fy = clamp((h / (p.topRadius - p.bottomRadius)) * MS_SIZE - 0.5, 0, MS_SIZE - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, MS_SIZE - 1);
    const y1 = Math.min(y0 + 1, MS_SIZE - 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const M = this.multiScattering;
    for (let c = 0; c < 3; c++) {
      const v00 = M[(y0 * MS_SIZE + x0) * 4 + c]!;
      const v10 = M[(y0 * MS_SIZE + x1) * 4 + c]!;
      const v01 = M[(y1 * MS_SIZE + x0) * 4 + c]!;
      const v11 = M[(y1 * MS_SIZE + x1) * 4 + c]!;
      _ms[c] = (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
    }
    return _ms;
  }

  /** Sky ambient irradiance at ground for a sun zenith cosine (CPU). */
  sampleAmbient(muS: number, out: Vec3): Vec3 {
    const f = clamp(((muS + 0.35) / 1.35) * AMBIENT_SIZE - 0.5, 0, AMBIENT_SIZE - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, AMBIENT_SIZE - 1);
    const a = f - i0;
    for (let c = 0; c < 3; c++) out[c] = this.ambient[i0 * 4 + c]! * (1 - a) + this.ambient[i1 * 4 + c]! * a;
    return out;
  }
}

const _d: Vec3 = [0, 0, 0];
const _ms: Vec3 = [0, 0, 0];
