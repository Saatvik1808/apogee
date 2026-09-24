/**
 * LEARNING NOTE: The assembly building — rendering a design, not a simulation
 *
 * In the hangar the rocket is just geometry laid out from the part tree (the same
 * layout pass the physics uses, so what you build is exactly what flies). We
 * light it with an HDR photograph of a real industrial interior (image-based
 * lighting: every pixel of the panorama is a light source, prefiltered by PMREM
 * so rough and shiny paints both pick up believable reflections), add a key light
 * for crisp shadows, and stand it on a concrete floor.
 *
 * Interaction needs PICKING: a ray from the camera through the mouse pointer is
 * intersected with the part meshes (raycasting); each mesh remembers which part
 * uid it belongs to. Attach points are small glowing rings at the free stack
 * nodes, and a translucent "ghost" previews where a held part will go.
 *
 * Key concepts: image-based lighting (IBL), PMREM, raycasting and picking,
 * scene graphs from data, preview/ghost rendering
 */
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EquirectangularReflectionMapping,
  Group,
  HemisphereLight,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  type BufferGeometry,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import type { CraftData, CraftPart, PartLayout } from '../../parts/Craft';
import { craftBounds, layoutCraft } from '../../parts/Craft';
import type { GameAssets } from '../../render/Assets';
import { buildInterstage, buildPartVisual, disposeObject } from '../../render/vessel/PartMeshes';

export interface AttachNode {
  /** Parent part uid (-1: becomes the root). */
  parent: number;
  kind: 'above' | 'below' | 'root';
  /** World position (hangar frame). */
  pos: Vector3;
}

const _v = new Vector3();
const _q = new Quaternion();

/** Top/bottom stack neighbours in a craft (mirrors Vessel.topNeighbor/bottomNeighbor). */
export function stackNeighbors(c: CraftData, p: CraftPart): { above: CraftPart | null; below: CraftPart | null } {
  let above: CraftPart | null = null;
  let below: CraftPart | null = null;
  const parent = p.parent >= 0 ? c.parts.find((x) => x.uid === p.parent) ?? null : null;
  if (p.attach === 'below' && parent) above = parent;
  if (p.attach === 'above' && parent) below = parent;
  for (const ch of c.parts) {
    if (ch.parent !== p.uid) continue;
    if (ch.attach === 'above') above = ch;
    else if (ch.attach === 'below') below = ch;
  }
  return { above, below };
}

export class VABScene {
  readonly scene = new Scene();
  readonly craftGroup = new Group();
  private readonly ghostGroup = new Group();
  private readonly nodeGroup = new Group();
  private readonly highlightGroup = new Group();
  private readonly key: DirectionalLight;
  private readonly renderer: WebGLRenderer;
  private envTex: Texture | null = null;
  /** PMREM target behind envTex — a render-target texture is only freed through its target. */
  private envRT: WebGLRenderTarget | null = null;
  /** Hangar geometry/materials/textures created here (part visuals are disposed separately). */
  private readonly ownGeometries: BufferGeometry[] = [];
  private readonly ownMaterials: Material[] = [];
  private readonly ownTextures: Texture[] = [];
  private readonly raycaster = new Raycaster();
  /** Part uid → root object of its visual. */
  readonly partObjects = new Map<number, Group>();
  layout = new Map<number, PartLayout>();
  /** Vertical offset that puts the lowest point of the craft on the floor. */
  floorOffset = 0;
  /** Extra height the craft floats at (room to attach parts underneath). */
  lift = 0;
  readonly bounds = { min: new Vector3(), max: new Vector3() };
  private readonly nodeMat = new MeshBasicMaterial({ color: new Color(0.2, 1.4, 2.2), transparent: true, opacity: 0.85, depthTest: false, side: DoubleSide });
  private readonly nodeHotMat = new MeshBasicMaterial({ color: new Color(2.6, 1.4, 0.3), transparent: true, opacity: 0.95, depthTest: false, side: DoubleSide });
  private readonly ghostMat = new MeshStandardMaterial({ color: 0x66ccff, emissive: new Color(0.1, 0.45, 0.8), transparent: true, opacity: 0.38, depthWrite: false, roughness: 0.4 });
  private readonly selectMat = new MeshBasicMaterial({ color: new Color(1.4, 0.7, 0.15), transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false });
  private readonly hoverMat = new MeshBasicMaterial({ color: new Color(0.35, 0.8, 1.2), transparent: true, opacity: 0.2, blending: AdditiveBlending, depthWrite: false });
  private nodes: Array<{ node: AttachNode; mesh: Mesh }> = [];

