/**
 * LEARNING NOTE: Procedural modelling of rocket parts
 *
 * Almost every rocket component is a SURFACE OF REVOLUTION: tanks, nose cones,
 * capsules and engine bells are 2-D profiles spun around the vertical axis. Three.js'
 * LatheGeometry does exactly that, so each part is a list of (radius, height)
 * points computed from its real dimensions — a 10 m Saturn tank and a 1.25 m
 * probe tank come from the same function.
 *
 * Engine bells follow a parabolic "bell" contour from a narrow throat to the exit;
 * clusters place one bell per nozzle offset. Vacuum engines get a dark niobium
 * extension that glows red-hot when firing. Mechanisms (legs, solar arrays,
 * parachutes, fairing halves) are built as separate child objects so the flight
 * renderer can animate them.
 *
 * Key concepts: lathe (revolution) geometry, parametric modelling, ogive curves,
 * bell nozzles, scene-graph hierarchies for animation
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  AdditiveBlending,
  DoubleSide,
  Color,
  type Material,
} from 'three';
import { clusterLayout, type PartConfig, type PartDef, type PartStats } from '../../parts/PartCatalog';
import { PROPELLANTS } from '../../parts/Propellants';
import { MAT, tankMaterial } from './Materials';

export interface NozzleInfo {
  /** Exit centre in part-local space. */
  exit: Vector3;
  exitRadius: number;
  /** Throat/injector position (plume origin for glow). */
  throat: Vector3;
}

export interface PartVisual {
  root: Group;
  nozzles: NozzleInfo[];
  /** Emissive materials that glow with throttle (nozzle interiors). */
  glow: MeshStandardMaterial[];
  /** Per-part clones that glow with skin temperature (heat shields). */
  heat: MeshStandardMaterial[];
  /** Niobium extensions that heat up red. */
  hotMaterials: MeshStandardMaterial[];
  canopy: Group | null;
  legs: Array<{ strut: Object3D; foot: Object3D; length: number; height: number }>;
  solar: Object3D[];
  fairingShell: Group | null;
}

export interface BuildContext {
  /** Diameter of the parent part's bottom (for engine thrust structures). */
  parentBottomDiameter: number;
  topAttached: boolean;
  bottomAttached: boolean;
}

