/**
 * LEARNING NOTE: The vessel as a single rigid body
 *
 * We simulate the whole rocket as ONE rigid body (no flexing joints — the classic
 * source of "wobbly rocket" bugs). Each physics step we:
 *   • sum masses → total mass m and centre of mass (COM)
 *   • sum each part's inertia (a solid cylinder about its own centre, shifted to
 *     the COM with the parallel-axis theorem) → the 3×3 inertia tensor I
 *   • integrate linear motion of the COM from the net force (F = m·a) and rotation
 *     from the net torque via Euler's equations  I·ω̇ = τ − ω × (I·ω).
 *
 * As propellant drains the COM moves; we shift the stored COM position so the
 * physical parts do not jump. Firing a decoupler SPLITS the part tree into two
 * vessels which inherit the parent's velocity (plus rotation and a separation kick).
 *
 * Key concepts: rigid-body dynamics, centre of mass, inertia tensor, parallel-axis
 * theorem, quaternions for orientation, splitting bodies
 */
import { Matrix3, Quaternion, Vector3 } from 'three';
import type { CelestialBody } from '../physics/CelestialBody';
import { Orbit } from '../physics/Orbit';
import { layoutCraft, type AttachKind, type CraftData, type CraftPart } from '../parts/Craft';
import { stagesFromCraft } from '../parts/Staging';
import type { SimPart } from '../parts/DeltaV';
import { FlightPart } from './FlightPart';

export type Situation = 'prelaunch' | 'landed' | 'splashed' | 'flying' | 'suborbital' | 'orbiting' | 'escaping' | 'destroyed';

export type SASMode =
  | 'stability'
  | 'prograde'
  | 'retrograde'
  | 'normal'
  | 'antinormal'
  | 'radial-out'
  | 'radial-in'
  | 'target'
  | 'anti-target'
  | 'maneuver'
  /** Turn so our docking port faces the target vessel's nearest free port. */
  | 'port';

export interface ControlState {
  /** Commanded throttle 0..1. */
  throttle: number;
  /** Pilot inputs −1..1 (pitch up +, yaw right +, roll right +). */
  pitch: number;
  yaw: number;
  roll: number;
  sas: boolean;
  sasMode: SASMode;
  /** Navball/SAS reference: surface-relative velocity near the ground. */
  speedMode: 'surface' | 'orbit' | 'target';
  /** Reaction-control thrusters armed. */
  rcs: boolean;
  /** Translation inputs −1..1 in the vessel frame (x right, y forward/nose, z dorsal). */
  tx: number;
  ty: number;
  tz: number;
  /** Airbrakes commanded open. */
  brakes: boolean;
}

export interface ContactPoint {
  part: FlightPart;
  /** Position in the vessel frame. */
  pos: Vector3;
  leg: boolean;
}

export interface AeroFace {
  part: FlightPart | null;
  area: number;
  /** +1 top-facing, −1 bottom-facing */
  facing: 1 | -1;
  frontCd: number;
  baseCd: number;
  pos: Vector3;
  /** Normal-force (lift) area for tapered noses facing the flow. */
  liftArea: number;
  engineBase: boolean;
}

export interface AeroBodySegment {
  part: FlightPart | null;
  pos: Vector3;
  sideArea: number;
}

export interface AeroFin {
  part: FlightPart;
  pos: Vector3;
  normal: Vector3;
  area: number;
  /** Maximum deflection (rad) of an all-moving control fin; 0 for a fixed fin. */
  control: number;
  /** Spanwise hinge axis (vessel frame) a control fin turns about. */
  hinge: Vector3;
}

let nextVesselId = 1;

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _inertia = new Float64Array(9);

export class Vessel {
  readonly id: number;
  name: string;
  parts: FlightPart[];
  root: FlightPart;
  body: CelestialBody;

  /** COM position & velocity relative to `body` centre, inertial frame. */
  readonly r = new Vector3();
  readonly v = new Vector3();
  /** Orientation: vessel frame → inertial frame. */
  readonly q = new Quaternion();
  /** Angular velocity in the vessel frame (rad/s). */
  readonly w = new Vector3();

  mass = 1;
  /** Centre of mass in the vessel frame. */
  readonly com = new Vector3();
  readonly inertia = new Matrix3();
  readonly invInertia = new Matrix3();
  /** Principal-ish moments (diagonal of I) for controller tuning. */
  readonly inertiaDiag = new Vector3(1, 1, 1);