  /**
   * @param shadows the player's shadow setting (the hangar has its own key light,
   *   so the renderer's shadow state must be set here — not inherited from
   *   whichever flight ran last)
   */
  constructor(renderer: WebGLRenderer, assets: GameAssets, shadows: { enabled: boolean; size: number } = { enabled: true, size: 2048 }) {
    this.renderer = renderer;
    const s = this.scene;
    // Image-based lighting from the hangar panorama
    if (assets.vabHdr) {
      const hdr = assets.vabHdr;
      hdr.mapping = EquirectangularReflectionMapping;
      const pm = new PMREMGenerator(renderer);
      this.envRT = pm.fromEquirectangular(hdr);
      this.envTex = this.envRT.texture;
      pm.dispose();
      s.environment = this.envTex;
      s.environmentIntensity = 1.1;
      s.background = hdr;
      s.backgroundBlurriness = 0.12;
      s.backgroundIntensity = 0.55;
    } else {
      s.background = new Color(0x0d1117);
      s.add(new HemisphereLight(0xbfd4ff, 0x302820, 1.4));
    }
    // Key light (high, from the front-left) for defined shadows
    renderer.shadowMap.enabled = shadows.enabled;
    this.key = new DirectionalLight(0xfff1e0, 2.2);
    this.key.castShadow = shadows.enabled;
    this.key.shadow.mapSize.set(shadows.size, shadows.size);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.03;
    s.add(this.key, this.key.target);
    const rim = new DirectionalLight(0x9cc8ff, 0.9);
    rim.position.set(-30, 40, -60);
    s.add(rim);

    // Floor: polished concrete with a painted service ring
    const tex = assets.pbr.concrete;
    const rep = (t: Texture, srgb: boolean) => {
      const c = t.clone();
      c.wrapS = c.wrapT = RepeatWrapping;
      c.repeat.set(24, 24);
      if (srgb) c.colorSpace = SRGBColorSpace;
      c.needsUpdate = true;
      this.ownTextures.push(c);
      return c;
    };
    const floorMat = new MeshStandardMaterial({
      map: rep(tex.diff, true),
      normalMap: rep(tex.nor, false),
      roughnessMap: rep(tex.rough, false),
      roughness: 0.62,
      metalness: 0.0,
      color: 0x9a9a98,
      envMapIntensity: 0.9,
    });
    const own = <T extends BufferGeometry>(g: T): T => {
      this.ownGeometries.push(g);
      return g;
    };
    const floor = new Mesh(own(new CircleGeometry(90, 96)), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const ringMat = new MeshStandardMaterial({ color: 0xe8b21a, roughness: 0.5, emissive: new Color(0.05, 0.03, 0) });
    for (const [r0, r1] of [[9.6, 10], [18.8, 19]] as const) {
      const ring = new Mesh(own(new RingGeometry(r0, r1, 128)), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.01;
      ring.receiveShadow = true;
      s.add(ring);
    }
    // Launch-mount pedestal under the rocket
    const pedMat = new MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.45, metalness: 0.7 });
    const ped = new Mesh(own(new CircleGeometry(4.2, 64)), pedMat);
    ped.rotation.x = -Math.PI / 2;
    ped.position.y = 0.02;
    ped.receiveShadow = true;
    s.add(ped);
    this.ownMaterials.push(floorMat, ringMat, pedMat, this.nodeMat, this.nodeHotMat, this.ghostMat, this.selectMat, this.hoverMat);

    s.add(this.craftGroup, this.ghostGroup, this.nodeGroup, this.highlightGroup);
    this.nodeGroup.renderOrder = 50;
  }

