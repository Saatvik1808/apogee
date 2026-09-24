/**
 * LEARNING NOTE: Maneuver nodes — planning burns in the orbital frame
 *
 * A maneuver node is a planned, instantaneous velocity change at a future time,
 * expressed in the ORBITAL frame at that point:
 *   prograde  – along velocity (raises the opposite side of the orbit)
 *   normal    – along the orbit normal r×v (tilts the orbital plane)
 *   radial    – perpendicular, pointing away from the body (rotates the orbit)
 *
 * Real engines need minutes, not an instant, so we centre the burn on the node:
 * start at t_node − t_burn/2. Burn time comes from the rocket equation:
 *   t = m0·(1 − e^(−Δv/ve)) / ṁ ,  ve = Isp·g0.
 * While burning we track the REMAINING Δv as the difference between the planned
 * post-burn velocity and the current orbit's velocity at the node time.
 *
 * Key concepts: orbital frame (prograde/normal/radial), impulsive approximation,
 * finite burn time, remaining Δv
 */
import { Vector3 } from 'three';
import { G0 } from '../core/constants';
import type { CelestialBody } from '../physics/CelestialBody';
import { Orbit, orbitalFrame } from '../physics/Orbit';
import type { Vessel } from './Vessel';

export interface ManeuverNode {
  id: number;
  time: number;
  prograde: number;
  normal: number;
  radial: number;
  /** Body the node's orbit is around (set when placed). */
  body: CelestialBody;
  /** Planned post-burn velocity at node time (inertial, relative to body). */
  readonly targetVelocity: Vector3;
  /** Remaining Δv vector (inertial) — updated every frame. */
  readonly remaining: Vector3;
  /** True once the burn has started (throttle applied near the node). */
  burning: boolean;
  /** Simulation time the engines were last seen running for this burn (NaN: never). */
  lastThrust: number;
  /** Specific orbital energy of the planned post-burn orbit (J/kg). */
  targetEnergy: number;
  /**
   * How a long burn is steered and cut off:
   *  match       – reach the planned velocity at the node point (short/general burns)
   *  energy      – along the flight path until the orbit's energy is right (injections)
   *  circularize – steer to the local circular velocity (zero radial speed)
   */
  guidance: NodeGuidance;
}

export type NodeGuidance = 'match' | 'energy' | 'circularize';

let nextNodeId = 1;

const _r = new Vector3();
const _v = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _rad = new Vector3();

const _d = new Vector3();
const _n2 = new Vector3();

export function createNode(time: number, body: CelestialBody): ManeuverNode {
  return {
    id: nextNodeId++,
    time,
    prograde: 0,
    normal: 0,
    radial: 0,
    body,
    targetVelocity: new Vector3(),
    remaining: new Vector3(),
    burning: false,
    lastThrust: NaN,
    targetEnergy: 0,
    guidance: 'match',
  };
}

/** Δv components → inertial vector using the orbit's frame at the node time. */
export function nodeDeltaV(node: ManeuverNode, orbit: Orbit, out: Vector3): Vector3 {
  orbit.getStateAt(node.time, _r, _v);
  orbitalFrame(_r, _v, _p, _n, _rad);
  return out
    .copy(_p)
    .multiplyScalar(node.prograde)
    .addScaledVector(_n, node.normal)
    .addScaledVector(_rad, node.radial);
}

/** Recompute the node's target velocity from components and the (pre-burn) orbit. */
export function refreshNodeTarget(node: ManeuverNode, orbit: Orbit): void {
  orbit.getStateAt(node.time, _r, _v);
  nodeDeltaV(node, orbit, node.targetVelocity);
  node.targetVelocity.add(_v);
  node.targetEnergy = node.targetVelocity.lengthSq() / 2 - orbit.mu / _r.length();
}

/**
 * Remaining Δv ("velocity to be gained"). Before the burn — or for 'match'
 * guidance — it is the planned velocity minus the current orbit's velocity at the
 * node time. Long burns span a big arc of the orbit, though, so while burning:
 *  • energy: along the current velocity, sized by the orbital energy still
 *    missing (dε = v·dv) — fixes the orbit's size exactly (transfer injections);
 *  • circularize: towards the circular velocity at the CURRENT position
 *    (horizontal, √(μ/r)) — kills radial speed however long the burn lasts.
 */
