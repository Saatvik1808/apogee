/**
 * LEARNING NOTE: Building a launch complex procedurally
 *
 * A launch pad is mostly repetition: a lattice tower is hundreds of identical steel
 * beams, so we draw them with INSTANCING (one draw call, a transform per beam).
 * The complex lives in a local frame (X = east, Y = up, Z = south) anchored to the
 * rotating Earth at the site's latitude/longitude, so it moves with the planet —
 * exactly like the rocket standing on it before liftoff.
 *
 * Key concepts: instanced meshes, local tangent frames (ENU), procedural
 * architecture, emissive lighting for night scenes
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  SpotLight,
  Vector3,
  type Texture,
} from 'three';
import { MAT } from './vessel/Materials';

export interface PadTextures {
  concrete: { diff: Texture; nor: Texture; rough: Texture };
}

function stdMesh(geo: BufferGeometry, mat: MeshStandardMaterial | import('three').Material): Mesh {
  const m = new Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class LaunchPad {
  readonly group = new Group();
  readonly lights: Array<SpotLight | PointLight> = [];
  private readonly lamps: MeshStandardMaterial;
  readonly towerHeight: number;
  /** Crew arm pivot (swings away at liftoff). */
  private readonly arm: Object3D;
  private armAngle = 0;
  /** Shared source textures (never disposed here; the per-pad clones are). */
  private readonly sourceConcrete: PadTextures['concrete'];

  constructor(tex: PadTextures, vesselHeight: number, vesselRadius: number) {
    this.group.name = 'launch-pad';
    this.sourceConcrete = tex.concrete;
    const concreteTex = (t: Texture, rep: number) => {
      const c = t.clone();
      c.wrapS = c.wrapT = RepeatWrapping;
      c.repeat.set(rep, rep);
      c.needsUpdate = true;
      return c;
    };
    const concrete = new MeshStandardMaterial({
      map: concreteTex(tex.concrete.diff, 24),
      normalMap: concreteTex(tex.concrete.nor, 24),
      roughnessMap: concreteTex(tex.concrete.rough, 24),
      roughness: 1,
      metalness: 0,
      color: new Color(0.82, 0.8, 0.76),
    });
    const darkConcrete = concrete.clone();
    darkConcrete.color = new Color(0.35, 0.34, 0.33);
    const steel = new MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.55, metalness: 0.7 });
    const redSteel = new MeshStandardMaterial({ color: 0x9e3a26, roughness: 0.6, metalness: 0.5 });
    this.lamps = new MeshStandardMaterial({ color: 0xffffff, emissive: new Color(1, 0.92, 0.75), emissiveIntensity: 0 });

    // --- Hardstand with flame trench ---------------------------------------
    const W = 140;
    const trenchW = Math.max(12, vesselRadius * 2.6);
    const halfW = (W - trenchW) / 2;
    for (const side of [-1, 1]) {
      const slab = stdMesh(new BoxGeometry(halfW, 2, W), concrete);
      slab.position.set(side * (trenchW / 2 + halfW / 2), -0.95, 0);
      this.group.add(slab);
    }
    const trench = stdMesh(new BoxGeometry(trenchW, 1, W * 0.8), darkConcrete);
    trench.position.set(0, -9, 0);
    this.group.add(trench);
    for (const side of [-1, 1]) {
      const wall = stdMesh(new BoxGeometry(0.8, 9, W * 0.8), darkConcrete);
      wall.position.set(side * (trenchW / 2 - 0.4), -4.5, 0);
      this.group.add(wall);
    }
    // Hold-down posts around the vehicle base
    const r0 = Math.max(vesselRadius + 1.2, 3);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const post = stdMesh(new BoxGeometry(1.2, 2.5, 1.2), steel);
      post.position.set(Math.cos(a) * r0, 1.25, Math.sin(a) * r0);
      this.group.add(post);
      const beam = stdMesh(new BoxGeometry(Math.max(4, trenchW * 0.6), 0.9, 1.4), steel);
      beam.position.set(Math.cos(a) * r0 * 0.9, 0.2, Math.sin(a) * r0 * 0.9);
      beam.rotation.y = -a;
      this.group.add(beam);
    }

    // --- Service tower (instanced lattice) ------------------------------------
    const H = Math.max(40, vesselHeight + 14);
    this.towerHeight = H;
    const towerZ = -(vesselRadius + 11);
    const T = 10; // tower footprint
    const levels = Math.ceil(H / 6);
    const beamGeo = new BoxGeometry(1, 1, 1);
    const count = levels * 12 + 8;
    const inst = new InstancedMesh(beamGeo, redSteel, count);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m4 = new Matrix4();
    const q = new Quaternion();
    const sc = new Vector3();
    let n = 0;
    const put = (a: Vector3, b: Vector3, w: number) => {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const d = b.clone().sub(a);
      const len = d.length();
      q.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize());
      sc.set(w, len, w);
      m4.compose(mid, q, sc);
      if (n < count) inst.setMatrixAt(n++, m4);
    };
    const corners = [
      new Vector3(-T / 2, 0, towerZ - T / 2),
      new Vector3(T / 2, 0, towerZ - T / 2),
      new Vector3(T / 2, 0, towerZ + T / 2),
      new Vector3(-T / 2, 0, towerZ + T / 2),
    ];
    for (const c of corners) put(c, c.clone().setY(H), 0.9);
    for (let l = 0; l < levels; l++) {
      const y0 = l * 6;
      const y1 = Math.min(H, y0 + 6);
      for (let i = 0; i < 4; i++) {
        const a = corners[i]!.clone().setY(y1);
        const b = corners[(i + 1) % 4]!.clone().setY(y1);
        put(a, b, 0.5);
        const a0 = corners[i]!.clone().setY(y0);
        const b1 = corners[(i + 1) % 4]!.clone().setY(y1);
        put(a0, b1, 0.35);
      }
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
    // Tower top cap + lightning mast
    const cap = stdMesh(new BoxGeometry(T + 2, 1.5, T + 2), steel);
    cap.position.set(0, H + 0.75, towerZ);
    this.group.add(cap);
    const mast = stdMesh(new CylinderGeometry(0.25, 0.5, 30, 8), steel);
    mast.position.set(0, H + 15, towerZ);
    this.group.add(mast);

    // Crew access arm near the top of the vehicle
    this.arm = new Group();
    this.arm.position.set(-T / 2 + 1, Math.max(8, vesselHeight - 6), towerZ + T / 2);
    const armLen = Math.abs(towerZ + T / 2) - vesselRadius - 0.4;
    const armMesh = stdMesh(new BoxGeometry(2.4, 2.8, Math.max(2, armLen)), steel);
    armMesh.position.set(T / 2 - 1, 0, Math.max(2, armLen) / 2);
    this.arm.add(armMesh);
    this.group.add(this.arm);

    // --- Lightning masts & catenary wires ------------------------------------
    const mastPos = [new Vector3(-55, 0, -40), new Vector3(55, 0, -40), new Vector3(0, 0, 62)];
    const mastH = H + 30;
    for (const p of mastPos) {
      const m = stdMesh(new CylinderGeometry(0.4, 0.9, mastH, 8), steel);
      m.position.set(p.x, mastH / 2, p.z);
      this.group.add(m);
    }
    const wirePts: number[] = [];
    const top = (p: Vector3) => new Vector3(p.x, mastH, p.z);
    const addWire = (a: Vector3, b: Vector3) => {
      const N = 20;
      for (let i = 0; i < N; i++) {
        const t0 = i / N;
        const t1 = (i + 1) / N;
        const p0 = a.clone().lerp(b, t0);
        const p1 = a.clone().lerp(b, t1);
        p0.y -= Math.sin(t0 * Math.PI) * 18;
        p1.y -= Math.sin(t1 * Math.PI) * 18;
        wirePts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
      }
    };
    addWire(top(mastPos[0]!), top(mastPos[1]!));
    addWire(top(mastPos[1]!), top(mastPos[2]!));
    addWire(top(mastPos[2]!), top(mastPos[0]!));
    const wg = new BufferGeometry();
    wg.setAttribute('position', new Float32BufferAttribute(wirePts, 3));
    this.group.add(new LineSegments(wg, new LineBasicMaterial({ color: 0x222222 })));

    // --- Water tower, propellant spheres, crawlerway, buildings ----------------
    const wt = new Group();
    const col = stdMesh(new CylinderGeometry(2, 3, 50, 12), steel);
    col.position.y = 25;
    wt.add(col);
    const tank = stdMesh(new SphereGeometry(9, 24, 16), MAT.whitePaint());
    tank.position.y = 56;
    wt.add(tank);
    wt.position.set(-210, 0, 150);
    this.group.add(wt);
    for (const [x, z, r] of [[160, -120, 11], [185, -95, 9], [-170, -160, 13]] as const) {
      const sph = stdMesh(new SphereGeometry(r, 24, 16), MAT.whitePaint());
      sph.position.set(x, r + 3, z);
      this.group.add(sph);
      const base = stdMesh(new CylinderGeometry(r * 0.6, r * 0.8, 4, 12), darkConcrete);
      base.position.set(x, 2, z);
      this.group.add(base);
    }
    const road = stdMesh(new BoxGeometry(40, 0.2, 1200), darkConcrete);
    road.position.set(0, 0.02, 660);
    this.group.add(road);
    for (const [x, z, w, h, d] of [[-120, 240, 60, 18, 40], [140, 300, 40, 12, 30], [-260, -60, 30, 10, 50]] as const) {
      const b = stdMesh(new BoxGeometry(w, h, d), MAT.grayPaint());
      b.position.set(x, h / 2, z);
      this.group.add(b);
    }

    // --- Floodlights --------------------------------------------------------
    for (const [x, z] of [[-45, 45], [45, 45], [45, -45], [-45, -45]] as const) {
      const pole = stdMesh(new CylinderGeometry(0.3, 0.45, 26, 8), steel);
      pole.position.set(x, 13, z);
      this.group.add(pole);
      const lamp = stdMesh(new BoxGeometry(3, 1.6, 1), this.lamps);
      lamp.position.set(x * 0.95, 26, z * 0.95);
      lamp.lookAt(new Vector3(0, vesselHeight * 0.5, 0));
      this.group.add(lamp);
    }
    for (const [x, z] of [[-45, 45], [45, -45]] as const) {
      const s = new SpotLight(0xffe6c0, 0, 320, 0.45, 0.6, 2);
      s.position.set(x, 26, z);
      s.target.position.set(0, vesselHeight * 0.45, 0);
      this.group.add(s);
      this.group.add(s.target);
      this.lights.push(s);
    }
  }

  /**
   * Free every geometry, material and texture this pad created. A pad is built
   * per flight, and three.js keeps undisposed geometry alive in its binding
   * cache — so without this each launch leaked the whole complex.
   */
  dispose(): void {
    const mats = new Set<import('three').Material>();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        if (Array.isArray(m.material)) for (const x of m.material) mats.add(x);
        else mats.add(m.material);
      }
      if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
    });
    for (const m of mats) {
      const s = m as MeshStandardMaterial;
      // The concrete maps are per-pad clones (own repeat settings): free their GPU copies
      if (s.map && s.map !== this.sourceConcrete.diff) s.map.dispose();
      if (s.normalMap && s.normalMap !== this.sourceConcrete.nor) s.normalMap.dispose();
      if (s.roughnessMap && s.roughnessMap !== this.sourceConcrete.rough) s.roughnessMap.dispose();
      m.dispose();
    }
    for (const l of this.lights) l.dispose();
    this.group.removeFromParent();
  }

  /** Floodlights on at night; crew arm retracts after liftoff. */
  update(sunElevation: number, dt: number, liftoff: boolean): void {
    const night = Math.max(0, Math.min(1, (0.08 - sunElevation) / 0.12));
    this.lamps.emissiveIntensity = night * 4;
    // ~4 lux-equivalent on the vehicle 70 m away: floodlit, not blinding
    for (const l of this.lights) l.intensity = night * 20000;
    const target = liftoff ? -Math.PI * 0.55 : 0;
    this.armAngle += (target - this.armAngle) * Math.min(1, dt * 0.6);
    this.arm.rotation.y = this.armAngle;
  }
}