  stages: number[][] = [];
  /** Index of the next stage to fire. */
  nextStage = 0;

  readonly controls: ControlState = {
    throttle: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    sas: false,
    sasMode: 'stability',
    speedMode: 'surface',
    rcs: false,
    tx: 0,
    ty: 0,
    tz: 0,
    brakes: false,
  };
  /** RCS jets fired this step (visuals/audio). */
  rcsActive = false;
  /** Persistent id in the save's tracking station (null: not saved yet). */
  pid: string | null = null;
  /** Campaign tag of a mission-provided vessel (e.g. the station a mission spawns). */
  missionTag: string | null = null;

  situation: Situation = 'flying';
  /** Held by launch clamps. */
  clamped = false;
  /** Pinned to the surface in the body-fixed frame (prelaunch / settled landing). */
  pinned = false;
  readonly pinnedPos = new Vector3();
  readonly pinnedRot = new Quaternion();
  settledTime = 0;
  /** Seconds since the vessel last touched the ground or water. */
  airborneTime = 0;

  /** Analytic orbit while "on rails". */
  onRails = false;
  readonly railsOrbit = new Orbit();

  debris = false;
  destroyed = false;
  /** Time (s) this vessel has existed — used to cull old debris. */
  age = 0;

  // --- structure caches ---------------------------------------------------------
  contactPoints: ContactPoint[] = [];
  aeroFaces: AeroFace[] = [];
  aeroBody: AeroBodySegment[] = [];
  aeroFins: AeroFin[] = [];
  /** Characteristic (max) radius for heating & drag reference. */
  refRadius = 1;
  /** Length along Y (for camera framing). */
  readonly boundsMin = new Vector3();
  readonly boundsMax = new Vector3();
  structureVersion = 0;
  lastContactCount = 4;

  // --- telemetry ------------------------------------------------------------------
  altitude = 0;
  radarAltitude = 0;
  terrainHeight = 0;
  readonly surfaceVelocity = new Vector3();
  /** Local wind (inertial frame, relative to the rotating surface). */
  readonly wind = new Vector3();
  /** Velocity relative to the moving air = surface velocity − wind (drives aerodynamics). */
  readonly airVelocity = new Vector3();
  verticalSpeed = 0;
  horizontalSpeed = 0;
  mach = 0;
  dynamicPressure = 0;
  staticPressure = 0;
  airDensity = 0;
  gForce = 1;
  angleOfAttack = 0;
  heatFlux = 0;
  aeroLoad = 0;
  totalThrust = 0;
  maxThrustNow = 0;
  inAtmosphere = false;
  touchingGround = false;
  inWater = false;
  readonly acceleration = new Vector3();
  maxQ = 0;
  maxG = 0;
  maxAltitude = 0;
  maxSpeed = 0;
  /** Accumulated Δv expended (m/s, from thrust/mass). */
  dvExpended = 0;

  constructor(parts: FlightPart[], root: FlightPart, body: CelestialBody, name: string) {
    this.id = nextVesselId++;
    this.parts = parts;
    this.root = root;
    this.body = body;
    this.name = name;
    this.refreshStructure();
    this.computeMassProperties(false);
  }

  static fromCraft(craft: CraftData, body: CelestialBody): Vessel {
    const layout = layoutCraft(craft);
    const parts = new Map<number, FlightPart>();
    for (const l of layout.values()) {
      const fp = new FlightPart(l.uid, l.def, { ...l.part.config }, l.stats, l.part.attach, l.part.stage);
      fp.position.copy(l.position);
      fp.rotation.copy(l.rotation);
      fp.angle = l.part.angle;
      fp.offsetY = l.part.offsetY;
      fp.symmetry = l.part.symmetry;
      parts.set(l.uid, fp);
    }
    for (const l of layout.values()) {
      const fp = parts.get(l.uid)!;
      const par = parts.get(l.part.parent);
      if (par) {
        fp.parent = par;
        par.children.push(fp);
      }
    }
    const rootLay = [...layout.values()].find((l) => l.part.parent === -1)!;
    const v = new Vessel([...parts.values()], parts.get(rootLay.uid)!, body, craft.name);
    v.stages = stagesFromCraft(craft);
    v.nextStage = 0;
    return v;
  }

