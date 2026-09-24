/**
 * LEARNING NOTE: Testing orbital operations end to end
 *
 * Rendezvous and docking are the hardest things a pilot does in orbit, and the
 * code behind them spans the planner (Lambert transfers), the maneuver
 * autopilot, the closest-approach search, the contact/docking rules and the
 * part-tree merge. These tests fly the whole chain: two vessels in different
 * orbits, an intercept burn, a velocity match at closest approach, a final RCS
 * approach and a hard dock — then undock, and persist/restore the result.
 *
 * Key concepts: integration testing, rendezvous (phasing, intercept, matching),
 * docking rules, save/load round trips
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';
import { FlightSim } from '../src/sim/FlightSim';
import { Vessel } from '../src/sim/Vessel';
import { CraftBuilder, applyAutoStagingSafe } from '../src/parts/CraftBuilder';
import { getLaunchSite } from '../src/world/LaunchSites';
import { planIntercept, planMatchVelocity } from '../src/sim/Planner';
import { snapshotVessel, vesselFromSnapshot } from '../src/sim/Snapshot';
import { Orbit } from '../src/physics/Orbit';

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const log = (s: string) => {
  if (env?.env.APOGEE_REPORT) env.stderr.write(s + '\n');
};

/** Kestrel capsule with a nose docking port, RCS quads and a small service module. */
function chaserCraft(name: string) {
  const b = new CraftBuilder(name, 'Rendezvous capsule');
  const cap = b.root('capsule-kestrel');
  b.above(cap, 'docking-port', { diameter: 1.25 });
  b.radial(cap, 'rcs-quad', 4, -0.4, Math.PI / 4);
  const hs = b.below(cap, 'heatshield', { diameter: 2.5 });
  const sm = b.below(hs, 'tank-250', { length: 0.75, propellant: 'hypergolic' });
  b.below(sm, 'eng-kestrel-sps', { cluster: 1 });
  return applyAutoStagingSafe(b.craft);
}

/** A small station module: probe core, docking port on top, solar wings. */
function stationCraft(name: string) {
  const b = new CraftBuilder(name, 'Station core');
  const core = b.root('probe-sentinel');
  b.above(core, 'docking-port', { diameter: 1.25 });
  const tank = b.below(core, 'tank-250', { length: 1.5, propellant: 'monoprop' });
  b.radial(tank, 'solar-panel', 2, 0, 0);
  return applyAutoStagingSafe(b.craft);
}

function makeSim() {
  const t0 = utFromDate(new Date(Date.UTC(2026, 8, 24, 14, 0, 0)));
  const sys = new SolarSystem(t0);
  const sim = new FlightSim(sys, chaserCraft('Chaser'), getLaunchSite('cape'), t0);
  sim.launchTime = t0;
  return { sim, sys, t0 };
}

function run(sim: FlightSim, seconds: number, stop?: () => boolean): void {
  for (let i = 0; i < seconds * 60; i++) {
    sim.update(1 / 60);
    if (stop && stop()) return;
  }
}

/** Execute the current node with the autopilot, warping to it first. */
function executeNode(sim: FlightSim, maxSeconds = 4 * 3600): void {
  const n = sim.nodes[0]!;
  // Warp (on rails) until shortly before the burn
  for (let i = 0; i < 200000; i++) {
    if (sim.nodes.length === 0 || n.time - sim.time < 400) break;
    if (!sim.warp.rails) sim.setWarpIndex(7);
    sim.update(1 / 60);
  }
  sim.stopWarp();
  sim.autopilot.engage('node', sim);
  const tEnd = sim.time + maxSeconds;
  run(sim, maxSeconds, () => sim.autopilot.mode === 'off' || sim.time > tEnd);
}

