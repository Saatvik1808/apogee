/**
 * LEARNING NOTE: Predicting the future — patched conic trajectories
 *
 * To draw where a spacecraft will go, we chain Kepler conics ("patches"):
 *   1. Start with the orbit around the current body.
 *   2. Find the FIRST event on it: hitting the surface, leaving this body's sphere
 *      of influence (SOI), or entering a moon's SOI.
 *   3. At an SOI change, convert the state vector into the new body's frame
 *      (add/subtract that body's own position & velocity) and start a new conic.
 *
 * Leaving an SOI is analytic (solve r(ν) = R_SOI). Entering a MOVING moon's SOI is
 * not — we sample the distance between craft and moon over time and refine the
 * crossing with bisection, also checking local minima so fast, grazing
 * encounters between samples are not missed.
 *
 * Key concepts: sphere of influence transitions, frame changes (Galilean), root
 * finding (bisection, golden-section search), closest approach
 */
import { Vector3 } from 'three';
import type { CelestialBody } from './CelestialBody';
import { Orbit } from './Orbit';

export type PatchEnd = 'soi-exit' | 'soi-enter' | 'impact' | 'none';

export interface TrajectoryPatch {
  body: CelestialBody;
  orbit: Orbit;
  startTime: number;
  endTime: number;
  endReason: PatchEnd;
  nextBody: CelestialBody | null;
  /** Time the trajectory dips into the atmosphere during this patch (NaN if none). */
  atmosphereEntry: number;
  /** Closest approach to the tracked target inside this patch (if target is a child). */
  closestApproachTime: number;
  closestApproachDistance: number;
}

export function createPatch(): TrajectoryPatch {
  return {
    body: null as unknown as CelestialBody,
    orbit: new Orbit(),
    startTime: 0,
    endTime: Infinity,
    endReason: 'none',
    nextBody: null,
    atmosphereEntry: NaN,
    closestApproachTime: NaN,
    closestApproachDistance: Infinity,
  };
}

const MAX_HORIZON = 2 * 365.25 * 86400;
const _r = new Vector3();
const _v = new Vector3();
const _rc = new Vector3();
const _vc = new Vector3();

export interface PredictOptions {
  maxPatches: number;
  /** Body to report closest approach for (e.g. the Moon). */
  target: CelestialBody | null;
}

export class TrajectoryPredictor {
  /** Incremented by every prediction, so consumers (the map's orbit lines) can tell when to rebuild. */
  version = 0;
  /** Reusable patch storage to avoid per-frame allocations. */
  readonly patches: TrajectoryPatch[] = [];
  count = 0;

  constructor(maxPatches = 5) {
    for (let i = 0; i < maxPatches; i++) this.patches.push(createPatch());
  }

  /**
   * Predict from state (r, v) relative to `body` at time t0.
   * Returns the number of valid patches in `this.patches`.
   */
  predict(body: CelestialBody, r: Vector3, v: Vector3, t0: number, opts: PredictOptions): number {
    let curBody = body;
    _r.copy(r);
    _v.copy(v);
    let t = t0;
    const maxP = Math.min(opts.maxPatches, this.patches.length);
    this.count = 0;
    this.version++;
    for (let i = 0; i < maxP; i++) {
      const patch = this.patches[i]!;
      patch.body = curBody;
      patch.orbit.setFromState(_r, _v, curBody.mu, t);
      this.computePatch(patch, t, opts.target);
      this.count++;
      if (patch.endReason === 'none' || patch.endReason === 'impact') break;
      // Transition to next body
      const tEnd = patch.endTime;
      patch.orbit.getStateAt(tEnd, _r, _v);
      if (patch.endReason === 'soi-exit') {
        const parent = curBody.parent!;
        curBody.relativeStateAt(tEnd, _rc, _vc);
        _r.add(_rc);
        _v.add(_vc);
        curBody = parent;
      } else if (patch.endReason === 'soi-enter' && patch.nextBody) {
        const child = patch.nextBody;
        child.relativeStateAt(tEnd, _rc, _vc);
        _r.sub(_rc);
        _v.sub(_vc);
        curBody = child;
      }
      t = tEnd;
    }
    return this.count;
  }