  /** Rebuild every part mesh from the craft. */
  setCraft(c: CraftData): void {
    for (const o of this.partObjects.values()) {
      this.craftGroup.remove(o);
      disposeObject(o);
    }
    this.partObjects.clear();
    this.layout = layoutCraft(c);
    const b = craftBounds(this.layout);
    this.floorOffset = c.parts.length ? -b.min.y + 0.05 : 0;
    this.bounds.min.copy(b.min).setY(b.min.y + this.floorOffset);
    this.bounds.max.copy(b.max).setY(b.max.y + this.floorOffset);
    this.craftGroup.position.set(0, this.floorOffset + this.lift, 0);
    for (const l of this.layout.values()) {
      const obj = this.buildPart(c, l);
      obj.userData.uid = l.uid;
      this.craftGroup.add(obj);
      this.partObjects.set(l.uid, obj);
    }
    this.craftGroup.updateMatrixWorld(true);
    // Shadow frustum around the craft
    const size = Math.max(12, this.bounds.max.y - this.bounds.min.y, this.bounds.max.x - this.bounds.min.x);
    const k = this.key;
    k.position.set(size * 0.8, size * 1.4 + 20, size * 1.1);
    k.target.position.set(0, size * 0.35, 0);
    const sc = k.shadow.camera;
    sc.left = -size;
    sc.right = size;
    sc.top = size * 1.2;
    sc.bottom = -size * 0.4;
    sc.near = 1;
    sc.far = size * 6 + 60;
    sc.updateProjectionMatrix();
  }

  private buildPart(c: CraftData, l: PartLayout): Group {
    const { above, below } = stackNeighbors(c, l.part);
    const aboveLay = above ? this.layout.get(above.uid) : undefined;
    const parentBottom = l.def.shape === 'engine' && aboveLay ? aboveLay.stats.diameterBottom : 0;
    const vis = buildPartVisual(l.def, l.stats, l.part.config, { parentBottomDiameter: parentBottom, topAttached: !!above, bottomAttached: !!below });
    const obj = vis.root;
    obj.position.copy(l.position);
    obj.quaternion.copy(l.rotation);
    // Interstage over an engine that sits on this decoupler
    if (l.def.shape === 'decoupler' && aboveLay && aboveLay.def.shape === 'engine') {
      const mount = above ? stackNeighbors(c, above).above : null;
      const mountLay = mount ? this.layout.get(mount.uid) : undefined;
      const h = aboveLay.position.y + aboveLay.stats.height / 2 - (l.position.y + l.stats.height / 2);
      if (h > 0.1) {
        const r = Math.max(l.stats.diameterTop, mountLay ? mountLay.stats.diameterBottom : 0) / 2;
        const shell = buildInterstage(r, h);
        shell.position.y = l.stats.height / 2 + h / 2;
        obj.add(shell);
      }
    }
    return obj;
  }

  /** Raise the craft off the floor (while holding a part). */
  setLift(lift: number): void {
    this.lift = lift;
    this.craftGroup.position.y = this.floorOffset + lift;
    this.craftGroup.updateMatrixWorld(true);
  }

  // -------------------------------------------------------------- attach nodes

  /** Show attach rings for the given nodes; `hot` is the hovered one. */
  showNodes(nodes: AttachNode[], hot: AttachNode | null, radius: number): void {
    for (const n of this.nodes) {
      this.nodeGroup.remove(n.mesh);
      n.mesh.geometry.dispose();
    }
    this.nodes = [];
    for (const node of nodes) {
      const isHot = hot === node;
      const g = new RingGeometry(radius * 0.55, radius * (isHot ? 0.95 : 0.8), 40);
      const m = new Mesh(g, isHot ? this.nodeHotMat : this.nodeMat);
      m.position.copy(node.pos);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 60;
      this.nodeGroup.add(m);
      const dot = new Mesh(new SphereGeometry(radius * 0.18, 12, 8), isHot ? this.nodeHotMat : this.nodeMat);
      dot.position.copy(node.pos);
      dot.renderOrder = 61;
      this.nodeGroup.add(dot);
      this.nodes.push({ node, mesh: m }, { node, mesh: dot });
    }
  }

  /** Free stack nodes where a part with the given stack capabilities could attach. */
  computeNodes(c: CraftData, canAttachAbove: boolean, canAttachBelow: boolean): AttachNode[] {
    const out: AttachNode[] = [];
    if (!c.parts.length) {
      out.push({ parent: -1, kind: 'root', pos: new Vector3(0, 3, 0) });
      return out;
    }
    for (const l of this.layout.values()) {
      if (l.part.attach === 'radial') continue;
      const { above, below } = stackNeighbors(c, l.part);
      const up = _v.set(0, 1, 0).applyQuaternion(l.rotation);
      const node = (sign: number) => l.position.clone().addScaledVector(up, (sign * l.stats.height) / 2).add(this.craftGroup.position);
      if (!above && l.def.stackTop && canAttachAbove) out.push({ parent: l.uid, kind: 'above', pos: node(1) });
      if (!below && l.def.stackBottom && canAttachBelow) out.push({ parent: l.uid, kind: 'below', pos: node(-1) });
    }
    return out;
  }

