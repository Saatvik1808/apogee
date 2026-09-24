/**
 * LEARNING NOTE: Persisting a living spacecraft
 *
 * A save game must capture a vessel well enough to rebuild it later: WHAT it is
 * (the part tree, as design data), WHERE it is (position and velocity relative
 * to its planet at a known universal time) and HOW it is (fuel left in each tank,
 * an open parachute, deployed legs, a spent engine, a docked module). We store
 * the orbit as a state vector rather than orbital elements: a state vector is
 * exact for any conic, and when the vessel is loaded again — maybe months of
 * game time later — Kepler's equation carries it forward along the same orbit.
 *
 * Part state is keyed by part uid so it survives the part tree being laid out
 * again from the design data.
 *
 * Key concepts: serialisation of simulation state, state vectors vs elements,
 * stable identifiers
 */
import type { BodyId, CelestialBody } from '../physics/CelestialBody';
import type { CraftData } from '../parts/Craft';
import type { ChuteState } from './FlightPart';
import { Vessel, type Situation } from './Vessel';

export interface PartState {
  fuel: number;
  ablator: number;
  chute: ChuteState;
  chuteDeploy: number;
  legs: boolean;
  legDeploy: number;
  solar: number;
  ignited: boolean;
  ignitions: number;
  flameout: boolean;
  fairing: boolean;
  /** Partner docking port uid (−1: none) and the docked subtree's root uid. */
  dockedTo: number;
  dockRoot: number;
  vesselName: string | null;
}

export interface VesselSnapshot {
  /** Stable id across saves. */
  pid: string;
  name: string;
  body: BodyId;
  /** Universal time (s) the state vector refers to. */
  t: number;
  r: [number, number, number];
  v: [number, number, number];
  q: [number, number, number, number];
  craft: CraftData;
  /** Runtime state per part uid. */
  state: Record<string, PartState>;
  situation: Situation;
  /** Body-fixed pose while resting on a surface (landed vessels). */
  pinned: { pos: [number, number, number]; rot: [number, number, number, number] } | null;
  /** Campaign mission that created the vessel, if any. */
  mission: string | null;
  crew: number;
}

export function snapshotVessel(v: Vessel, t: number, pid: string, mission: string | null): VesselSnapshot {
  const state: Record<string, PartState> = {};
  for (const p of v.parts) {
    state[String(p.uid)] = {
      fuel: p.fuel,
      ablator: p.ablator,
      chute: p.chuteState,
      chuteDeploy: p.chuteDeploy,
      legs: p.legsDeployed,
      legDeploy: p.legDeploy,
      solar: p.solarDeploy,
      ignited: p.engineIgnited,
      ignitions: p.ignitionsLeft,
      flameout: p.flameout,
      fairing: p.fairingAttached,
      dockedTo: p.dockedTo ? p.dockedTo.uid : -1,
      dockRoot: p.dockRoot ? p.dockRoot.uid : -1,
      vesselName: p.vesselName,
    };
  }
  return {
    pid,
    name: v.name,
    body: v.body.id,
    t,
    r: [v.r.x, v.r.y, v.r.z],
    v: [v.v.x, v.v.y, v.v.z],
    q: [v.q.x, v.q.y, v.q.z, v.q.w],
    craft: v.toCraft(),
    state,
    situation: v.situation,
    pinned: v.pinned ? { pos: [v.pinnedPos.x, v.pinnedPos.y, v.pinnedPos.z], rot: [v.pinnedRot.x, v.pinnedRot.y, v.pinnedRot.z, v.pinnedRot.w] } : null,
    mission,
    crew: v.crew,
  };
}

/** Rebuild a vessel from a snapshot (its state vector is NOT propagated: the caller sets the time). */
export function vesselFromSnapshot(s: VesselSnapshot, body: CelestialBody): Vessel {
  const v = Vessel.fromCraft(s.craft, body);
  v.name = s.name;
  v.pid = s.pid;
  v.missionTag = s.mission;
  for (const p of v.parts) {
    const st = s.state[String(p.uid)];
    if (!st) continue;
    p.fuel = Math.max(0, Math.min(p.fuelCapacity, st.fuel));
    p.ablator = Math.max(0, Math.min(p.stats.ablator, st.ablator));
    p.chuteState = st.chute;
    p.chuteDeploy = st.chuteDeploy;
    p.legsDeployed = st.legs;
    p.legDeploy = st.legDeploy;
    p.solarDeploy = st.solar;
    p.engineIgnited = st.ignited;
    p.ignitionsLeft = st.ignitions;
    p.flameout = st.flameout;
    p.fairingAttached = st.fairing && !!p.def.fairing;
    p.vesselName = st.vesselName;
  }
  for (const p of v.parts) {
    const st = s.state[String(p.uid)];
    if (!st || st.dockedTo < 0) continue;
    p.dockedTo = v.partByUid(st.dockedTo) ?? null;
    p.dockRoot = v.partByUid(st.dockRoot) ?? null;
  }
  v.refreshStructure();
  v.computeMassProperties(false);
  v.r.set(s.r[0], s.r[1], s.r[2]);
  v.v.set(s.v[0], s.v[1], s.v[2]);
  v.q.set(s.q[0], s.q[1], s.q[2], s.q[3]).normalize();
  v.w.set(0, 0, 0);
  v.situation = s.situation;
  v.clamped = false;
  v.airborneTime = 1e6;
  if (s.pinned) {
    v.pinnedPos.set(s.pinned.pos[0], s.pinned.pos[1], s.pinned.pos[2]);
    v.pinnedRot.set(s.pinned.rot[0], s.pinned.rot[1], s.pinned.rot[2], s.pinned.rot[3]);
    v.pinned = true;
  }
  return v;
}