function lathe(points: Array<[number, number]>, segments: number, material: Material): Mesh {
  const g = new LatheGeometry(
    points.map(([r, y]) => new Vector2(Math.max(0.0001, r), y)),
    segments,
  );
  const m = new Mesh(g, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function segs(r: number): number {
  return r > 3 ? 72 : r > 1.5 ? 56 : r > 0.7 ? 40 : 28;
}

function cyl(rt: number, rb: number, h: number, material: Material, s = 24, open = false): Mesh {
  const m = new Mesh(new CylinderGeometry(rt, rb, h, s, 1, open), material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function box(x: number, y: number, z: number, material: Material): Mesh {
  const m = new Mesh(new BoxGeometry(x, y, z), material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Tangent ogive profile from base radius R over length L (bottom at y0). */
function ogive(R: number, L: number, y0: number, n = 24): Array<[number, number]> {
  const rho = (R * R + L * L) / (2 * R);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const y = (i / n) * L;
    const r = Math.sqrt(Math.max(0, rho * rho - y * y)) + R - rho;
    pts.push([Math.max(0.0005, r), y0 + y]);
  }
  pts.push([0.0001, y0 + L]);
  return pts;
}

// ---------------------------------------------------------------------------

function buildTank(stats: PartStats, cfg: PartConfig, g: Group): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  const b = Math.min(0.08 * r, h * 0.08);
  const finish = PROPELLANTS[cfg.propellant ?? 'kerolox'].finish;
  const mat = tankMaterial(finish);
  g.add(lathe([[0, -h / 2], [r * 0.985, -h / 2], [r, -h / 2 + b], [r, h / 2 - b], [r * 0.985, h / 2], [0, h / 2]], segs(r), mat));
  // Cable raceway and a couple of feed-line fairings
  const race = box(0.12 + r * 0.03, h * 0.94, 0.1 + r * 0.02, finish === 'foam' ? MAT.foam() : MAT.grayPaint());
  race.position.set(Math.cos(0.6) * (r + 0.04), 0, Math.sin(0.6) * (r + 0.04));
  race.rotation.y = -0.6;
  g.add(race);
  if (r >= 1.2 && h > 3) {
    const feed = cyl(0.08 + r * 0.04, 0.08 + r * 0.04, h * 0.9, finish === 'foam' ? MAT.foam() : MAT.aluminum(), 12);
    feed.position.set(Math.cos(2.4) * (r + 0.1 + r * 0.03), 0, Math.sin(2.4) * (r + 0.1 + r * 0.03));
    g.add(feed);
  }
}

function bell(re: number, length: number, vacuum: boolean, nozzleMat: Material, extMat: MeshStandardMaterial | null, glowMat: MeshStandardMaterial): Group {
  // Profile from the injector (top, y=0) down to the exit (y=-length)
  const gr = new Group();
  const rt = re * (vacuum ? 0.16 : 0.3);
  const rc = rt * 1.7;
  const lc = length * 0.14;
  const lb = length * 0.78;
  const top = 0;
  const pts: Array<[number, number]> = [];
  pts.push([rc * 0.6, top]);
  pts.push([rc, top - lc * 0.2]);
  pts.push([rc, top - lc]);
  pts.push([rt * 1.05, top - lc - length * 0.05]);
  pts.push([rt, top - lc - length * 0.08]);
  const bellTop = top - lc - length * 0.08;
  const N = 18;
  const split = vacuum ? 0.35 : 1.1;
  const outerPts: Array<[number, number]> = [];
  const extPts: Array<[number, number]> = [];
  for (let i = 1; i <= N; i++) {
    const s = i / N;
    const r = rt + (re - rt) * (1 - Math.pow(1 - s, 1.9));
    const y = bellTop - s * lb;
    if (s <= split) outerPts.push([r, y]);
    else {
      if (extPts.length === 0 && outerPts.length) extPts.push(outerPts[outerPts.length - 1]!);
      extPts.push([r, y]);
    }
  }
  const main = lathe([...pts, ...outerPts], 40, nozzleMat);
  gr.add(main);
  if (extPts.length > 1 && extMat) {
    const ext = lathe(extPts, 40, extMat);
    gr.add(ext);
  }
  // Glowing throat interior (slightly inset, back faces visible from below)
  const inner: Array<[number, number]> = [];
  for (let i = 0; i <= 8; i++) {
    const s = i / 8;
    const r = (rt + (re - rt) * (1 - Math.pow(1 - s * 0.45, 1.9))) * 0.97;
    inner.push([r, bellTop - s * lb * 0.45]);
  }
  const glow = lathe(inner, 32, glowMat);
  glow.castShadow = false;
  gr.add(glow);
  // Turbopump + plumbing above the chamber
  if (re > 0.5) {
    const tp = cyl(rc * 0.55, rc * 0.55, lc * 1.2, MAT.darkMetal(), 16);
    tp.position.set(rc * 1.25, top - lc * 0.5, 0);
    gr.add(tp);
    const pipe = new Mesh(new TorusGeometry(rc * 0.9, rc * 0.12, 8, 24, Math.PI), MAT.copper());
    pipe.rotation.x = Math.PI / 2;
    pipe.position.y = top - lc * 0.6;
    gr.add(pipe);
  }
  return gr;
}

function buildEngine(def: PartDef, stats: PartStats, cfg: PartConfig, ctx: BuildContext, g: Group, vis: PartVisual): void {
  const e = def.engine!;
  const h = stats.height;
  const n = cfg.cluster ?? 1;
  const lay = clusterLayout(n, e.nozzleExit);
  const vacuum = e.ispSL < e.ispVac * 0.6;
  const mountH = n > 1 ? 0.45 : 0.2;
  const topY = h / 2;
  // Thrust structure / heat shield under the parent tank
  const shieldR = Math.max(ctx.parentBottomDiameter, lay.mountDiameter) / 2;
  if (ctx.parentBottomDiameter > 0 || n > 1) {
    const plate = cyl(shieldR, Math.max(lay.mountDiameter / 2, shieldR * 0.92), mountH, MAT.darkMetal(), segs(shieldR));
    plate.position.y = topY - mountH / 2;
    g.add(plate);
  } else {
    const mount = cyl(e.nozzleExit * 0.3, e.nozzleExit * 0.35, mountH, MAT.darkMetal(), 20);
    mount.position.y = topY - mountH / 2;
    g.add(mount);
  }
  const glowMat = new MeshStandardMaterial({ color: 0x331a0a, emissive: new Color(1.0, 0.45, 0.12), emissiveIntensity: 0, roughness: 0.6, metalness: 0.2, side: DoubleSide });
  vis.glow.push(glowMat);
  const extMat = vacuum ? new MeshStandardMaterial({ color: 0x2b2c30, roughness: 0.6, metalness: 0.6, emissive: new Color(1, 0.25, 0.05), emissiveIntensity: 0, side: DoubleSide }) : null;
  if (extMat) vis.hotMaterials.push(extMat);
  const chambers = e.chambers;
  const len = e.length;
  for (const [ox, oz] of lay.offsets) {
    for (let c = 0; c < chambers; c++) {
      const cx = ox + (chambers > 1 ? (c - (chambers - 1) / 2) * e.nozzleExit * 0.52 : 0);
      const re = chambers > 1 ? e.nozzleExit / 2 * 0.5 : e.nozzleExit / 2;
      const b = bell(re, len, vacuum, MAT.nozzleOuter(), extMat, glowMat);
      b.position.set(cx, topY - mountH, oz);
      g.add(b);
      vis.nozzles.push({
        exit: new Vector3(cx, topY - mountH - len, oz),
        exitRadius: re,
        throat: new Vector3(cx, topY - mountH - len * 0.2, oz),
      });
    }
  }
}

function buildSrb(def: PartDef, stats: PartStats, ctx: BuildContext, g: Group, vis: PartVisual): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  const s = def.solid!;
  const noseL = ctx.topAttached ? 0 : Math.min(h * 0.12, r * 3.2);
  const skirtH = Math.min(h * 0.07, r * 1.2);
  const bodyTop = h / 2 - noseL;
  const bodyBot = -h / 2 + skirtH;
  g.add(lathe([[0, bodyBot], [r, bodyBot], [r, bodyTop], [ctx.topAttached ? 0 : r, bodyTop]], segs(r), MAT.srb()));
  if (noseL > 0) g.add(lathe(ogive(r, noseL, bodyTop), segs(r), MAT.whitePaint()));
  // Aft skirt flare + nozzle
  g.add(lathe([[r, bodyBot], [r * 1.18, -h / 2], [0, -h / 2]], segs(r), MAT.grayPaint()));
  const re = s.nozzleExit / 2;
  const nozzle = lathe([[re * 0.45, -h / 2], [re * 0.5, -h / 2 - re * 0.3], [re, -h / 2 - re * 1.3]], 32, MAT.nozzleOuter());
  g.add(nozzle);
  const glowMat = new MeshStandardMaterial({ color: 0x331a0a, emissive: new Color(1, 0.6, 0.25), emissiveIntensity: 0, roughness: 0.6, side: DoubleSide });
  vis.glow.push(glowMat);
  const glow = lathe([[re * 0.43, -h / 2 - 0.05], [re * 0.95, -h / 2 - re * 1.25]], 24, glowMat);
  g.add(glow);
  vis.nozzles.push({ exit: new Vector3(0, -h / 2 - re * 1.3, 0), exitRadius: re, throat: new Vector3(0, -h / 2, 0) });
}

function buildCapsule(def: PartDef, stats: PartStats, g: Group): void {
  const rb = stats.diameterBottom / 2;
  const rt = stats.diameterTop / 2;
  const h = stats.height;
  const condor = def.id === 'capsule-condor';
  const body = condor ? MAT.aluminum() : MAT.whitePaint();
  const pts: Array<[number, number]> = [
    [0, -h / 2 - rb * 0.06],
    [rb * 0.7, -h / 2 - rb * 0.035],
    [rb * 0.97, -h / 2 + rb * 0.01],
    [rb, -h / 2 + rb * 0.06],
    [rt * 1.12, h / 2 - 0.12],
    [rt, h / 2 - 0.05],
    [rt, h / 2],
    [0, h / 2],
  ];
  g.add(lathe(pts, segs(rb), body));
  // Heat-shield rim & windows
  const rim = cyl(rb * 1.005, rb * 1.005, rb * 0.08, MAT.ablator(), segs(rb), true);
  rim.position.y = -h / 2 + rb * 0.03;
  g.add(rim);
  const slope = (rb - rt) / h;
  for (const a of [0.35, -0.35, Math.PI - 0.3]) {
    const y = h * 0.1;
    const rr = rb - slope * (y + h / 2) + 0.01;
    const w = box(0.35, 0.28, 0.03, MAT.window());
    w.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    w.lookAt(new Vector3(Math.cos(a) * rr * 2, y + slope * rr, Math.sin(a) * rr * 2));
    g.add(w);
  }
  // RCS quads
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const y = h * 0.28;
    const rr = rb - slope * (y + h / 2);
    const q = box(0.22, 0.22, 0.12, MAT.darkMetal());
    q.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    q.lookAt(new Vector3(Math.cos(a) * rr * 2, y, Math.sin(a) * rr * 2));
    g.add(q);
  }
  if (!condor) {
    const band = cyl(rb * 0.86, rb * 0.99, h * 0.12, MAT.blackPaint(), segs(rb), true);
    band.position.y = -h / 2 + h * 0.1;
    g.add(band);
  }
}

function buildProbe(stats: PartStats, g: Group): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  g.add(cyl(r * 0.96, r * 0.96, h, MAT.gold(), 8));
  for (const y of [h / 2 - h * 0.06, -h / 2 + h * 0.06]) {
    const ring = cyl(r, r, h * 0.12, MAT.darkMetal(), 24);
    ring.position.y = y;
    g.add(ring);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const b = box(r * 0.35, h * 0.55, r * 0.22, MAT.blackPaint());
    b.position.set(Math.cos(a) * r * 0.95, 0, Math.sin(a) * r * 0.95);
    b.rotation.y = -a;
    g.add(b);
  }
  const ant = cyl(0.015, 0.015, 0.7, MAT.aluminum(), 6);
  ant.position.set(r * 0.5, h / 2 + 0.35, 0);
  g.add(ant);
}

function buildRing(def: PartDef, stats: PartStats, g: Group): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  g.add(cyl(r, r, h, def.reactionWheel ? MAT.grayPaint() : MAT.darkMetal(), segs(r)));
  const n = Math.max(4, Math.round(r * 6));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = box(0.18 + r * 0.05, h * 0.6, 0.08, def.reactionWheel ? MAT.darkMetal() : MAT.gold());
    b.position.set(Math.cos(a) * (r + 0.03), 0, Math.sin(a) * (r + 0.03));
    b.rotation.y = -a + Math.PI / 2;
    g.add(b);
  }
}

