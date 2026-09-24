/**
 * LEARNING NOTE: Numeric helpers for a real-scale universe
 *
 * JavaScript numbers are 64-bit doubles (~15-16 significant digits). That is enough
 * to place a rocket anywhere in the solar system to sub-millimetre accuracy, which
 * is why all physics here runs on the CPU in doubles. GPUs, however, work in 32-bit
 * floats (~7 digits) — so before anything is drawn we subtract the camera position
 * ("floating origin") to keep the numbers the GPU sees small.
 *
 * Key concepts: floating-point precision, interpolation, easing, angle wrapping
 */
import { TAU } from './constants';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  return lerp(outLo, outHi, clamp01(inverseLerp(inLo, inHi, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential smoothing factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Wrap angle to (-PI, PI]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Wrap angle to [0, TAU). */
export function wrapTau(a: number): number {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

export function sign(v: number): number {
  return v < 0 ? -1 : 1;
}

/** Deterministic hash → [0,1). Used for procedural placement that must not change between runs. */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Small seeded PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (!isFinite(a)) return '∞';
  if (a < 1_000) return `${m.toFixed(a < 10 ? 1 : 0)} m`;
  if (a < 1_000_000) return `${(m / 1000).toFixed(a < 100_000 ? 2 : 1)} km`;
  if (a < 1e9) return `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;
  return `${(m / 1.495978707e11).toFixed(3)} AU`;
}

export function formatSpeed(v: number): string {
  const a = Math.abs(v);
  if (a < 1000) return `${v.toFixed(1)} m/s`;
  return `${(v / 1000).toFixed(3)} km/s`;
}

export function formatMass(kg: number): string {
  if (kg < 1000) return `${kg.toFixed(0)} kg`;
  return `${(kg / 1000).toFixed(kg < 100_000 ? 2 : 1)} t`;
}

export function formatForce(n: number): string {
  if (n < 1e6) return `${(n / 1000).toFixed(1)} kN`;
  return `${(n / 1e6).toFixed(2)} MN`;
}

/** Mission-elapsed style duration: 1d 02:03:04 */
export function formatDuration(seconds: number, showSign = false): string {
  if (!isFinite(seconds)) return '—';
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const core = d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return (neg ? '-' : showSign ? '+' : '') + core;
}

export function formatMoney(v: number): string {
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
