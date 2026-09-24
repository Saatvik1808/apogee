/**
 * LEARNING NOTE: Physically based materials for spacecraft
 *
 * PBR ("physically based rendering") describes a surface with a few measurable
 * properties instead of ad-hoc colours: base colour (albedo), METALNESS (metals
 * reflect with tinted specular and have no diffuse), ROUGHNESS (microscopic
 * bumpiness that blurs reflections) and, for car-paint-like finishes, a CLEARCOAT
 * layer. Lit by the same sun and sky as everything else, the same material looks
 * right on the launch pad at dawn and in orbit.
 *
 * Instead of painting textures for every tank size, patterns (roll-pattern
 * checkers, SRB segment bands, hazard stripes, panel seams) are computed in the
 * shader from each part's object-space position — so a 3 m tank and a 40 m tank
 * both get correctly scaled detail. We inject that GLSL into three.js's standard
 * physical shader with `onBeforeCompile`.
 *
 * Small procedural textures (foam, weld seams, solar cells, fabric gores) are drawn
 * with the 2D canvas API at start-up — no image files required.
 *
 * Key concepts: PBR metal/roughness workflow, clearcoat, shader injection,
 * object-space procedural patterns, canvas-generated textures
 */
import {
  BackSide,
  CanvasTexture,
  Color,
  DoubleSide,
  type Material,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  type Side,
  SRGBColorSpace,
} from 'three';

export type PatternKind = 'none' | 'panels' | 'roll' | 'bands' | 'hazard' | 'foam' | 'welds';

interface PaintOptions {
  color: number;
  roughness: number;
  metalness: number;
  clearcoat?: number;
  pattern?: PatternKind;
  patternColor?: number;
  /** Pattern scale (m). */
  scale?: number;
  side?: Side;
  emissive?: number;
}

