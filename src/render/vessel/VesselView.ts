/**
 * LEARNING NOTE: Keeping visuals in sync with simulation
 *
 * The simulation owns the truth (part list, fuel, chute states); the view owns the
 * meshes. Each frame the view reads simulation state and animates: plumes grow
 * with throttle and balloon in thin air, nozzle interiors glow, parachute canopies
 * inflate and swing to trail behind the airflow, legs unfold, solar arrays deploy.
 *
 * When the part tree changes (staging, a part burning off), the simulation bumps
 * `structureVersion` and the view rebuilds — the separated stage gets its own
 * view, so debris keeps looking like the stage you just dropped.
 *
 * Key concepts: model–view separation, dirty flags / versioning, per-frame
 * animation from state
 */
import { Group, Quaternion, Vector3 } from 'three';
import type { FlightPart } from '../../sim/FlightPart';
import type { Vessel } from '../../sim/Vessel';
import { buildInterstage, buildPartVisual, disposeObject, poseLeg, type PartVisual } from './PartMeshes';
import { Plume } from './Plume';

interface PartEntry {
  part: FlightPart;
  obj: Group;
  vis: PartVisual;
  plumes: Plume[];
}

const _v = new Vector3();
const _nDir = new Vector3();
const _q = new Quaternion();
const _qInv = new Quaternion();
const Y = new Vector3(0, 1, 0);

export class VesselView {
  readonly vessel: Vessel;
  readonly group = new Group();
  private readonly entries = new Map<number, PartEntry>();
  private builtVersion = -1;

  constructor(vessel: Vessel) {
    this.vessel = vessel;
    this.group.name = `vessel-${vessel.id}`;
    this.rebuild();
  }

  get partEntries(): IterableIterator<PartEntry> {
    return this.entries.values();
  }

  private rebuild(): void {
    for (const e of this.entries.values()) {
      this.group.remove(e.obj);
      disposeObject(e.obj);
      for (const p of e.plumes) p.dispose();
    }
    this.entries.clear();
    const v = this.vessel;
    for (const p of v.parts) {
      const above = v.topNeighbor(p);
      const below = v.bottomNeighbor(p);
      const parentBottom = p.def.shape === 'engine' && above ? above.stats.diameterBottom : 0;
      const vis = buildPartVisual(p.def, p.stats, p.config, {
        parentBottomDiameter: parentBottom,
        topAttached: !!above,
        bottomAttached: !!below,
      });
      const obj = vis.root;
      obj.position.copy(p.position);
      obj.quaternion.copy(p.rotation);
      const plumes: Plume[] = [];
      let k = 0;
      for (const n of vis.nozzles) {
        const style = p.def.engine ? p.def.engine.plume : 'solid';
        const pl = new Plume(style, n.exitRadius, p.uid * 7 + k++);
        pl.mesh.position.copy(n.exit);
        obj.add(pl.mesh);
        plumes.push(pl);
      }
      this.group.add(obj);
      this.entries.set(p.uid, { part: p, obj, vis, plumes });
    }
    // Interstages: a stack decoupler right below an engine gets a shell covering
    // that engine. The size is remembered on the part so the shell stays with the
    // spent stage after separation (when the engine is no longer its neighbour).
    for (const p of v.parts) {
      if (p.def.shape !== 'decoupler') continue;
      if (!p.interstage) {
        const eng = v.topNeighbor(p);
        if (!eng || eng.def.shape !== 'engine' || eng.attach !== 'above' && p.parent !== eng) continue;
        const mount = v.topNeighbor(eng);
        const h = eng.position.y + eng.height / 2 - (p.position.y + p.height / 2);
        if (h < 0.1) continue;
        const r = Math.max(p.stats.diameterTop, mount ? mount.stats.diameterBottom : 0) / 2;
        p.interstage = { radius: r, height: h };
      }
      const e = this.entries.get(p.uid);
      if (!e) continue;
      const shell = buildInterstage(p.interstage.radius, p.interstage.height);
      shell.position.y = p.height / 2 + p.interstage.height / 2;
      e.obj.add(shell);
    }
    this.builtVersion = v.structureVersion;
  }

  /**
   * @param originRel vessel origin relative to the camera (floating origin)
   * @param q vessel orientation
   * @param pressureRatio ambient pressure / sea-level pressure
   */
  update(originRel: Vector3, q: Quaternion, pressureRatio: number, time: number): void {
    const v = this.vessel;
    if (v.structureVersion !== this.builtVersion) this.rebuild();
    this.group.position.copy(originRel);
    this.group.quaternion.copy(q);
    this.group.visible = !v.destroyed;
    _qInv.copy(q).invert();
    for (const e of this.entries.values()) {
      const p = e.part;
      e.obj.visible = !p.destroyed;
      if (p.isEngine) {
        const thr = p.thrust > 0 ? Math.max(0.05, p.engineThrottle) : 0;
        for (const pl of e.plumes) {
          pl.update(thr, pressureRatio, time);
          // visual gimbal swivel (small angles)
          pl.mesh.rotation.set(p.gimbalZ * 0.9, 0, -p.gimbalX * 0.9);
        }
        for (const g of e.vis.glow) g.emissiveIntensity = thr * 3.5;
        for (const h of e.vis.hotMaterials) h.emissiveIntensity = thr * 0.9;
      }
      const canopy = e.vis.canopy;
      if (canopy) {
        const st = p.chuteState;
        const out = st === 'semi' || st === 'full';
        canopy.visible = out;
        if (out) {
          const s = st === 'semi' ? 0.08 + 0.1 * p.chuteDeploy : 0.15 + 0.85 * p.chuteDeploy;
          canopy.scale.set(s, 0.35 + 0.65 * Math.min(1, p.chuteDeploy * 1.5), s);
          // Trail behind the airflow: canopy +Y along −(air velocity), in part space
          const spd = v.surfaceVelocity.length();
          if (spd > 0.5) {
            _v.copy(v.surfaceVelocity).multiplyScalar(-1 / spd).applyQuaternion(_qInv);
            _q.copy(p.rotation).invert();
            _v.applyQuaternion(_q);
            canopy.quaternion.setFromUnitVectors(Y, _v);
          }
        }
      }
      for (const leg of e.vis.legs) poseLeg(leg, p.legDeploy);
      for (const w of e.vis.solar) {
        w.scale.x = 0.08 + 0.92 * p.solarDeploy;
        w.visible = true;
      }
      if (e.vis.fairingShell) e.vis.fairingShell.visible = p.fairingAttached;
    }
  }

  /** World-space (camera-relative) positions of all running nozzle exits. */
  /** Visit every firing nozzle (camera-relative position, exhaust direction). Vectors are reused. */
  forEachNozzle(cb: (pos: Vector3, dir: Vector3, radius: number, part: FlightPart, plumeLength: number) => void): void {
    for (const e of this.entries.values()) {
      if (!e.part.isEngine || e.part.thrust <= 0 || e.part.destroyed) continue;
      let i = 0;
      for (const n of e.vis.nozzles) {
        const pl = e.plumes[i++];
        _v.copy(n.exit);
        e.obj.localToWorld(_v);
        _nDir.set(0, -1, 0).applyQuaternion(e.obj.getWorldQuaternion(_q));
        // Callers must copy these vectors if they keep them
        cb(_v, _nDir, n.exitRadius, e.part, pl ? pl.length : 0);
      }
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      disposeObject(e.obj);
      for (const p of e.plumes) p.dispose();
    }
    this.entries.clear();
  }
}