function buildDecoupler(stats: PartStats, g: Group): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  g.add(cyl(r * 0.995, r * 0.995, h * 0.7, MAT.hazard(), segs(r)));
  const lip = cyl(r, r, h * 0.15, MAT.darkMetal(), segs(r));
  lip.position.y = h / 2 - h * 0.075;
  g.add(lip);
  const lip2 = lip.clone();
  lip2.position.y = -h / 2 + h * 0.075;
  g.add(lip2);
}

/**
 * Interstage shell: hides an upper-stage engine that sits inside the decoupler
 * below it. It belongs to the decoupler, so it falls away with the spent stage.
 */
export function buildInterstage(radius: number, height: number): Group {
  const g = new Group();
  g.name = 'interstage';
  const outer = cyl(radius, radius, height, MAT.carbon(), segs(radius), true);
  g.add(outer);
  const inner = cyl(radius * 0.985, radius * 0.985, height, MAT.interstageInner(), segs(radius), true);
  inner.castShadow = false;
  g.add(inner);
  // thin reinforcing rings at both ends
  for (const y of [-height / 2 + 0.06, height / 2 - 0.06]) {
    const ring = cyl(radius * 1.004, radius * 1.004, 0.12, MAT.darkMetal(), segs(radius), true);
    ring.position.y = y;
    g.add(ring);
  }
  return g;
}