const cache = new Map<string, Material>();

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Height canvas → tangent-space normal map. */
function normalFromHeight(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, strength: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const src = ctx.getImageData(0, 0, size, size);
  const out = ctx.createImageData(size, size);
  const h = (x: number, y: number) => src.data[(((y + size) % size) * size + ((x + size) % size)) * 4]! / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      out.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[o + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

let rngState = 12345;
function rnd(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 4294967296;
}

let foamNormal: CanvasTexture | null = null;
function getFoamNormal(): CanvasTexture {
  if (foamNormal) return foamNormal;
  foamNormal = normalFromHeight(
    256,
    (ctx, s) => {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 900; i++) {
        const x = rnd() * s;
        const y = rnd() * s;
        const r = 2 + rnd() * 9;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const v = Math.floor(110 + rnd() * 90);
        g.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
        g.addColorStop(1, 'rgba(128,128,128,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    },
    3,
  );
  return foamNormal;
}

let panelNormal: CanvasTexture | null = null;
function getPanelNormal(): CanvasTexture {
  if (panelNormal) return panelNormal;
  panelNormal = normalFromHeight(
    256,
    (ctx, s) => {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = '#5a5a5a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, s / 2);
      ctx.lineTo(s, s / 2);
      ctx.moveTo(s / 2, 0);
      ctx.lineTo(s / 2, s);
      ctx.stroke();
      // rivet rows
      ctx.fillStyle = '#9a9a9a';
      for (let i = 0; i < s; i += 8) {
        ctx.fillRect(i, s / 2 - 5, 2, 2);
        ctx.fillRect(i, s / 2 + 4, 2, 2);
      }
    },
    2,
  );
  return panelNormal;
}

const PATTERN_GLSL: Record<PatternKind, string> = {
  none: '',
  panels: `
    float ang = atan(vObjPos.z, vObjPos.x);
    float r = length(vObjPos.xz);
    float arcU = ang * r / uPatScale;
    float seamU = smoothstep(0.02, 0.0, abs(fract(arcU) - 0.5) - 0.48);
    float seamV = smoothstep(0.02, 0.0, abs(fract(vObjPos.y / (uPatScale * 1.6)) - 0.5) - 0.485);
    diffuseColor.rgb *= 1.0 - 0.12 * max(seamU, seamV);
  `,
  roll: `
    float ang = atan(vObjPos.z, vObjPos.x);
    float q = step(0.5, fract(ang / 3.14159265 + 0.25));
    float band = step(abs(vObjPos.y - uPatOffset), uPatScale);
    diffuseColor.rgb = mix(diffuseColor.rgb, uPatColor, q * band);
  `,
  bands: `
    float b = step(fract((vObjPos.y + uPatOffset) / uPatScale), 0.035);
    diffuseColor.rgb = mix(diffuseColor.rgb, uPatColor, b);
  `,
  hazard: `
    float ang = atan(vObjPos.z, vObjPos.x);
    float r = length(vObjPos.xz);
    float s = step(0.5, fract((ang * r + vObjPos.y * 1.0) / uPatScale));
    float inBand = step(abs(vObjPos.y), uPatOffset);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(uPatColor, vec3(0.02), s), inBand);
  `,
  foam: `
    float n = fract(sin(dot(floor(vObjPos * 1.7), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    diffuseColor.rgb *= 0.9 + 0.2 * n;
  `,
  welds: `
    float wv = smoothstep(0.015, 0.0, abs(fract(vObjPos.y / uPatScale) - 0.5) - 0.49);
    diffuseColor.rgb *= 1.0 - 0.25 * wv;
  `,
};

/** Physical material with an object-space procedural pattern. */
export function paint(key: string, o: PaintOptions): MeshPhysicalMaterial {
  const cached = cache.get(key);
  if (cached) return cached as MeshPhysicalMaterial;
  const m = new MeshPhysicalMaterial({
    color: new Color(o.color),
    roughness: o.roughness,
    metalness: o.metalness,
    clearcoat: o.clearcoat ?? 0,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1,
  });
  if (o.side !== undefined) m.side = o.side;
  if (o.emissive !== undefined) m.emissive = new Color(o.emissive);
  const pattern = o.pattern ?? 'none';
  if (pattern === 'foam') {
    m.normalMap = getFoamNormal();
    m.normalMap.repeat.set(3, 3);
  } else if (pattern === 'panels' || pattern === 'welds') {
    m.normalMap = getPanelNormal();
    m.normalScale.set(0.25, 0.25);
  }
  if (pattern !== 'none') {
    const pc = new Color(o.patternColor ?? 0x111111);
    const scale = o.scale ?? 1.5;
    const offset = pattern === 'hazard' ? 100 : 0;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uPatColor = { value: pc };
      shader.uniforms.uPatScale = { value: scale };
      shader.uniforms.uPatOffset = { value: offset };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nuniform vec3 uPatColor;\nuniform float uPatScale;\nuniform float uPatOffset;')
        .replace('#include <color_fragment>', `#include <color_fragment>\n{${PATTERN_GLSL[pattern]}}`);
    };
    m.customProgramCacheKey = () => `apg-${pattern}`;
  }
  cache.set(key, m);
  return m;
}

// ------------------------------------------------------------------ presets

export const MAT = {
  whitePaint: () => paint('white', { color: 0xf1f1ee, roughness: 0.42, metalness: 0.0, clearcoat: 0.35, pattern: 'panels', scale: 1.4 }),
  blackPaint: () => paint('black', { color: 0x16171a, roughness: 0.5, metalness: 0.1, clearcoat: 0.2 }),
  /** Carbon-composite interstage: near-black with a lacquered sheen. */
  carbon: () => paint('carbon', { color: 0x121316, roughness: 0.34, metalness: 0.15, clearcoat: 0.7, pattern: 'panels', scale: 1.3 }),
  interstageInner: () => paint('interstage-in', { color: 0x0c0c0e, roughness: 0.8, metalness: 0.1, side: BackSide }),
  foam: () => paint('foam', { color: 0xc9712e, roughness: 0.88, metalness: 0.0, pattern: 'foam' }),
  steel: () => paint('steel', { color: 0xc9ccd1, roughness: 0.26, metalness: 1.0, pattern: 'welds', scale: 1.8 }),
  grayPaint: () => paint('gray', { color: 0xb6bcc5, roughness: 0.55, metalness: 0.25, pattern: 'panels', scale: 1.0 }),
  darkMetal: () => paint('darkmetal', { color: 0x3a3d43, roughness: 0.45, metalness: 0.85 }),
  aluminum: () => paint('alu', { color: 0xd9dee4, roughness: 0.22, metalness: 1.0, pattern: 'panels', scale: 0.9 }),
  gold: () => paint('gold', { color: 0xd8a64a, roughness: 0.32, metalness: 1.0, pattern: 'foam' }),
  ablator: () => paint('ablator', { color: 0x3b2a20, roughness: 0.92, metalness: 0.0 }),
  hazard: () => paint('hazard', { color: 0x2a2c30, roughness: 0.5, metalness: 0.6, pattern: 'hazard', patternColor: 0xf2c31b, scale: 0.35 }),
  srb: () => paint('srb', { color: 0xededea, roughness: 0.5, metalness: 0.0, clearcoat: 0.1, pattern: 'bands', patternColor: 0x1a1a1a, scale: 5.0 }),
  nozzleOuter: () => paint('nozzle-out', { color: 0x585b62, roughness: 0.38, metalness: 1.0, side: DoubleSide }),
  nozzleNiobium: () => paint('nozzle-nb', { color: 0x2c2d31, roughness: 0.55, metalness: 0.7, side: DoubleSide }),
  copper: () => paint('copper', { color: 0xb87333, roughness: 0.35, metalness: 1.0 }),
  solarCells: () => {
    const k = 'solar';
    const c = cache.get(k);
    if (c) return c as MeshStandardMaterial;
    const tex = canvasTex(256, (ctx, s) => {
      ctx.fillStyle = '#0a1a3c';
      ctx.fillRect(0, 0, s, s);
      const n = 8;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const g = ctx.createLinearGradient(0, 0, s / n, s / n);
          g.addColorStop(0, '#1b3d86');
          g.addColorStop(1, '#0c2152');
          ctx.fillStyle = g;
          ctx.fillRect(i * (s / n) + 2, j * (s / n) + 2, s / n - 4, s / n - 4);
        }
      }
    });
    const m = new MeshStandardMaterial({ map: tex, roughness: 0.25, metalness: 0.6, side: DoubleSide });
    cache.set(k, m);
    return m;
  },
  canopy: () => {
    const k = 'canopy';
    const c = cache.get(k);
    if (c) return c as MeshStandardMaterial;
    const tex = canvasTex(512, (ctx, s) => {
      const gores = 16;
      for (let i = 0; i < gores; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#f36b1c' : '#f4f1ea';
        ctx.fillRect((i * s) / gores, 0, s / gores + 1, s);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      for (let j = 0; j < 6; j++) ctx.fillRect(0, (j * s) / 6, s, 2);
    });
    const m = new MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0, side: DoubleSide });
    cache.set(k, m);
    return m;
  },
  window: () => paint('window', { color: 0x0b1320, roughness: 0.05, metalness: 0.9, clearcoat: 1 }),
};

export function tankMaterial(finish: 'white' | 'foam' | 'steel' | 'gray' | 'solid'): MeshPhysicalMaterial {
  switch (finish) {
    case 'foam':
      return MAT.foam();
    case 'steel':
      return MAT.steel();
    case 'gray':
      return MAT.grayPaint();
    case 'solid':
      return MAT.srb();
    default:
      return MAT.whitePaint();
  }
}