describe('Orbital operations', () => {
  it('places a vessel in a circular orbit that stays circular', () => {
    const { sim, sys } = makeSim();
    const v = sim.active;
    sim.placeInOrbit(v, sys.earth, 300_000, 28.6);
    run(sim, 5);
    const o = new Orbit().setFromState(v.r, v.v, sys.earth.mu, sim.time);
    expect(v.situation).toBe('orbiting');
    expect(Math.abs(o.apoapsis - o.periapsis)).toBeLessThan(2_000);
    expect((o.inc * 180) / Math.PI).toBeCloseTo(28.6, 0);
    expect(v.altitude).toBeGreaterThan(295_000);
  });

  it('docks two vessels that meet slowly, then undocks them', () => {
    const { sim, sys } = makeSim();
    const chaser = sim.active;
    sim.placeInOrbit(chaser, sys.earth, 400_000, 0);
    const station = Vessel.fromCraft(stationCraft('Keystone'), sys.earth);
    // Same orbit, the station's port facing the chaser's nose 0.8 m away, closing at 0.3 m/s
    station.r.copy(chaser.r);
    station.v.copy(chaser.v);
    station.q.copy(chaser.q);
    const fwd = chaser.forward(new Vector3());
    const chaserPorts = chaser.freeDockPorts();
    expect(chaserPorts.length).toBe(1);
    const pos = new Vector3();
    const dir = new Vector3();
    chaser.dockFacePose(chaserPorts[0]!.part, chaserPorts[0]!.face, pos, dir);
    // Station nose (its port) points back at us: flip it 180° about the dorsal axis
    const flip = station.q.clone();
    const dorsal = new Vector3(0, 0, 1).applyQuaternion(chaser.q);
    flip.premultiply(new (station.q.constructor as new () => typeof station.q)().setFromAxisAngle(dorsal, Math.PI));
    station.q.copy(flip);
    const sPorts = station.freeDockPorts();
    expect(sPorts.length).toBe(1);
    const sPos = new Vector3();
    station.dockFacePose(sPorts[0]!.part, sPorts[0]!.face, sPos, dir);
    // Move the station so its port face is 0.8 m in front of ours
    const want = pos.clone().addScaledVector(fwd, 0.8);
    station.r.add(want.sub(sPos));
    station.v.addScaledVector(fwd, -0.3);
    station.situation = 'orbiting';
    station.airborneTime = 1e6;
    sim.addVessel(station);
    const partsBefore = chaser.parts.length + station.parts.length;
    const events: string[] = [];
    run(sim, 12, () => {
      for (const e of sim.events) events.push(e.kind);
      sim.events.length = 0;
      return events.includes('docked');
    });
    log(`dock events: ${events.join(',')}`);
    expect(events).toContain('docked');
    expect(sim.active.parts.length).toBe(partsBefore);
    expect(sim.vessels.filter((x) => !x.destroyed).length).toBe(1);
    expect(sim.dockedPorts().length).toBe(1);
    // Snapshot round trip keeps the merged vehicle and its docking link
    const snap = snapshotVessel(sim.active, sim.time, 'test', null);
    const back = vesselFromSnapshot(snap, sys.earth);
    expect(back.parts.length).toBe(partsBefore);
    expect(Math.abs(back.mass - sim.active.mass)).toBeLessThan(1);
    expect(back.parts.filter((p) => p.dockedTo).length).toBe(2);
    // Undock
    const ok = sim.undock(sim.dockedPorts()[0]!);
    expect(ok).toBe(true);
    run(sim, 3);
    const live = sim.vessels.filter((x) => !x.destroyed);
    expect(live.length).toBe(2);
    const other = live.find((x) => x !== sim.active)!;
    expect(other.name).toBe('Keystone');
    expect(other.parts.length).toBe(5);
    const dist = other.absolutePosition(new Vector3()).distanceTo(sim.active.absolutePosition(new Vector3()));
    expect(dist).toBeGreaterThan(0.5);
  }, 60_000);

  it('docks from 25 m using only port alignment and the docking readout (the phone controls)', () => {
    const { sim, sys } = makeSim();
    const chaser = sim.active;
    sim.placeInOrbit(chaser, sys.earth, 400_000, 0);
    const station = Vessel.fromCraft(stationCraft('Keystone'), sys.earth);
    station.r.copy(chaser.r);
    station.v.copy(chaser.v);
    // Station faces us (flipped about our dorsal axis) and is tilted 10° off our line of sight
    const Q = station.q.constructor as new () => typeof station.q;
    const dorsal = new Vector3(0, 0, 1).applyQuaternion(chaser.q);
    const right = new Vector3(1, 0, 0).applyQuaternion(chaser.q);
    station.q.copy(chaser.q).premultiply(new Q().setFromAxisAngle(dorsal, Math.PI)).premultiply(new Q().setFromAxisAngle(right, (10 * Math.PI) / 180));
    const [cp] = chaser.freeDockPorts();
    const [sp] = station.freeDockPorts();
    const pos = new Vector3();
    const dir = new Vector3();
    const sPos = new Vector3();
    chaser.dockFacePose(cp!.part, cp!.face, pos, dir);
    station.dockFacePose(sp!.part, sp!.face, sPos, new Vector3());
    // Station port 25 m ahead, 1.5 m to our right and 0.8 m "up"
    const want = pos.clone().addScaledVector(dir, 25).addScaledVector(right, 1.5).addScaledVector(dorsal, 0.8);
    station.r.add(want.sub(sPos));
    station.situation = 'orbiting';
    station.airborneTime = 1e6;
    sim.addVessel(station);
    sim.target = station;
    run(sim, 0.2);
    const d = sim.dock;
    expect(d.valid).toBe(true);
    // The readout must say "ahead, to the right, up" — the scope's sign convention
    expect(d.offset.z).toBeGreaterThan(20);
    expect(d.offset.x).toBeGreaterThan(1);
    expect(d.offset.y).toBeGreaterThan(0.4);
    // Phone controls: ALIGN (SAS port mode) + RCS, translation from the readout only
    const c = chaser.controls;
    c.sas = true;
    c.sasMode = 'port';
    c.rcs = true;
    const clampU = (x: number) => Math.max(-1, Math.min(1, x));
    let docked = false;
    let steps = 0;
    for (; steps < 400 * 60 && !docked; steps++) {
      if (d.valid) {
        // Pilot frame (right, up, forward). Aim to null the lateral offset first, then close slowly.
        const k = 0.15;
        const lateralOk = d.lateral < 0.25 || d.distance > 6;
        const wantClosing = lateralOk && d.angle < (8 * Math.PI) / 180 ? Math.min(0.35, 0.06 * d.offset.z + 0.05) : 0;
        const px = clampU(4 * (d.relVel.x + k * d.offset.x));
        const pu = clampU(4 * (d.relVel.y + k * d.offset.y));
        const pf = clampU(4 * (d.relVel.z + wantClosing));
        // Nose port: pilot frame = vessel frame (x right, y forward, z up)
        c.tx = px;
        c.ty = pf;
        c.tz = pu;
      }
      sim.update(1 / 60);
      for (const e of sim.events) if (e.kind === 'docked') docked = true;
      sim.events.length = 0;
    }
    log(`port-align docking: docked=${docked} after ${(steps / 60).toFixed(0)} s, rcs left ${chaser.parts.filter((p) => p.def.rcs).reduce((a, p) => a + p.fuel, 0).toFixed(1)} kg`);
    expect(docked).toBe(true);
    expect(sim.vessels.filter((x) => !x.destroyed).length).toBe(1);
  }, 120_000);

  it('plans an intercept and a velocity match to reach a station', () => {
    const { sim, sys } = makeSim();
    const chaser = sim.active;
    sim.placeInOrbit(chaser, sys.earth, 300_000, 28.6, 0, 0);
    const station = Vessel.fromCraft(stationCraft('Keystone'), sys.earth);
    sim.addVessel(station);
    sim.placeInOrbit(station, sys.earth, 420_000, 28.6, 0, 40);
    sim.target = station;
    run(sim, 2);
    const r1 = planIntercept(sim);
    log(`intercept: ${r1.message}`);
    expect(r1.ok).toBe(true);
    executeNode(sim);
    run(sim, 2);
    // Coast to closest approach on rails
    const info0 = sim.targetInfo!;
    log(`after intercept: CA ${(info0.caDistance / 1000).toFixed(1)} km in ${((info0.caTime - sim.time) / 60).toFixed(1)} min`);
    expect(info0.caDistance).toBeLessThan(15_000);
    const r2 = planMatchVelocity(sim);
    log(`match: ${r2.message}`);
    expect(r2.ok).toBe(true);
    executeNode(sim);
    run(sim, 2);
    const info = sim.targetInfo!;
    log(`after match: range ${(info.distance / 1000).toFixed(2)} km rel ${info.relSpeed.toFixed(2)} m/s`);
    expect(info.distance).toBeLessThan(20_000);
    expect(info.relSpeed).toBeLessThan(8);
    expect(chaser.destroyed).toBe(false);
  }, 120_000);
});