function buildRadialDecoupler(def: PartDef, g: Group): void {
  const h = def.height;
  const b = box(0.4, h, def.diameter, MAT.hazard());
  b.position.x = 0;
  g.add(b);
  const strut = box(0.5, h * 0.2, def.diameter * 0.6, MAT.darkMetal());
  strut.position.set(0, h * 0.3, 0);
  g.add(strut);
  const strut2 = strut.clone();
  strut2.position.y = -h * 0.3;
  g.add(strut2);
}

function buildAdapter(stats: PartStats, g: Group): void {
  const rt = stats.diameterTop / 2;
  const rb = stats.diameterBottom / 2;
  const h = stats.height;
  g.add(lathe([[0, -h / 2], [rb, -h / 2], [rb, -h / 2 + 0.08], [rt, h / 2 - 0.08], [rt, h / 2], [0, h / 2]], segs(Math.max(rt, rb)), MAT.whitePaint()));
}

function buildTube(stats: PartStats, g: Group): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  g.add(cyl(r, r, h, MAT.grayPaint(), segs(r)));
}

function buildNose(stats: PartStats, g: Group): void {
  const R = stats.diameterBottom / 2;
  const h = stats.height;
  g.add(lathe(ogive(R, h, -h / 2, 28), segs(R), MAT.whitePaint()));
}