  /** Nearest node to the pointer in screen space (within `maxPx`). */
  pickNode(nodes: AttachNode[], camera: PerspectiveCamera, px: number, py: number, w: number, h: number, maxPx = 42): AttachNode | null {
    let best: AttachNode | null = null;
    let bestD = maxPx;
    for (const n of nodes) {
      _v.copy(n.pos).project(camera);
      if (_v.z > 1 || _v.z < -1) continue;
      const sx = (_v.x * 0.5 + 0.5) * w;
      const sy = (-_v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  // -------------------------------------------------------------- picking

  /** Part under the pointer, with the hit point in craft (vessel) coordinates. */
  pickPart(camera: PerspectiveCamera, ndcX: number, ndcY: number): { uid: number; point: Vector3; normal: Vector3 } | null {
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
    const hits = this.raycaster.intersectObject(this.craftGroup, true);
    for (const hit of hits) {
      let o: Object3D | null = hit.object;
      while (o && o.userData.uid === undefined) o = o.parent;
      if (!o) continue;
      const point = this.craftGroup.worldToLocal(hit.point.clone());
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new Vector3(1, 0, 0);
      return { uid: o.userData.uid as number, point, normal };
    }
    return null;
  }

  // -------------------------------------------------------------- ghost & highlight

  /**
   * Show translucent copies of the given uids (from a preview craft).
   * @param floorOffset vertical offset to draw with (null: sit the preview on the floor)
   */
  setGhost(c: CraftData | null, uids: number[], floorOffset: number | null = null): void {
    for (const ch of [...this.ghostGroup.children]) {
      this.ghostGroup.remove(ch);
      disposeObject(ch);
    }
    if (!c || !uids.length) return;
    const lay = layoutCraft(c);
    const off = floorOffset ?? -craftBounds(lay).min.y + 0.05;
    const saved = this.layout;
    this.layout = lay;
    for (const uid of uids) {
      const l = lay.get(uid);
      if (!l) continue;
      const obj = this.buildPart(c, l);
      obj.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) {
          m.material = this.ghostMat;
          m.castShadow = false;
          m.renderOrder = 40;
        }
      });
      obj.position.y += off;
      this.ghostGroup.add(obj);
    }
    this.layout = saved;
  }

  /** Additive overlay on the selected and hovered parts. */
  setHighlight(selected: number[], hovered: number | null): void {
    for (const ch of [...this.highlightGroup.children]) this.highlightGroup.remove(ch);
    const add = (uid: number, mat: Material) => {
      const src = this.partObjects.get(uid);
      if (!src) return;
      src.updateMatrixWorld(true);
      src.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh || !m.visible) return;
        const copy = new Mesh(m.geometry, mat);
        m.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
        copy.scale.multiplyScalar(1.004);
        copy.renderOrder = 45;
        this.highlightGroup.add(copy);
      });
    };
    for (const u of selected) add(u, this.selectMat);
    if (hovered !== null && !selected.includes(hovered)) add(hovered, this.hoverMat);
  }

  /** World position of a craft-frame point. */
  toWorld(p: Vector3, out: Vector3): Vector3 {
    return out.copy(p).add(this.craftGroup.position);
  }

  /** Rotation of a part (for radial attachment math). */
  partRotation(uid: number): Quaternion {
    const l = this.layout.get(uid);
    return l ? _q.copy(l.rotation) : _q.identity();
  }

  get height(): number {
    return Math.max(4, this.bounds.max.y - this.bounds.min.y);
  }

  centerY(): number {
    return (this.bounds.min.y + this.bounds.max.y) / 2;
  }

  dispose(): void {
    for (const o of this.partObjects.values()) disposeObject(o);
    this.setGhost(null, []);
    this.showNodes([], null, 1);
    // The PMREM environment (≈6 MB) and the 2048² shadow map (≈32 MB) are
    // per-visit GPU allocations: free them, or every trip to the hangar leaks them
    this.envRT?.dispose();
    this.envRT = null;
    this.envTex = null;
    this.key.shadow.dispose();
    this.key.dispose();
    for (const g of this.ownGeometries) g.dispose();
    for (const m of this.ownMaterials) m.dispose();
    for (const t of this.ownTextures) t.dispose();
    this.renderer.renderLists.dispose();
  }
}
