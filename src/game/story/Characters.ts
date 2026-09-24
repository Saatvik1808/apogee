/**
 * LEARNING NOTE: A cast for Mission Control
 *
 * Real spaceflight is a team sport, and games borrow that structure for their
 * storytelling: a program director who sets the stakes, a flight director who
 * owns every decision once the rocket is off the pad, a capsule communicator
 * ("CAPCOM") who is the only voice the crew hears, an engineer who explains the
 * physics, and the astronauts themselves. Giving each role one consistent voice
 * lets short radio lines carry both story and teaching.
 *
 * Portraits are tiny generated SVGs (a coloured badge, a head-and-shoulders
 * silhouette and role details such as a headset) — no image files to load, and
 * they stay crisp at any size.
 *
 * Key concepts: narrative roles, consistent voice, procedural icons (SVG)
 */
export type CharacterId = 'director' | 'flight' | 'capcom' | 'engineer' | 'kenji' | 'sofia' | 'priya' | 'news';

export interface Character {
  id: CharacterId;
  name: string;
  role: string;
  /** Badge colour. */
  color: string;
  hair: 'short' | 'long' | 'bun' | 'crop' | 'none';
  headset: boolean;
}

export const CAST: Record<CharacterId, Character> = {
  director: { id: 'director', name: 'Amara Okafor', role: 'Program Director', color: '#ff8a3d', hair: 'bun', headset: false },
  flight: { id: 'flight', name: 'Ray Castillo', role: 'Flight Director', color: '#5ad8ff', hair: 'short', headset: true },
  capcom: { id: 'capcom', name: 'Jo Lindqvist', role: 'CAPCOM', color: '#6ff2a4', hair: 'long', headset: true },
  engineer: { id: 'engineer', name: 'Dr. Lena Hartmann', role: 'Chief Engineer', color: '#ffd65a', hair: 'crop', headset: false },
  kenji: { id: 'kenji', name: 'Kenji Watanabe', role: 'Commander', color: '#d46bff', hair: 'short', headset: true },
  sofia: { id: 'sofia', name: 'Dr. Sofia Reyes', role: 'Mission Scientist', color: '#ff6bd6', hair: 'long', headset: false },
  priya: { id: 'priya', name: 'Priya Raman', role: 'Station Commander', color: '#ffa657', hair: 'bun', headset: true },
  news: { id: 'news', name: 'Orbital News', role: 'Broadcast', color: '#93a1b5', hair: 'none', headset: false },
};

const HAIR: Record<Character['hair'], string> = {
  short: '<path d="M21 23c0-7 5-11 11-11s11 4 11 11c-2-3-6-5-11-5s-9 2-11 5z"/>',
  long: '<path d="M20 24c0-8 5-12 12-12s12 4 12 12v14c-2-2-3-6-3-10-3-4-6-6-9-6s-6 2-9 6c0 4-1 8-3 10z"/>',
  bun: '<circle cx="32" cy="10" r="5"/><path d="M21 24c0-7 5-11 11-11s11 4 11 11c-2-3-6-5-11-5s-9 2-11 5z"/>',
  crop: '<path d="M21 22c1-6 5-10 11-10s10 4 11 10c-3-2-7-3-11-3s-8 1-11 3z"/>',
  none: '',
};

/** Head-and-shoulders portrait badge as an SVG string. */
export function portraitSvg(id: CharacterId, size = 44): string {
  const c = CAST[id];
  if (id === 'news') {
    return `<svg viewBox="0 0 64 64" width="${size}" height="${size}"><circle cx="32" cy="32" r="31" fill="#1a2230" stroke="${c.color}" stroke-width="2"/><path d="M18 22h28v20H18z" fill="none" stroke="${c.color}" stroke-width="3"/><path d="M24 28h16M24 34h10" stroke="${c.color}" stroke-width="3" stroke-linecap="round"/></svg>`;
  }
  const headset = c.headset
    ? `<path d="M19 30c0-9 6-15 13-15s13 6 13 15" fill="none" stroke="#0b1019" stroke-width="3"/><rect x="16.5" y="28" width="5" height="9" rx="2" fill="#0b1019"/><path d="M19 36c0 5 4 8 9 8" fill="none" stroke="#0b1019" stroke-width="2"/><circle cx="29" cy="44" r="2" fill="#0b1019"/>`
    : '';
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}">
<defs><radialGradient id="pg-${id}" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="${c.color}" stop-opacity="0.55"/><stop offset="1" stop-color="#0b1019"/></radialGradient>
<clipPath id="pc-${id}"><circle cx="32" cy="32" r="30"/></clipPath></defs>
<circle cx="32" cy="32" r="31" fill="url(#pg-${id})" stroke="${c.color}" stroke-width="2"/>
<g clip-path="url(#pc-${id})" fill="#e8eef7" fill-opacity="0.92">
<path d="M10 64c1-12 10-18 22-18s21 6 22 18z"/>
<ellipse cx="32" cy="27" rx="10" ry="12"/>
</g>
<g fill="${c.color}" fill-opacity="0.9">${HAIR[c.hair]}</g>
${headset}
</svg>`;
}