  /** Fill event information for a patch whose orbit & body are set. */
  computePatch(patch: TrajectoryPatch, tStart: number, target: CelestialBody | null): void {
    const body = patch.body;
    const o = patch.orbit;
    patch.startTime = tStart;
    patch.endTime = Infinity;
    patch.endReason = 'none';
    patch.nextBody = null;
    patch.atmosphereEntry = NaN;
    patch.closestApproachTime = NaN;
    patch.closestApproachDistance = Infinity;

    // Surface impact (sea-level sphere; terrain handled by live physics)
    const r0 = o.r0.length();
    if (o.periapsis < body.radius || o.degenerate) {
      if (r0 > body.radius) {
        const tImp = o.nextInboundCrossing(body.radius, tStart);
        if (isFinite(tImp)) {
          patch.endTime = tImp;
          patch.endReason = 'impact';
        }
      } else {
        patch.endTime = tStart;
        patch.endReason = 'impact';
      }
    }

    // SOI exit
    if (body.parent && isFinite(body.soiRadius) && (!o.isElliptic || o.apoapsis > body.soiRadius)) {
      const tExit = o.nextOutboundCrossing(body.soiRadius, tStart);
      if (isFinite(tExit) && tExit < patch.endTime) {
        patch.endTime = tExit;
        patch.endReason = 'soi-exit';
      }
    }

    // Atmosphere entry marker
    if (body.atmosphere) {
      const top = body.radius + body.atmosphere.ceiling;
      if (o.periapsis < top && r0 > top) {
        const tAtm = o.nextInboundCrossing(top, tStart);
        if (isFinite(tAtm) && tAtm <= patch.endTime) patch.atmosphereEntry = tAtm;
      }
    }

    // Child encounters within the horizon
    const horizonEnd = Math.min(
      patch.endTime,
      tStart + (o.isElliptic ? o.period : MAX_HORIZON),
    );
    for (const child of body.children) {
      const res = this.findEncounter(o, child, tStart, horizonEnd, child === target);
      if (child === target) {
        patch.closestApproachTime = res.closestTime;
        patch.closestApproachDistance = res.closestDistance;
      }
      if (res.entryTime < patch.endTime) {
        patch.endTime = res.entryTime;
        patch.endReason = 'soi-enter';
        patch.nextBody = child;
      }
    }
    if (patch.endReason === 'none' && o.isElliptic) {
      patch.endTime = tStart + o.period;
    } else if (patch.endReason === 'none') {
      patch.endTime = tStart + MAX_HORIZON;
    }
  }

  private dist(o: Orbit, child: CelestialBody, t: number): number {
    o.getStateAt(t, _rc);
    child.orbit!.getStateAt(t, _vc);
    return _rc.distanceTo(_vc);
  }

  private findEncounter(
    o: Orbit,
    child: CelestialBody,
    t0: number,
    t1: number,
    trackClosest: boolean,
  ): { entryTime: number; closestTime: number; closestDistance: number } {
    const result = { entryTime: Infinity, closestTime: NaN, closestDistance: Infinity };
    if (!child.orbit || !(t1 > t0)) return result;
    const soi = child.soiRadius;
    // Quick reject: vessel orbit never reaches the child's orbital band
    const cOrb = child.orbit;
    const childMin = cOrb.periapsis - soi;
    const childMax = cOrb.apoapsis + soi;
    const vesselMax = o.isElliptic ? o.apoapsis : Infinity;
    if (vesselMax < childMin && !trackClosest) return result;
    if (o.periapsis > childMax && !trackClosest) return result;

    // Step size from relative speed so we never jump across the SOI
    o.getStateAt(t0, _rc, _vc);
    const vVessel = _vc.length();
    const vChild = Math.sqrt(child.parent!.mu / Math.max(cOrb.periapsis, 1));
    const relSpeed = vVessel + vChild;
    let step = soi / (4 * relSpeed);
    const maxSteps = 3000;
    if ((t1 - t0) / step > maxSteps) step = (t1 - t0) / maxSteps;
    step = Math.max(step, 1);

    let tPrevPrev = t0;
    let dPrevPrev = this.dist(o, child, t0);
    if (dPrevPrev < soi) {
      // Already inside (shouldn't happen for a properly re-based orbit)
      result.closestTime = t0;
      result.closestDistance = dPrevPrev;
      return result;
    }
    let tPrev = Math.min(t0 + step, t1);
    let dPrev = this.dist(o, child, tPrev);
    if (dPrev < dPrevPrev) {
      result.closestDistance = dPrev;
      result.closestTime = tPrev;
    } else {
      result.closestDistance = dPrevPrev;
      result.closestTime = t0;
    }
    if (dPrev < soi) {
      result.entryTime = this.bisectEntry(o, child, t0, tPrev, soi);
      return result;
    }
    let t = tPrev;
    while (t < t1) {
      t = Math.min(t + step, t1);
      const d = this.dist(o, child, t);
      if (d < result.closestDistance) {
        result.closestDistance = d;
        result.closestTime = t;
      }
      if (d < soi) {
        result.entryTime = this.bisectEntry(o, child, tPrev, t, soi);
        return result;
      }
      // Local minimum between samples? Refine with golden-section search.
      if (dPrev < dPrevPrev && dPrev <= d) {
        const tm = this.goldenMin(o, child, tPrevPrev, t);
        const dm = this.dist(o, child, tm);
        if (dm < result.closestDistance) {
          result.closestDistance = dm;
          result.closestTime = tm;
        }
        if (dm < soi) {
          result.entryTime = this.bisectEntry(o, child, tPrevPrev, tm, soi);
          return result;
        }
      }
      tPrevPrev = tPrev;
      dPrevPrev = dPrev;
      tPrev = t;
      dPrev = d;
    }
    return result;
  }

  private bisectEntry(o: Orbit, child: CelestialBody, lo: number, hi: number, soi: number): number {
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.dist(o, child, mid) < soi) hi = mid;
      else lo = mid;
      if (hi - lo < 1e-3) break;
    }
    return hi;
  }

  private goldenMin(o: Orbit, child: CelestialBody, a: number, b: number): number {
    const g = 0.6180339887498949;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    let fc = this.dist(o, child, c);
    let fd = this.dist(o, child, d);
    for (let i = 0; i < 50 && b - a > 0.5; i++) {
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - g * (b - a);
        fc = this.dist(o, child, c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + g * (b - a);
        fd = this.dist(o, child, d);
      }
    }
    return 0.5 * (a + b);
  }
}