function fairingProfile(R: number, L: number): Array<[number, number]> {
  const noseL = Math.min(L * 0.5, R * 2.6);
  const cylL = L - noseL;
  const pts: Array<[number, number]> = [[R, 0], [R, cylL]];
  for (const [r, y] of ogive(R, noseL, cylL, 24).slice(1)) pts.push([r, y]);
  return pts;
}

function buildFairing(stats: PartStats, cfg: PartConfig, g: Group, vis: PartVisual): void {
  const R = (cfg.diameter ?? stats.diameterTop) / 2;
  const h = stats.height;
  g.add(cyl(R, R, h, MAT.darkMetal(), segs(R)));
  const L = cfg.length ?? 8;
  const shell = new Group();
  shell.position.y = h / 2;
  for (const side of [0, 1]) {
    const geo = new LatheGeometry(fairingProfile(R * 1.01, L).map(([r, y]) => new Vector2(r, y)), segs(R), side * Math.PI, Math.PI);
    const m = new Mesh(geo, MAT.whitePaint());
    m.castShadow = true;
    m.receiveShadow = true;
    shell.add(m);
  }
  g.add(shell);
  vis.fairingShell = shell;
}

/** A standalone fairing half (for jettisoned debris). */
export function buildFairingHalf(diameter: number, length: number, side: 1 | -1): Mesh {
  const R = diameter / 2;
  const geo = new LatheGeometry(fairingProfile(R * 1.01, length).map(([r, y]) => new Vector2(r, y)), segs(R), side > 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI);
  geo.translate(0, -length * 0.45, 0);
  const m = new Mesh(geo, MAT.whitePaint());
  m.castShadow = true;
  return m;
}