  get isControllable(): boolean {
    return !this.destroyed && this.parts.some((p) => !!p.def.command && !p.destroyed);
  }

  get crew(): number {
    let c = 0;
    for (const p of this.parts) c += p.stats.crew;
    return c;
  }

  get hasCrew(): boolean {
    return this.crew > 0;
  }

  /** Absolute (heliocentric) COM position. */
  absolutePosition(out: Vector3): Vector3 {
    return out.copy(this.r).add(this.body.position);
  }

  absoluteVelocity(out: Vector3): Vector3 {
    return out.copy(this.v).add(this.body.velocity);
  }

  /** Vessel-frame point → position relative to body centre (inertial). */
  localToBody(p: Vector3, out: Vector3): Vector3 {
    return out.copy(p).sub(this.com).applyQuaternion(this.q).add(this.r);
  }

  /** Vessel origin (root part centre) relative to body centre. */
  originPosition(out: Vector3): Vector3 {
    return out.copy(this.com).negate().applyQuaternion(this.q).add(this.r);
  }

  /** Nose direction in the inertial frame. */
  forward(out: Vector3): Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.q);
  }

  // ---------------------------------------------------------------------------
  // Docking
  // ---------------------------------------------------------------------------

  /** Open face of a docking port: +1 its top (+Y) is free, −1 its bottom, 0 not an open port. */
  freePortFace(p: FlightPart): 0 | 1 | -1 {
    if (!p.def.dock || p.destroyed || p.dockedTo) return 0;
    if (!this.topNeighbor(p)) return 1;
    if (!this.bottomNeighbor(p)) return -1;
    return 0;
  }

  /** Docking ports with an open face: +1 = the port's top (+Y) is free, −1 = its bottom. */
  freeDockPorts(): Array<{ part: FlightPart; face: 1 | -1 }> {
    const out: Array<{ part: FlightPart; face: 1 | -1 }> = [];
    for (const p of this.parts) {
      const f = this.freePortFace(p);
      if (f) out.push({ part: p, face: f });
    }
    return out;
  }

  /** Centre of a docking face (relative to the body centre, inertial) and its outward direction. */
  dockFacePose(port: FlightPart, face: 1 | -1, outPos: Vector3, outDir: Vector3): void {
    _v.set(0, (face * port.height) / 2, 0).applyQuaternion(port.rotation).add(port.position);
    this.localToBody(_v, outPos);
    outDir.set(0, face, 0).applyQuaternion(port.rotation).applyQuaternion(this.q);
  }

  /**
   * Latch `guest` onto this vessel at a pair of docking ports. The guest's parts
   * are re-expressed in this vessel's frame and its root is hung under our port,
   * so the combined vehicle is one part tree again — fuel groups, staging and
   * control all follow. Linear momentum is conserved; the guest object is left
   * empty and marked destroyed so the simulation drops it.
   */
  dock(hostPort: FlightPart, hostFace: 1 | -1, guest: Vessel, guestPort: FlightPart): void {
    const qHinv = _q1.copy(this.q).invert();
    const qRel = _q2.copy(qHinv).multiply(guest.q);
    const originG = guest.originPosition(_v);
    const originH = this.originPosition(_v2);
    for (const p of guest.parts) {
      _v3.copy(p.position).applyQuaternion(guest.q).add(originG).sub(originH).applyQuaternion(qHinv);
      p.position.copy(_v3);
      p.rotation.premultiply(qRel);
    }
    // Both vessels numbered their parts from 1: renumber the guest so uids stay
    // unique in the merged tree (design data and staging are keyed by uid)
    let maxUid = 0;
    let maxSym = 0;
    for (const p of this.parts) {
      maxUid = Math.max(maxUid, p.uid);
      maxSym = Math.max(maxSym, p.symmetry);
    }
    const uidMap = new Map<number, number>();
    for (const p of guest.parts) {
      uidMap.set(p.uid, p.uid + maxUid);
      p.uid += maxUid;
      if (p.symmetry) p.symmetry += maxSym;
    }
    for (let i = 0; i < guest.stages.length; i++) guest.stages[i] = guest.stages[i]!.map((u) => uidMap.get(u) ?? u);
    const root = guest.root;
    root.vesselName = guest.name;
    root.parent = hostPort;
    root.attach = hostFace > 0 ? 'above' : 'below';
    hostPort.children.push(root);
    hostPort.dockedTo = guestPort;
    guestPort.dockedTo = hostPort;
    hostPort.dockRoot = root;
    guestPort.dockRoot = root;
    const mH = this.mass;
    const mG = guest.mass;
    this.v.multiplyScalar(mH).addScaledVector(guest.v, mG).multiplyScalar(1 / (mH + mG));
    this.parts.push(...guest.parts);
    for (let i = guest.nextStage; i < guest.stages.length; i++) this.stages.push(guest.stages[i]!);
    guest.parts = [];
    guest.stages = [];
    guest.destroyed = true;
    this.refreshStructure();
    this.computeMassProperties(true);
  }

  /**
   * The current part tree as design data: what the assembly building would have
   * to contain to rebuild this vehicle (after staging, docking, damage). Stage
   * numbers cover the stages not yet fired. Used to persist vessels between
   * flights and to name undocked modules.
   */
  toCraft(): CraftData {
    const stageOf = new Map<number, number>();
    for (let i = this.nextStage; i < this.stages.length; i++) for (const u of this.stages[i]!) stageOf.set(u, i - this.nextStage);
    let maxUid = 0;
    let maxSym = 0;
    const parts: CraftPart[] = this.parts.map((p) => {
      maxUid = Math.max(maxUid, p.uid);
      maxSym = Math.max(maxSym, p.symmetry);
      const attach: AttachKind = p.parent ? (p.attach === 'root' ? 'below' : p.attach) : 'root';
      return { uid: p.uid, defId: p.def.id, parent: p.parent ? p.parent.uid : -1, attach, angle: p.angle, offsetY: p.offsetY, symmetry: p.symmetry, config: { ...p.config }, stage: stageOf.get(p.uid) ?? -1 };
    });
    return { version: 1, name: this.name, description: '', parts, nextUid: maxUid + 1, nextSymmetry: maxSym + 1, manualStaging: true };
  }

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  /** Recompute groups, aero model, contacts, bounds after any structural change. */
  refreshStructure(): void {
    this.structureVersion++;
    this.computeGroups();
    this.computeShielding();
    this.buildAeroModel();
    this.buildContacts();
    this.computeBounds();
  }

  /**
   * Fuel-flow groups: a decoupler normally starts a new group (a stage cannot
   * drink from the tanks it will drop); a decoupler with CROSSFEED keeps the far
   * side in the same group one level deeper, and engines drain the deepest level
   * first — the booster tanks empty into the core engines before the core's own.
   */
  private computeGroups(): void {
    let next = 0;
    const visit = (p: FlightPart, g: number, depth: number) => {
      p.group = g;
      p.flowDepth = depth;
      for (const c of p.children) {
        if (!c.def.decoupler) visit(c, g, depth);
        else if (c.config.crossfeed) visit(c, g, depth + 1);
        else visit(c, ++next, 0);
      }
    };
    visit(this.root, 0, 0);
  }

  /**
   * Propellant (kg) an engine can still draw: its own grain for a solid, otherwise
   * the matching propellant in every tank of its fuel-flow group (decouplers
   * separate groups, so a stage cannot drink from the tanks below it).
   */
  engineFuel(p: FlightPart): number {
    if (p.isSolid) return p.fuel;
    const e = p.def.engine;
    if (!e) return 0;
    let total = 0;
    for (const t of this.parts) if (t.group === p.group && t.propellant === e.propellant && !t.isSolid) total += t.fuel;
    return total;
  }

  /** True if any stage still to be activated contains an engine that has propellant. */
  hasEngineInLaterStage(): boolean {
    for (let i = this.nextStage; i < this.stages.length; i++) {
      for (const uid of this.stages[i]!) {
        const p = this.partByUid(uid);
        if (p && p.isEngine && this.engineFuel(p) > 0) return true;
      }
    }
    return false;
  }

  /**
   * Drop stages that lost all their parts (destroyed or decoupled with another
   * section): pressing STAGE on an empty one would otherwise do nothing, and the
   * autopilot could never get past it.
   */
  pruneEmptyStages(): void {
    for (let i = this.stages.length - 1; i >= this.nextStage; i--) {
      if (this.stages[i]!.length === 0) this.stages.splice(i, 1);
    }
  }

  private computeShielding(): void {
    for (const p of this.parts) p.shielded = false;
    for (const f of this.parts) {
      if (!f.def.fairing || !f.fairingAttached) continue;
      const y0 = f.position.y + f.height / 2;
      const y1 = y0 + f.fairingLength;
      const rad = f.fairingDiameter / 2 + 0.05;
      for (const p of this.parts) {
        if (p === f) continue;
        const px = Math.hypot(p.position.x - f.position.x, p.position.z - f.position.z);
        if (p.position.y > y0 - 0.05 && p.position.y < y1 && px + (p.def.shape === 'fin' ? 0 : p.radius) * 0.5 < rad) {
          p.shielded = true;
        }
      }
    }
  }

  /** Neighbour stacked on top of p (its top node), or null. */
  topNeighbor(p: FlightPart): FlightPart | null {
    if (p.attach === 'below' && p.parent) return p.parent;
    for (const c of p.children) if (c.attach === 'above') return c;
    return null;
  }

  bottomNeighbor(p: FlightPart): FlightPart | null {
    if (p.attach === 'above' && p.parent) return p.parent;
    for (const c of p.children) if (c.attach === 'below') return c;
    return null;
  }

  private buildAeroModel(): void {
    const faces: AeroFace[] = [];
    const body: AeroBodySegment[] = [];
    const fins: AeroFin[] = [];
    let refR = 0.3;
    const taperCd = (dr: number, h: number) => {
      const s = Math.sin(Math.atan2(Math.abs(dr), Math.max(0.05, h)));
      return Math.max(0.18, 0.08 + 0.85 * s * s);
    };
    for (const p of this.parts) {
      if (p.shielded) continue;
      const shape = p.def.shape;
      if (shape === 'fin' && p.def.fin) {
        const n = new Vector3(0, 0, 1).applyQuaternion(p.rotation);
        const hinge = new Vector3(1, 0, 0).applyQuaternion(p.rotation);
        const pos = new Vector3(p.def.fin.span * 0.45, 0, 0).applyQuaternion(p.rotation).add(p.position);
        fins.push({ part: p, pos, normal: n, area: p.def.fin.area, control: p.def.fin.control ?? 0, hinge });
        continue;
      }
      if (shape === 'solar' || shape === 'leg' || shape === 'radial-chute' || shape === 'radial-decoupler' || shape === 'airbrake') {
        body.push({ part: p, pos: p.position.clone(), sideArea: p.def.height * p.def.diameter * 0.6 });
        continue;
      }
      if (shape === 'truss') {
        // Open lattice: the air mostly passes through it
        body.push({ part: p, pos: p.position.clone(), sideArea: p.stats.diameterTop * p.height * 0.25 });
        continue;
      }
      let rTop = p.stats.diameterTop / 2;
      let rBot = p.stats.diameterBottom / 2;
      if (shape === 'fairing') {
        rTop = rBot = p.fairingDiameter / 2;
      }
      const h = p.height;
      refR = Math.max(refR, rTop, rBot);
      const above = this.topNeighbor(p);
      const below = this.bottomNeighbor(p);
      const rAbove = above && !above.shielded ? above.stats.diameterBottom / 2 : above && above.shielded ? 0 : 0;
      const rBelow = below ? (below.def.shape === 'fairing' ? below.fairingDiameter / 2 : below.stats.diameterTop / 2) : 0;
      const yTop = p.position.y + h / 2;
      const yBot = p.position.y - h / 2;
      const px = p.position.x;
      const pz = p.position.z;
      const blunt = shape === 'heatshield' || shape === 'capsule';

      // Top-facing surfaces
      if (!(shape === 'fairing' && p.fairingAttached)) {
        const flatTop = Math.PI * Math.max(0, rTop * rTop - rAbove * rAbove);
        if (flatTop > 1e-4) {
          faces.push({
            part: p, area: flatTop, facing: 1,
            frontCd: shape === 'parachute' ? 0.6 : 0.85, baseCd: 0.22,
            pos: new Vector3(px, yTop, pz), liftArea: 0, engineBase: false,
          });
        }
        if (rBot > rTop) {
          const a = Math.PI * Math.max(0, rBot * rBot - Math.max(rTop, rAbove) ** 2);
          if (a > 1e-4) {
            const cd = shape === 'nosecone' ? 0.22 : taperCd(rBot - rTop, h);
            faces.push({
              part: p, area: a, facing: 1, frontCd: cd, baseCd: 0.12,
              pos: new Vector3(px, yBot + h / 3, pz), liftArea: a, engineBase: false,
            });
          }
        }
      }
      // Bottom-facing surfaces
      const flatBot = Math.PI * Math.max(0, rBot * rBot - rBelow * rBelow);
      if (flatBot > 1e-4) {
        faces.push({
          part: p, area: flatBot, facing: -1,
          frontCd: blunt ? 1.35 : shape === 'engine' ? 0.7 : 0.9,
          baseCd: shape === 'engine' || shape === 'srb' ? 0.25 : 0.2,
          pos: new Vector3(px, yBot, pz), liftArea: 0, engineBase: shape === 'engine' || shape === 'srb',
        });
      }
      if (rTop > rBot && shape !== 'engine') {
        const a = Math.PI * Math.max(0, rTop * rTop - Math.max(rBot, rBelow) ** 2);
        if (a > 1e-4) {
          faces.push({
            part: p, area: a, facing: -1, frontCd: taperCd(rTop - rBot, h), baseCd: 0.1,
            pos: new Vector3(px, yTop - h / 3, pz), liftArea: a, engineBase: false,
          });
        }
      }
      // Side area for crossflow
      body.push({ part: p, pos: p.position.clone(), sideArea: (rTop + rBot) * h * (shape === 'engine' ? 0.6 : 1) });

      // Attached fairing shell: ogive nose + cylinder
      if (shape === 'fairing' && p.fairingAttached) {
        const L = p.fairingLength;
        const R = p.fairingDiameter / 2;
        const noseL = Math.min(L * 0.5, R * 2.6);
        const cylL = L - noseL;
        const yBase = yTop;
        faces.push({
          part: p, area: Math.PI * R * R, facing: 1, frontCd: 0.24, baseCd: 0.1,
          pos: new Vector3(px, yBase + cylL + noseL / 3, pz), liftArea: Math.PI * R * R, engineBase: false,
        });
        body.push({ part: p, pos: new Vector3(px, yBase + L * 0.45, pz), sideArea: 2 * R * (cylL + noseL * 0.5) });
        refR = Math.max(refR, R);
      }
    }
    this.aeroFaces = faces;
    this.aeroBody = body;
    this.aeroFins = fins;
    this.refRadius = refR;
  }

  private buildContacts(): void {
    const pts: ContactPoint[] = [];
    const ring = (p: FlightPart, y: number, r: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const local = new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
        pts.push({ part: p, pos: local.applyQuaternion(p.rotation).add(p.position), leg: false });
      }
    };
    for (const p of this.parts) {
      const h = p.height;
      const shape = p.def.shape;
      if (shape === 'leg' && p.def.legs) {
        const L = p.def.legs.length;
        const d = p.legDeploy;
        // Stowed: foot tucked along the body; deployed: splayed out and down
        const foot = new Vector3(0.25 + 0.45 * L * d, -h * 0.35 - 0.55 * L * d - 0.25 * L * (1 - d) * 0.3, 0);
        pts.push({ part: p, pos: foot.applyQuaternion(p.rotation).add(p.position), leg: true });
        continue;
      }
      if (shape === 'fin' && p.def.fin) {
        const f = p.def.fin;
        for (const [x, y] of [[f.span, -f.chord * 0.5], [f.span * 0.4, -f.chord * 0.5], [f.span, f.chord * 0.1]] as const) {
          pts.push({ part: p, pos: new Vector3(x, y, 0).applyQuaternion(p.rotation).add(p.position), leg: false });
        }
        continue;
      }
      if (shape === 'solar' || shape === 'radial-chute' || shape === 'radial-decoupler' || shape === 'airbrake') {
        pts.push({ part: p, pos: p.position.clone(), leg: false });
        continue;
      }
      if (shape === 'nosecone') {
        ring(p, -h / 2, p.stats.diameterBottom / 2, 6);
        pts.push({ part: p, pos: new Vector3(0, h / 2, 0).applyQuaternion(p.rotation).add(p.position), leg: false });
        continue;
      }
      const rTop = Math.max(0.15, p.stats.diameterTop / 2);
      const rBot = Math.max(0.15, p.stats.diameterBottom / 2);
      const n = Math.max(rTop, rBot) > 2 ? 12 : 8;
      if (shape === 'engine') {
        ring(p, -h / 2, rBot * 0.9, n);
        ring(p, h / 2, rTop, 6);
      } else {
        ring(p, -h / 2, rBot, n);
        ring(p, h / 2, rTop, n);
      }
      if (shape === 'fairing' && p.fairingAttached) {
        const R = p.fairingDiameter / 2;
        const top = h / 2 + p.fairingLength;
        ring(p, h / 2 + p.fairingLength * 0.5, R, 8);
        pts.push({ part: p, pos: new Vector3(0, top, 0).applyQuaternion(p.rotation).add(p.position), leg: false });
      }
    }
    this.contactPoints = pts;
  }

  private computeBounds(): void {
    const mn = this.boundsMin.set(Infinity, Infinity, Infinity);
    const mx = this.boundsMax.set(-Infinity, -Infinity, -Infinity);
    for (const c of this.contactPoints) {
      mn.min(c.pos);
      mx.max(c.pos);
    }
    for (const p of this.parts) {
      _v.copy(p.position);
      mn.min(_v);
      mx.max(_v);
    }
    if (!isFinite(mn.x)) {
      mn.set(-1, -1, -1);
      mx.set(1, 1, 1);
    }
  }

  get length(): number {
    return this.boundsMax.y - this.boundsMin.y;
  }

  get boundingRadius(): number {
    return Math.max(this.boundsMax.distanceTo(this.com), this.boundsMin.distanceTo(this.com), 1);
  }

  /** Rebuild contacts when legs animate. */
  updateLegContacts(): void {
    let changed = false;
    for (const p of this.parts) if (p.def.shape === 'leg') changed = true;
    if (changed) {
      this.buildContacts();
      this.computeBounds();
    }
  }

  // ---------------------------------------------------------------------------
  // Mass properties
  // ---------------------------------------------------------------------------

  /**
   * Recompute mass, COM and inertia. When `preserveMotion` is true the stored COM
   * state (r, v) is shifted so the parts themselves do not move.
   */
  computeMassProperties(preserveMotion = true): void {
    let m = 0;
    const c = _v.set(0, 0, 0);
    for (const p of this.parts) {
      const pm = Math.max(p.mass, 0.01);
      m += pm;
      c.addScaledVector(p.position, pm);
    }
    c.multiplyScalar(1 / m);
    if (preserveMotion) {
      // shift = newCOM - oldCOM (vessel frame) → move r and v consistently
      const shift = _v2.copy(c).sub(this.com);
      if (shift.lengthSq() > 0) {
        const wShift = _v3.crossVectors(this.w, shift).applyQuaternion(this.q);
        this.r.add(shift.applyQuaternion(this.q));
        this.v.add(wShift);
      }
    }
    this.com.copy(c);
    this.mass = m;
    // Inertia tensor about COM (scratch array: this runs every physics step)
    const e = _inertia.fill(0);
    for (const p of this.parts) {
      const pm = Math.max(p.mass, 0.01);
      const r = p.radius;
      const h = p.height;
      const iAxis = 0.5 * pm * r * r;
      const iTrans = (pm * (3 * r * r + h * h)) / 12;
      const dx = p.position.x - c.x;
      const dy = p.position.y - c.y;
      const dz = p.position.z - c.z;
      // local cylinder inertia assumed axis-aligned with vessel Y (radial parts approx.)
      e[0] += iTrans + pm * (dy * dy + dz * dz);
      e[4] += iAxis + pm * (dx * dx + dz * dz);
      e[8] += iTrans + pm * (dx * dx + dy * dy);
      e[1] -= pm * dx * dy;
      e[2] -= pm * dx * dz;
      e[5] -= pm * dy * dz;
    }
    e[3] = e[1];
    e[6] = e[2];
    e[7] = e[5];
    // Matrix3.set takes row-major arguments
    this.inertia.set(e[0]!, e[1]!, e[2]!, e[3]!, e[4]!, e[5]!, e[6]!, e[7]!, e[8]!);
    this.invInertia.copy(this.inertia).invert();
    this.inertiaDiag.set(e[0]!, e[4]!, e[8]!);
  }

  // ---------------------------------------------------------------------------
  // Staging & splitting
  // ---------------------------------------------------------------------------

  get stageCount(): number {
    return this.stages.length;
  }

  partByUid(uid: number): FlightPart | undefined {
    return this.parts.find((p) => p.uid === uid);
  }

  /** All parts in the subtree rooted at p. */
  subtree(p: FlightPart, out: FlightPart[] = []): FlightPart[] {
    out.push(p);
    for (const c of p.children) this.subtree(c, out);
    return out;
  }

  /**
   * Detach the subtree rooted at `p` into a new vessel. Returns the new vessel.
   * `sepDv` pushes the two halves apart along `axis` (inertial frame).
   */
  split(p: FlightPart, sepDv: number, axis: Vector3 | null): Vessel | null {
    if (p === this.root || !p.parent) return null;
    const moving = this.subtree(p);
    const movingSet = new Set(moving);
    const parent = p.parent;
    parent.children.splice(parent.children.indexOf(p), 1);
    p.parent = null;
    this.parts = this.parts.filter((x) => !movingSet.has(x));

    // Build the child vessel with identical frame & motion
    const child = new Vessel(moving, p, this.body, `${this.name} debris`);
    child.debris = !moving.some((x) => !!x.def.command);
    child.q.copy(this.q);
    child.w.copy(this.w);
    const origin = this.originPosition(new Vector3());
    child.r.copy(child.com).applyQuaternion(this.q).add(origin);
    // velocity of the child's COM point on the rotating body
    const off = new Vector3().copy(child.com).sub(this.com);
    child.v.copy(this.v).add(new Vector3().crossVectors(this.w, off).applyQuaternion(this.q));
    child.situation = this.situation === 'prelaunch' ? 'flying' : this.situation;
    // The stages still to fire follow their parts: a separated section that
    // carries the command module (and gets control) keeps its own staging
    const movingUids = new Set(moving.map((x) => x.uid));
    child.stages = this.stages
      .slice(this.nextStage)
      .map((st) => st.filter((u) => movingUids.has(u)))
      .filter((st) => st.length > 0);
    child.nextStage = 0;
    child.controls.throttle = 0;
    child.onRails = false;

    const mChild = child.mass;
    this.computeMassProperties(true);
    const mThis = this.mass;
    if (axis && sepDv > 0) {
      const total = mThis + mChild;
      this.v.addScaledVector(axis, (sepDv * mChild) / total);
      child.v.addScaledVector(axis, (-sepDv * mThis) / total);
    }
    // Remove moved parts from remaining stages
    const movedUids = new Set<number>();
    for (const x of moving) movedUids.add(x.uid);
    this.stages = this.stages.map((s) => s.filter((u) => !movedUids.has(u)));
    this.pruneEmptyStages();
    this.refreshStructure();
    child.refreshStructure();
    return child;
  }

  /** Build simulation parts for the Δv analyser from the current flight state. */
  toSimParts(): SimPart[] {
    const stageOf = new Map<number, number>();
    this.stages.forEach((s, i) => s.forEach((u) => stageOf.set(u, i)));
    return this.parts.map((p) => ({
      uid: p.uid,
      parent: p.parent ? p.parent.uid : -1,
      dryMass: p.mass - p.fuel,
      fuel: p.fuel,
      propellant: p.propellant,
      group: p.group,
      depth: p.flowDepth,
      command: !!p.def.command,
      engine: p.isEngine
        ? {
            thrustVac: p.stats.thrustVac * (p.flameout && !p.isSolid && p.ignitionsLeft <= 0 && !p.engineRunning ? 0 : 1),
            thrustSL: p.stats.thrustSL,
            ispVac: p.stats.ispVac,
            ispSL: p.stats.ispSL,
            propellant: p.isSolid ? 'solid' : p.def.engine!.propellant,
            solid: p.isSolid,
            axial: Math.abs(_v.set(0, 1, 0).applyQuaternion(p.rotation).y),
          }
        : null,
      stage: stageOf.get(p.uid) ?? -1,
      decoupler: !!p.def.decoupler,
      sepAt: p.def.decoupler && !p.def.decoupler.radial && p.attach === 'above' ? p.children.find((c) => c.attach === 'above')?.uid : undefined,
      ignited: p.engineIgnited,
    }));
  }
}
