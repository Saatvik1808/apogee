/**
 * LEARNING NOTE: Vector icons as data
 *
 * Navball markers follow the conventions pilots of space-sim games know:
 * prograde (circle with three prongs) where you're going, retrograde (circle with
 * a cross) the opposite way, normal/anti-normal (triangles) perpendicular to the
 * orbit plane, radial in/out toward/away from the planet, target, and maneuver.
 * SVG keeps them crisp at any display density.
 *
 * Key concepts: SVG, icon systems
 */
import type { SASMode } from '../sim/Vessel';

const svg = (inner: string, color: string, size = 24) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const MARKER_COLORS: Record<string, string> = {
  prograde: '#d8f53a',
  retrograde: '#d8f53a',
  normal: '#d46bff',
  antinormal: '#d46bff',
  'radial-out': '#40e3ff',
  'radial-in': '#40e3ff',
  target: '#ff5ad2',
  'anti-target': '#ff5ad2',
  maneuver: '#4d8dff',
  stability: '#e8eef7',
  port: '#6ff2a4',
};

const SHAPES: Record<SASMode, string> = {
  stability: '<circle cx="12" cy="12" r="7"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  prograde: '<circle cx="12" cy="12" r="6"/><path d="M12 6V2M6 12H2M18 12h4"/>',
  retrograde: '<circle cx="12" cy="12" r="6"/><path d="M8 8l8 8M16 8l-8 8M12 18v4M7 16l-3 3M17 16l3 3"/>',
  normal: '<path d="M12 4l8 14H4z"/><circle cx="12" cy="13" r="1.2" fill="currentColor"/>',
  antinormal: '<path d="M12 20L4 6h16z"/><path d="M12 6V2M4 6L1 4M20 6l3-2"/>',
  'radial-out': '<circle cx="12" cy="12" r="5"/><path d="M12 7V2M12 17v5M7 12H2M17 12h5"/>',
  'radial-in': '<circle cx="12" cy="12" r="8"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
  target: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5"/><path d="M12 6V2M12 18v4M6 12H2M18 12h4"/>',
  'anti-target': '<circle cx="12" cy="12" r="6"/><path d="M8 8l8 8M16 8l-8 8"/>',
  maneuver: '<circle cx="12" cy="12" r="7"/><path d="M12 5l3 5h-6zM5 16l5-2v3zM19 16l-5-2v3z"/>',
  port: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
};

export function sasIcon(mode: SASMode, size = 22, color?: string): string {
  return svg(SHAPES[mode], color ?? MARKER_COLORS[mode] ?? '#fff', size);
}

export const RETICLE_SVG =
  '<svg viewBox="0 0 64 22" width="64" height="22" fill="none" stroke="#ffb13b" stroke-width="3" stroke-linecap="round"><path d="M2 11h18l6 7M62 11H44l-6 7"/><circle cx="32" cy="11" r="2.4" fill="#ffb13b"/></svg>';

export const ICONS = {
  pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11 6v12l-8-6zM20 6v12l-8-6z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13 6v12l8-6zM4 6v12l8-6z"/></svg>',
  map: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-20 12 12)"/></svg>',
};