export function updateNodeRemaining(node: ManeuverNode, orbit: Orbit, r?: Vector3, v?: Vector3): Vector3 {
  if (node.guidance === 'energy' && r && v) {
    // Energy guidance (before and during the burn): along the CURRENT velocity,
    // tilted out of the orbit plane by the node's normal/prograde ratio, sized by
    // the orbital energy still missing. The planner simulates exactly this law.
    const speed = v.length();
    const eps = (speed * speed) / 2 - orbit.mu / r.length();
    const d = (node.targetEnergy - eps) / Math.max(speed, 1);
    if (node.burning && Math.sign(node.prograde) * d <= 0) return node.remaining.set(0, 0, 0);
    energyDirection(r, v, node.prograde !== 0 ? node.normal / node.prograde : 0, _d);
    return node.remaining.copy(_d).multiplyScalar(d);
  }
  if (node.burning && r && v && node.guidance !== 'match') {
    const rl = r.length();
    _r.copy(r).multiplyScalar(1 / rl);
    _v.copy(v).addScaledVector(_r, -v.dot(_r));
    const hl = _v.length();
    if (hl < 1e-3) return node.remaining.set(0, 0, 0);
    _v.multiplyScalar(Math.sqrt(orbit.mu / rl) / hl);
    return node.remaining.copy(_v).sub(v);
  }
  orbit.getStateAt(node.time, _r, _v);
  return node.remaining.copy(node.targetVelocity).sub(_v);
}

/** Unit thrust direction of an energy-guided burn: prograde + tilt · orbit normal. */
export function energyDirection(r: Vector3, v: Vector3, tilt: number, out: Vector3): Vector3 {
  _n2.crossVectors(r, v);
  const nl = _n2.length();
  out.copy(v).normalize();
  if (nl > 1e-9 && tilt !== 0) out.addScaledVector(_n2, tilt / nl).normalize();
  return out;
}

/**
 * Thrust (N) and mass flow (kg/s) of the engines a node burn would use: the
 * ignited engines that still have propellant — or, when none of those can burn,
 * the engines of the next stage (which staging would light). Dry engines must
 * not count: a spent booster still attached would otherwise make the burn look
 * several times shorter than it is, and the burn would start late.
 */
export function burnEngines(v: Vessel): { thrust: number; mdot: number } {
  let thrust = 0;
  let mdot = 0;
  for (const p of v.parts) {
    if (!p.isEngine || !p.engineIgnited) continue;
    if (p.flameout && !p.engineRunning && p.ignitionsLeft <= 0) continue;
    if (v.engineFuel(p) <= 0) continue;
    thrust += p.stats.thrustVac;
    mdot += p.stats.thrustVac / (p.stats.ispVac * G0);
  }
  if (thrust <= 0) {
    const next = v.stages[v.nextStage];
    if (next) {
      for (const uid of next) {
        const p = v.partByUid(uid);
        if (!p || !p.isEngine || v.engineFuel(p) <= 0) continue;
        thrust += p.stats.thrustVac;
        mdot += p.stats.thrustVac / (p.stats.ispVac * G0);
      }
    }
  }
  return { thrust, mdot };
}

/** Post-burn state at the node (for trajectory prediction). */
export function nodeStateAfter(node: ManeuverNode, orbit: Orbit, outR: Vector3, outV: Vector3): void {
  orbit.getStateAt(node.time, outR, outV);
  outV.copy(node.targetVelocity);
}

/** Estimated burn duration for Δv with the vessel's currently available engines. */
/**
 * How long before the node a burn must start so that half its Δv is delivered
 * before the node (the right centring for long burns), plus a safety margin.
 */
export function burnLeadTime(v: Vessel, dv: number, margin = 45): number {
  const lead = estimateBurnTime(v, dv / 2);
  return (isFinite(lead) ? lead : 0) + margin;
}

export function estimateBurnTime(v: Vessel, dv: number): number {
  const { thrust, mdot } = burnEngines(v);
  if (thrust <= 0 || mdot <= 0) return NaN;
  const ve = thrust / mdot;
  const m0 = v.mass;
  const m1 = m0 * Math.exp(-dv / ve);
  return (m0 - m1) / mdot;
}