function buildFin(def: PartDef, g: Group): void {
  const f = def.fin!;
  const s = new Shape();
  const c = f.chord;
  s.moveTo(0, -c / 2);
  s.lineTo(f.span, -c / 2 - c * 0.05);
  s.lineTo(f.span, -c / 2 + c * 0.35);
  s.lineTo(0, c / 2);
  s.lineTo(0, -c / 2);
  const geo = new ExtrudeGeometry(s, { depth: 0.06 + f.span * 0.02, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
  geo.translate(0, 0, -(0.06 + f.span * 0.02) / 2);
  const m = new Mesh(geo, MAT.whitePaint());
  m.castShadow = true;
  g.add(m);
}

function buildHeatshield(stats: PartStats, g: Group, vis: PartVisual): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  // Own material so the ablator can glow with ITS temperature during re-entry
  const m = MAT.ablator().clone();
  m.emissive.setRGB(1, 0.35, 0.1);
  m.emissiveIntensity = 0;
  vis.heat.push(m);
  g.add(lathe([[0, -h / 2 - r * 0.05], [r * 0.8, -h / 2 - r * 0.02], [r, -h / 2 + h * 0.3], [r, h / 2], [0, h / 2]], segs(r), m));
}

function buildParachutePack(def: PartDef, stats: PartStats, cfg: PartConfig, g: Group, vis: PartVisual): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  const radial = def.shape === 'radial-chute';
  if (radial) {
    const c = cyl(def.diameter / 2, def.diameter / 2, h, MAT.whitePaint(), 16);
    g.add(c);
    const cap = new Mesh(new SphereGeometry(def.diameter / 2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.whitePaint());
    cap.position.y = h / 2;
    g.add(cap);
  } else {
    g.add(lathe([[0, -h / 2], [r, -h / 2], [r, h * 0.1], [r * 0.7, h / 2], [0, h / 2]], 32, MAT.whitePaint()));
  }
  // Canopies (hidden until deployed). Built at full size; scaled by deploy state.
  const chute = def.parachute!;
  const n = cfg.canopies ?? 1;
  const canopy = new Group();
  canopy.visible = false;
  const R = chute.canopy / 2;
  const lineLen = chute.canopy * 1.25;
  for (let i = 0; i < n; i++) {
    const cg = new Group();
    const dome = new Mesh(new SphereGeometry(R, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), MAT.canopy());
    dome.position.y = lineLen;
    cg.add(dome);
    // Suspension lines as thin cylinders bundled
    const lineMat = new MeshBasicMaterial({ color: 0x999999 });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const tip = new Vector3(Math.cos(a) * R * 0.92, lineLen + R * 0.35, Math.sin(a) * R * 0.92);
      const len = tip.length();
      const line = new Mesh(new CylinderGeometry(0.02, 0.02, len, 4), lineMat);
      line.position.copy(tip).multiplyScalar(0.5);
      line.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), tip.clone().normalize());
      cg.add(line);
    }
    if (n > 1) {
      const a = (i / n) * Math.PI * 2;
      cg.rotation.set(Math.sin(a) * 0.35, 0, Math.cos(a) * 0.35);
    }
    canopy.add(cg);
  }
  canopy.position.y = h / 2;
  g.add(canopy);
  vis.canopy = canopy;
}

function buildLeg(def: PartDef, stats: PartStats, g: Group, vis: PartVisual): void {
  const L = def.legs!.length;
  const h = stats.height;
  // Mount bracket against the body
  const bracket = box(0.25, h * 0.3, 0.3, MAT.darkMetal());
  bracket.position.set(0.1, -h * 0.25, 0);
  g.add(bracket);
  const strut = new Group();
  const tube = cyl(0.06 + L * 0.01, 0.05 + L * 0.008, 1, MAT.aluminum(), 10);
  strut.add(tube);
  g.add(strut);
  const foot = new Mesh(new CylinderGeometry(0.18 + L * 0.05, 0.22 + L * 0.06, 0.08, 16), MAT.gold());
  foot.castShadow = true;
  g.add(foot);
  // A second, diagonal brace for looks
  vis.legs.push({ strut, foot, length: L, height: h });
}

/** Update a leg's strut & foot for a deploy fraction; matches Vessel.buildContacts. */
const _legFoot = new Vector3();
const _legHinge = new Vector3();
const _legDir = new Vector3();
const _legUp = new Vector3(0, 1, 0);

export function poseLeg(leg: { strut: Object3D; foot: Object3D; length: number; height: number }, d: number): void {
  const L = leg.length;
  const h = leg.height;
  const foot = _legFoot.set(0.25 + 0.45 * L * d, -h * 0.35 - 0.55 * L * d - 0.25 * L * (1 - d) * 0.3, 0);
  const hinge = _legHinge.set(0.15, -h * 0.1, 0);
  const dir = _legDir.copy(foot).sub(hinge);
  const len = dir.length();
  leg.strut.position.copy(hinge).addScaledVector(dir, 0.5);
  leg.strut.scale.set(1, len, 1);
  leg.strut.quaternion.setFromUnitVectors(_legUp, dir.normalize());
  leg.foot.position.copy(foot);
}

/** Androgynous docking ring: a short drum with guide petals and a collar on each face. */
function buildDock(stats: PartStats, g: Group): void {
  const r = stats.diameterTop / 2;
  const h = stats.height;
  g.add(cyl(r, r, h, MAT.grayPaint(), segs(r)));
  for (const face of [1, -1] as const) {
    const collar = new Mesh(new TorusGeometry(r * 0.74, r * 0.06, 8, 36), MAT.darkMetal());
    collar.rotation.x = Math.PI / 2;
    collar.position.y = (face * h) / 2;
    collar.castShadow = true;
    g.add(collar);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const petal = box(r * 0.28, 0.04, r * 0.12, MAT.aluminum());
      petal.position.set(Math.cos(a) * r * 0.52, face * (h / 2 + 0.02), Math.sin(a) * r * 0.52);
      petal.rotation.y = -a;
      g.add(petal);
    }
  }
}

/** RCS block: a white housing with four nozzles around it and one pointing outward. */
function buildRcs(g: Group): void {
  g.add(box(0.28, 0.42, 0.28, MAT.whitePaint()));
  const nozzle = (x: number, y: number, z: number, rx: number, rz: number) => {
    const n = cyl(0.03, 0.06, 0.1, MAT.darkMetal(), 10);
    n.position.set(x, y, z);
    n.rotation.set(rx, 0, rz);
    g.add(n);
  };
  nozzle(0, 0.26, 0, 0, 0);
  nozzle(0, -0.26, 0, Math.PI, 0);
  nozzle(0, 0.05, 0.19, Math.PI / 2, 0);
  nozzle(0, 0.05, -0.19, -Math.PI / 2, 0);
  nozzle(0.19, 0.05, 0, 0, -Math.PI / 2);
}

function buildSolar(g: Group, vis: PartVisual): void {
  const base = box(0.2, 0.9, 0.3, MAT.darkMetal());
  g.add(base);
  const wing = new Group();
  const boom = cyl(0.03, 0.03, 0.8, MAT.aluminum(), 6);
  boom.rotation.z = Math.PI / 2;
  boom.position.x = 0.4;
  wing.add(boom);
  for (let i = 0; i < 3; i++) {
    const p = box(1.4, 0.02, 1.1, MAT.solarCells());
    p.position.set(0.8 + 0.7 + i * 1.45, 0, 0);
    wing.add(p);
  }
  wing.position.set(0.1, 0, 0);
  g.add(wing);
  vis.solar.push(wing);
}

/** Build the visual for one part (part-local space, origin at part centre). */
export function buildPartVisual(def: PartDef, stats: PartStats, cfg: PartConfig, ctx: BuildContext): PartVisual {
  const g = new Group();
  g.name = def.id;
  const vis: PartVisual = { root: g, nozzles: [], glow: [], heat: [], hotMaterials: [], canopy: null, legs: [], solar: [], fairingShell: null };
  switch (def.shape) {
    case 'tank':
      buildTank(stats, cfg, g);
      break;
    case 'engine':
      buildEngine(def, stats, cfg, ctx, g, vis);
      break;
    case 'srb':
      buildSrb(def, stats, ctx, g, vis);
      break;
    case 'capsule':
      buildCapsule(def, stats, g);
      break;
    case 'probe':
      buildProbe(stats, g);
      break;
    case 'ring':
      buildRing(def, stats, g);
      break;
    case 'decoupler':
      buildDecoupler(stats, g);
      break;
    case 'radial-decoupler':
      buildRadialDecoupler(def, g);
      break;
    case 'adapter':
      buildAdapter(stats, g);
      break;
    case 'tube':
      buildTube(stats, g);
      break;
    case 'nosecone':
      buildNose(stats, g);
      break;
    case 'fairing':
      buildFairing(stats, cfg, g, vis);
      break;
    case 'fin':
      buildFin(def, g);
      break;
    case 'heatshield':
      buildHeatshield(stats, g, vis);
      break;
    case 'parachute':
    case 'radial-chute':
      buildParachutePack(def, stats, cfg, g, vis);
      break;
    case 'leg':
      buildLeg(def, stats, g, vis);
      for (const l of vis.legs) poseLeg(l, 0);
      break;
    case 'solar':
      buildSolar(g, vis);
      break;
    case 'dock':
      buildDock(stats, g);
      break;
    case 'rcs':
      buildRcs(g);
      break;
  }
  return vis;
}

/** Highlight overlay material (VAB hover/selection). */
export function highlightMaterial(color: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false });
}

export function disposeObject(o: Object3D): void {
  o.traverse((c) => {
    const m = c as Mesh;
    // Geometries flagged `shared` (the plume cylinder) belong to every vessel
    if (m.geometry && !(m.geometry as BufferGeometry).userData.shared) (m.geometry as BufferGeometry).dispose();
  });
}
