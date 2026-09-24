/**
 * LEARNING NOTE: Testing the sandbox tools
 *
 * Sandbox features are easy to get subtly wrong because they touch every layer:
 * a crossfeed decoupler changes both the flight's fuel flow AND the editor's Δv
 * prediction, a placement tweak changes the layout that physics, rendering and
 * picking all share, a control fin must steer the right way even flying
 * backwards. These tests check each tool against the physics it claims to model
 * (asparagus staging beats plain staging, a finned rocket's centre of pressure
 * sits behind its centre of mass, airbrakes add drag) and that shared designs
 * survive the round trip through a text code.
 *
 * Key concepts: property-style tests, A/B comparisons, round-trip tests
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';
import { Vessel } from '../src/sim/Vessel';
import { VesselPhysics, aeroCentre, type ControlCommand } from '../src/sim/VesselPhysics';
import { FlightSim } from '../src/sim/FlightSim';
import { CraftBuilder, applyAutoStagingSafe } from '../src/parts/CraftBuilder';
import { layoutCraft, rerootCraft, cloneCraft, extractSubtree, type CraftData } from '../src/parts/Craft';
import { analyzeStages, simPartsFromLayout, totalDv } from '../src/parts/DeltaV';
import { PART_DEFS, computePartStats, defaultConfig } from '../src/parts/PartCatalog';
import { getLaunchSite } from '../src/world/LaunchSites';
import { snapshotVessel, vesselFromSnapshot } from '../src/sim/Snapshot';
import { decodeCraft, encodeCraft } from '../src/game/CraftCode';

const T0 = utFromDate(new Date(Date.UTC(2026, 8, 24, 14, 0, 0)));
const DEG = Math.PI / 180;

function system() {
  const sys = new SolarSystem(T0);
  return { sys, earth: sys.get('earth') };
}

/** A vessel flying through the lower atmosphere, nose along +up (speed < 0: tail first). */
function inAir(craft: CraftData, speed = 250, alt = 3000) {
  const { earth } = system();
  const v = Vessel.fromCraft(craft, earth);
  const up = new Vector3(1, 0, 0);
  v.r.copy(up).multiplyScalar(earth.radius + alt);
  earth.surfaceVelocity(v.r, v.v);
  v.v.addScaledVector(up, speed);
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), up);
  v.w.set(0, 0, 0);
  v.situation = 'flying';
  v.pinned = false;
  v.clamped = false;
  return v;
}

/** A vessel in a 300 km circular orbit (vacuum). */
function inOrbit(craft: CraftData) {
  const { earth } = system();
  const v = Vessel.fromCraft(craft, earth);
  const R = earth.radius + 300_000;
  v.r.set(R, 0, 0);
  v.v.set(0, 0, Math.sqrt(earth.mu / R));
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 0, 1));
  v.situation = 'orbiting';
  v.pinned = false;
  v.clamped = false;
  return v;
}

/** Angular-velocity change from one physics step with a given command. */
function spinFrom(craft: CraftData, cmd: ControlCommand, speed = 250): Vector3 {
  const v = inAir(craft, speed);
  const phys = new VesselPhysics();
  phys.time = T0;
  phys.step(v, 1 / 60, cmd);
  return v.w.clone();
}

function dart(fin: string): CraftData {
  const b = new CraftBuilder('Dart', 'Probe, tank, fins');
  const core = b.root('probe-mite');
  b.above(core, 'nosecone', { diameter: 0.625 });
  const t = b.below(core, 'tank-63', { length: 4, propellant: 'kerolox' });
  b.below(t, 'eng-gnat', { cluster: 1 });
  b.radial(t, fin, 4, -1.6, Math.PI / 4);
  return applyAutoStagingSafe(b.craft);
}

describe('catalogue', () => {
  it('every part has consistent stats and a sensible layout', () => {
    for (const def of PART_DEFS) {
      const st = computePartStats(def, defaultConfig(def));
      expect(st.height, def.id).toBeGreaterThan(0);
      expect(st.dryMass + st.propellantCapacity, def.id).toBeGreaterThan(0);
      expect(Number.isFinite(st.cost), def.id).toBe(true);
    }
  });

  it('nuclear engine burns liquid hydrogen at twice chemical Isp', () => {
    const b = new CraftBuilder('NTR tug');
    const core = b.root('probe-sentinel');
    // Hydrogen is so light that the tank must be huge for the heavy reactor to pay off
    const t = b.below(core, 'tank-500', { length: 20, propellant: 'lh2' });
    b.below(t, 'eng-atom', { cluster: 1 });
    const c = applyAutoStagingSafe(b.craft);
    const st = analyzeStages(simPartsFromLayout(c, layoutCraft(c)), 0, 9.80665);
    expect(st[0]!.dvVac).toBeGreaterThan(7000);
    expect(st[0]!.dvVac / st[0]!.dvSL).toBeGreaterThan(3);
  });
});

describe('tweakables', () => {
  it('propellant load scales the loaded mass in the editor and in flight', () => {
    const b = new CraftBuilder('Half full');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-125', { length: 4, propellant: 'kerolox', fill: 0.5 });
    b.below(t, 'eng-rotor', { cluster: 1 });
    const c = applyAutoStagingSafe(b.craft);
    const tank = simPartsFromLayout(c, layoutCraft(c)).find((p) => p.uid === t)!;
    const cap = computePartStats(PART_DEFS.find((d) => d.id === 'tank-125')!, { length: 4, propellant: 'kerolox' }).propellantCapacity;
    expect(tank.fuel).toBeCloseTo(cap / 2, 3);
    const v = Vessel.fromCraft(c, system().earth);
    expect(v.partByUid(t)!.fuel).toBeCloseTo(cap / 2, 3);
    expect(v.partByUid(t)!.fuelCapacity).toBeCloseTo(cap, 3);
  });

  it('locking the gimbal removes its steering authority', () => {
    const make = (lock: boolean) => {
      const b = new CraftBuilder('Gimbal');
      const core = b.root('probe-mite');
      const t = b.below(core, 'tank-125', { length: 6, propellant: 'kerolox' });
      b.below(t, 'eng-hawk', { cluster: 1, gimbalLock: lock || undefined });
      return applyAutoStagingSafe(b.craft);
    };
    const auth = (lock: boolean) => {
      const v = inOrbit(make(lock));
      for (const p of v.parts) if (p.isEngine) p.engineIgnited = true;
      v.controls.throttle = 1;
      const phys = new VesselPhysics();
      phys.time = T0;
      for (let i = 0; i < 90; i++) phys.step(v, 1 / 60, { x: 0, y: 0, z: 0 });
      return phys.controlAuthority(v, new Vector3()).x;
    };
    expect(auth(false)).toBeGreaterThan(auth(true) * 20);
  });
});

describe('crossfeed (asparagus staging)', () => {
  function boosted(crossfeed: boolean): CraftData {
    const b = new CraftBuilder('Asparagus');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-250', { length: 14, propellant: 'kerolox' });
    b.below(t, 'eng-hawk', { cluster: 1 });
    for (const sep of b.radial(t, 'decoupler-radial', 2, 0, 0, crossfeed ? { crossfeed: true } : undefined)) {
      const bt = b.radial(sep, 'tank-250', 1, 0, 0, { length: 10, propellant: 'kerolox' })[0]!;
      b.below(bt, 'eng-hawk', { cluster: 1 });
    }
    return applyAutoStagingSafe(b.craft);
  }

  it('predicts more Δv than feeding each booster only its own tank', () => {
    const dv = (cf: boolean) => {
      const c = boosted(cf);
      return totalDv(analyzeStages(simPartsFromLayout(c, layoutCraft(c)), 0, 9.80665));
    };
    const plain = dv(false);
    const aspar = dv(true);
    expect(aspar).toBeGreaterThan(plain * 1.02);
  });

  it('drains the booster tanks before the core tank in flight', () => {
    const c = boosted(true);
    const v = inOrbit(c);
    const core = v.parts.find((p) => p.def.id === 'tank-250' && p.flowDepth === 0)!;
    const boosters = v.parts.filter((p) => p.def.id === 'tank-250' && p.flowDepth === 1);
    expect(boosters.length).toBe(2);
    expect(new Set(v.parts.filter((p) => p.propellant === 'kerolox').map((p) => p.group)).size).toBe(1);
    for (const p of v.parts) if (p.isEngine) p.engineIgnited = true;
    v.controls.throttle = 1;
    const phys = new VesselPhysics();
    phys.time = T0;
    const coreFull = core.fuel;
    const b0 = boosters[0]!.fuel;
    for (let i = 0; i < 600; i++) phys.step(v, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(core.fuel).toBeCloseTo(coreFull, 6);
    expect(boosters[0]!.fuel).toBeLessThan(b0 * 0.95);
    expect(boosters[0]!.fuel).toBeCloseTo(boosters[1]!.fuel, 3);
  });
});

describe('placement tweaks', () => {
  it('offsets move a radial part along its own attach frame, symmetrically', () => {
    const b = new CraftBuilder('Offsets');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-250', { length: 6 });
    const fins = b.radial(t, 'fin-small', 2, -2, 0);
    const base = layoutCraft(b.craft);
    const r0 = Math.hypot(base.get(fins[0]!)!.position.x, base.get(fins[0]!)!.position.z);
    for (const u of fins) b.craft.parts.find((p) => p.uid === u)!.config.offset = [0.5, 0.25, 0];
    const lay = layoutCraft(b.craft);
    const a = lay.get(fins[0]!)!.position;
    const c = lay.get(fins[1]!)!.position;
    expect(Math.hypot(a.x, a.z)).toBeCloseTo(r0 + 0.5, 5);
    expect(a.y).toBeCloseTo(base.get(fins[0]!)!.position.y + 0.25, 5);
    expect(a.x).toBeCloseTo(-c.x, 5);
    expect(a.z).toBeCloseTo(-c.z, 5);
  });

  it('rotations tilt the part and everything attached to it', () => {
    const b = new CraftBuilder('Canted');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-250', { length: 6 });
    const [pod] = b.radial(t, 'tank-125', 1, 0, 0, { length: 3 });
    const eng = b.below(pod!, 'eng-rotor', { cluster: 1 });
    b.craft.parts.find((p) => p.uid === pod)!.config.rot = [0, 0, 10];
    const lay = layoutCraft(b.craft);
    const axis = new Vector3(0, 1, 0).applyQuaternion(lay.get(eng)!.rotation);
    expect(Math.acos(axis.y) / DEG).toBeCloseTo(10, 3);
    // Canted engines lose Δv (cosine loss)
    const straight = cloneCraft(b.craft);
    straight.parts.find((p) => p.uid === pod)!.config.rot = undefined;
    const dv = (c: CraftData) => totalDv(analyzeStages(simPartsFromLayout(c, layoutCraft(c)), 0, 9.80665));
    applyAutoStagingSafe(b.craft);
    applyAutoStagingSafe(straight);
    expect(dv(b.craft)).toBeLessThan(dv(straight));
  });

  it('re-rooting keeps the shape and the tree valid', () => {
    const b = new CraftBuilder('Reroot');
    const probe = b.root('probe-sentinel');
    const t = b.below(probe, 'tank-250', { length: 6 });
    const eng = b.below(t, 'eng-hawk', { cluster: 1 });
    b.radial(t, 'fin-small', 3, -2);
    const before = layoutCraft(b.craft);
    const c = cloneCraft(b.craft);
    expect(rerootCraft(c, eng)).toBe(true);
    const after = layoutCraft(c);
    expect(after.size).toBe(before.size);
    const d0 = before.get(probe)!.position.clone().sub(before.get(eng)!.position);
    const d1 = after.get(probe)!.position.clone().sub(after.get(eng)!.position);
    expect(d1.distanceTo(d0)).toBeLessThan(1e-9);
    expect(c.parts.filter((p) => p.parent === -1).length).toBe(1);
    // A radially mounted part cannot become the root
    const fin = c.parts.find((p) => p.defId === 'fin-small')!;
    expect(rerootCraft(cloneCraft(c), fin.uid)).toBe(false);
  });

  it('subassemblies are self-contained part trees', () => {
    const b = new CraftBuilder('Sub');
    const probe = b.root('probe-sentinel');
    const t = b.below(probe, 'tank-250', { length: 6 });
    const sep = b.radial(t, 'decoupler-radial', 2, 0)[0]!;
    const srb = b.radial(sep, 'srb-spark', 1, 0)[0]!;
    b.above(srb, 'nosecone', { diameter: 1.25 });
    const sub = extractSubtree(b.craft, sep, 'Booster');
    expect(sub.parts.length).toBe(3);
    expect(sub.parts.filter((p) => p.parent === -1).length).toBe(1);
    expect(layoutCraft(sub).size).toBe(3);
  });
});

describe('aerodynamics', () => {
  it('fins put the centre of pressure behind the centre of mass', () => {
    const finned = Vessel.fromCraft(dart('fin-small'), system().earth);
    const cp = new Vector3();
    aeroCentre(finned, 5 * DEG, 'z', cp);
    expect(cp.y).toBeLessThan(finned.com.y);
    const b = new CraftBuilder('Bare');
    const core = b.root('probe-mite');
    b.above(core, 'nosecone', { diameter: 0.625 });
    const t = b.below(core, 'tank-63', { length: 4, propellant: 'kerolox' });
    b.below(t, 'eng-gnat', { cluster: 1 });
    const bare = Vessel.fromCraft(applyAutoStagingSafe(b.craft), system().earth);
    const cp2 = new Vector3();
    aeroCentre(bare, 5 * DEG, 'z', cp2);
    expect(bare.com.y - cp2.y).toBeLessThan(finned.com.y - cp.y);
  });

  it('control fins steer in the commanded direction, nose-first and tail-first', () => {
    const control = dart('fin-control');
    const fixed = dart('fin-small');
    for (const speed of [250, -120]) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const cmd = { x: 0, y: 0, z: 0 };
        cmd[axis] = 1;
        const gain = spinFrom(control, cmd, speed)[axis] - spinFrom(control, { x: 0, y: 0, z: 0 }, speed)[axis];
        const base = spinFrom(fixed, cmd, speed)[axis] - spinFrom(fixed, { x: 0, y: 0, z: 0 }, speed)[axis];
        expect(gain, `${axis} at ${speed} m/s`).toBeGreaterThan(Math.max(base, 0) * 5);
      }
    }
  });

  it('airbrakes add drag when open', () => {
    const b = new CraftBuilder('Braked');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-125', { length: 4 });
    b.radial(t, 'airbrake', 4, 1, Math.PI / 4);
    const craft = applyAutoStagingSafe(b.craft);
    const decel = (open: boolean) => {
      const v = inAir(craft, 200);
      if (open) {
        v.controls.brakes = true;
        for (const p of v.parts) if (p.def.airbrake) p.brakeDeploy = 1;
      }
      const phys = new VesselPhysics();
      phys.time = T0;
      const s0 = v.airVelocity.length();
      phys.step(v, 1 / 60, { x: 0, y: 0, z: 0 });
      return s0 - v.airVelocity.length();
    };
    expect(decel(true)).toBeGreaterThan(decel(false) * 1.5);
  });
});

describe('flight tools', () => {
  it('action groups toggle legs and light engines', () => {
    const b = new CraftBuilder('Hopper');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-250', { length: 3, propellant: 'hypergolic' });
    b.below(t, 'eng-moth', { cluster: 1, groups: [2] });
    b.radial(t, 'leg-small', 3, -1, 0, { groups: [1] });
    const sim = new FlightSim(new SolarSystem(T0), applyAutoStagingSafe(b.craft), getLaunchSite('cape'), T0);
    const v = sim.active;
    expect(sim.triggerActionGroup(1)).toBe(3);
    expect(v.parts.filter((p) => p.def.legs).every((p) => p.legsDeployed)).toBe(true);
    sim.triggerActionGroup(1);
    expect(v.parts.some((p) => p.legsDeployed)).toBe(false);
    expect(sim.triggerActionGroup(2)).toBe(1);
    expect(v.parts.find((p) => p.isEngine)!.engineIgnited).toBe(true);
    expect(sim.triggerActionGroup(5)).toBe(0);
  });

  it('infinite propellant keeps the tanks full', () => {
    const b = new CraftBuilder('Cheater');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-125', { length: 3, propellant: 'kerolox' });
    b.below(t, 'eng-rotor', { cluster: 1 });
    const v = inOrbit(applyAutoStagingSafe(b.craft));
    for (const p of v.parts) if (p.isEngine) p.engineIgnited = true;
    v.controls.throttle = 1;
    const phys = new VesselPhysics();
    phys.cheats.infiniteFuel = true;
    phys.time = T0;
    const tank = v.parts.find((p) => p.def.tank)!;
    const f0 = tank.fuel;
    for (let i = 0; i < 300; i++) phys.step(v, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(tank.fuel).toBe(f0);
    expect(v.totalThrust).toBeGreaterThan(0);
    // Switching the cheat on also revives a stage that already ran dry
    tank.fuel = 0;
    for (let i = 0; i < 120; i++) phys.step(v, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(tank.fuel).toBe(tank.fuelCapacity);
    expect(v.totalThrust).toBeGreaterThan(0);
  });

  it('RCS draws monopropellant from tanks anywhere on the vessel', () => {
    const b = new CraftBuilder('RCS');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-125', { length: 1, propellant: 'monoprop' });
    b.radial(t, 'rcs-quad', 4, 0, Math.PI / 4, { fill: 0 });
    const v = inOrbit(applyAutoStagingSafe(b.craft));
    const tank = v.parts.find((p) => p.def.tank)!;
    v.controls.rcs = true;
    v.controls.ty = 1;
    const phys = new VesselPhysics();
    phys.time = T0;
    const f0 = tank.fuel;
    phys.step(v, 1 / 60, { x: 0, y: 0, z: 0 });
    expect(v.rcsActive).toBe(true);
    expect(tank.fuel).toBeLessThan(f0);
  });

  it('unlimited-restart engines survive a save round trip', () => {
    const b = new CraftBuilder('Puffer');
    const core = b.root('probe-mite');
    const t = b.below(core, 'tank-63', { length: 1, propellant: 'monoprop' });
    b.below(t, 'eng-puff', { cluster: 1 });
    const v = inOrbit(applyAutoStagingSafe(b.craft));
    const snap = JSON.parse(JSON.stringify(snapshotVessel(v, T0, 'x', null)));
    const back = vesselFromSnapshot(snap, v.body);
    expect(back.parts.find((p) => p.isEngine)!.ignitionsLeft).toBe(Infinity);
  });
});

describe('design codes', () => {
  it('round-trip a craft through a compressed text code', async () => {
    const craft = dart('fin-control');
    craft.parts[2]!.config.groups = [1, 3];
    const code = await encodeCraft(craft);
    expect(code.startsWith('APG')).toBe(true);
    const back = await decodeCraft(`  ${code}\n`);
    expect(back).not.toBeNull();
    expect(JSON.stringify(back!.parts)).toBe(JSON.stringify(craft.parts));
  });

  it('rejects garbage and malformed trees', async () => {
    expect(await decodeCraft('hello')).toBeNull();
    expect(await decodeCraft('APG1:!!!!')).toBeNull();
    const bad = dart('fin-small');
    bad.parts[1]!.parent = bad.parts[2]!.uid;
    bad.parts[2]!.parent = bad.parts[1]!.uid;
    expect(await decodeCraft(JSON.stringify(bad))).toBeNull();
    const unknown = dart('fin-small');
    unknown.parts[0]!.defId = 'warp-drive';
    expect(await decodeCraft(JSON.stringify(unknown))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------

describe('review regressions', () => {
  const dvOf = (c: CraftData) => totalDv(analyzeStages(simPartsFromLayout(c, layoutCraft(c)), 0, 9.80665));

  /** Core + crossfed liquid boosters + plain solid boosters (auto-staged). */
  function mixed(boosterLength: number): CraftData {
    const b = new CraftBuilder('Mixed');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-250', { length: 14, propellant: 'kerolox' });
    b.below(t, 'eng-hawk', { cluster: 1 });
    for (const sep of b.radial(t, 'decoupler-radial', 2, 0, 0, { crossfeed: true })) {
      const bt = b.radial(sep, 'tank-125', 1, 0, 0, { length: boosterLength, propellant: 'kerolox' })[0]!;
      b.below(bt, 'eng-rotor', { cluster: 1 });
    }
    for (const sep of b.radial(t, 'decoupler-radial', 2, -2, Math.PI / 2)) b.radial(sep, 'srb-thunder', 1, 0, 0);
    return applyAutoStagingSafe(b.craft);
  }

  it('crossfeed Δv is continuous in the booster size (no stall on rounding crumbs)', () => {
    let prev = dvOf(mixed(3.5));
    for (let L = 3.55; L <= 4.5; L += 0.05) {
      const dv = dvOf(mixed(L));
      expect(Math.abs(dv - prev) / prev, `L=${L.toFixed(2)}`).toBeLessThan(0.03);
      prev = dv;
    }
    expect(Math.abs(dvOf(mixed(3.75)) - dvOf(mixed(3.751)))).toBeLessThan(20);
  });

  it('drop tanks on unstaged crossfeed decouplers are burned, then the core', () => {
    const b = new CraftBuilder('Drop tanks');
    const core = b.root('probe-sentinel');
    const t = b.below(core, 'tank-250', { length: 6, propellant: 'kerolox' });
    b.below(t, 'eng-hawk', { cluster: 1 });
    for (const sep of b.radial(t, 'decoupler-radial', 2, 0, 0, { crossfeed: true })) b.radial(sep, 'tank-125', 1, 0, 0, { length: 3.3, propellant: 'kerolox' });
    const c = applyAutoStagingSafe(b.craft);
    for (const p of c.parts) if (p.defId === 'decoupler-radial') p.stage = -1;
    c.manualStaging = true;
    const sp = simPartsFromLayout(c, layoutCraft(c));
    const m0 = sp.reduce((m, p) => m + p.dryMass + p.fuel, 0);
    const m1 = sp.reduce((m, p) => m + p.dryMass, 0);
    const isp = sp.find((p) => p.engine)!.engine!.ispVac;
    expect(dvOf(c)).toBeCloseTo(isp * 9.80665 * Math.log(m0 / m1), -1);
  });

  it('control fins never turn the wrong way past the stall', () => {
    for (const angle0 of [Math.PI / 4, 0]) {
      const b = new CraftBuilder('Dart');
      const core = b.root('probe-mite');
      b.above(core, 'nosecone', { diameter: 0.625 });
      const t = b.below(core, 'tank-63', { length: 4, propellant: 'kerolox' });
      b.below(t, 'eng-gnat', { cluster: 1 });
      b.radial(t, 'fin-control', 4, -1.6, angle0);
      const craft = applyAutoStagingSafe(b.craft);
      for (const aoa of [10, 20, 25, 30, 40, 60]) {
        for (const dir of [1, -1]) {
          const spin = (cmd: ControlCommand) => {
            const v = inAir(craft, 0);
            const up = new Vector3(1, 0, 0);
            const side = new Vector3(0, 1, 0);
            v.v.addScaledVector(up, dir * 250 * Math.cos(aoa * DEG)).addScaledVector(side, 250 * Math.sin(aoa * DEG));
            const phys = new VesselPhysics();
            phys.time = T0;
            phys.step(v, 1 / 60, cmd);
            return v.w.clone();
          };
          for (const axis of ['x', 'z'] as const) {
            const cmd = { x: 0, y: 0, z: 0 };
            cmd[axis] = 1;
            const gain = spin(cmd)[axis] - spin({ x: 0, y: 0, z: 0 })[axis];
            expect(gain, `${axis} aoa=${aoa} dir=${dir} layout=${angle0}`).toBeGreaterThan(-1e-9);
          }
        }
      }
    }
  });

  it('re-rooting ignores a tweak the old root carried (layout never applied it)', () => {
    const b = new CraftBuilder('Hidden tweak');
    const tank = b.root('tank-250', { length: 10 });
    const probe = b.above(tank, 'probe-sentinel');
    const eng = b.below(tank, 'eng-hawk', { cluster: 1 });
    b.radial(tank, 'srb-spark', 2, 0);
    b.craft.parts.find((p) => p.uid === tank)!.config.rot = [30, 0, 0];
    const before = layoutCraft(b.craft);
    const c = cloneCraft(b.craft);
    expect(rerootCraft(c, eng)).toBe(true);
    const after = layoutCraft(c);
    const d0 = before.get(probe)!.position.clone().sub(before.get(eng)!.position);
    const d1 = after.get(probe)!.position.clone().sub(after.get(eng)!.position);
    expect(d1.distanceTo(d0)).toBeLessThan(1e-9);
  });

  function twoStage(): { craft: CraftData; lowerEngine: number } {
    const b = new CraftBuilder('Two stage');
    const pod = b.root('probe-sentinel');
    b.above(pod, 'chute-main', { canopies: 1 });
    const t2 = b.below(pod, 'tank-125', { length: 3, propellant: 'kerolox' });
    const e2 = b.below(t2, 'eng-rotor-vac', { cluster: 1 });
    const dec = b.below(e2, 'decoupler-stack', { diameter: 1.25 });
    const t1 = b.below(dec, 'tank-125', { length: 9, propellant: 'kerolox' });
    const e1 = b.below(t1, 'eng-rotor', { cluster: 9 });
    return { craft: applyAutoStagingSafe(b.craft), lowerEngine: e1 };
  }

  it('Δv is the same whichever end of a stack is the root', () => {
    const { craft, lowerEngine } = twoStage();
    const dv0 = dvOf(craft);
    const c = cloneCraft(craft);
    expect(rerootCraft(c, lowerEngine)).toBe(true);
    applyAutoStagingSafe(c);
    expect(dvOf(c)).toBeCloseTo(dv0, 0);
  });

  it('a separated section with the command module keeps its remaining stages', () => {
    const { craft, lowerEngine } = twoStage();
    const c = cloneCraft(craft);
    rerootCraft(c, lowerEngine);
    applyAutoStagingSafe(c);
    const sim = new FlightSim(new SolarSystem(T0), c, getLaunchSite('cape'), T0);
    sim.stage();
    for (let i = 0; i < 120; i++) sim.update(1 / 60);
    sim.stage();
    const v = sim.active;
    expect(v.parts.some((p) => p.def.id === 'probe-sentinel')).toBe(true);
    expect(v.parts.some((p) => p.uid === lowerEngine)).toBe(false);
    const remaining = v.stages.slice(v.nextStage).flat().map((u) => v.partByUid(u)?.def.id);
    expect(remaining).toContain('chute-main');
  });

  it('separations in an action group wait for liftoff', () => {
    const { craft } = twoStage();
    const c = cloneCraft(craft);
    c.parts.find((p) => p.defId === 'decoupler-stack')!.config.groups = [4];
    const sim = new FlightSim(new SolarSystem(T0), c, getLaunchSite('cape'), T0);
    const n = sim.active.parts.length;
    expect(sim.triggerActionGroup(4)).toBe(1);
    expect(sim.groupHeld).toBe(1);
    expect(sim.active.parts.length).toBe(n);
    expect(sim.vessels.filter((x) => !x.destroyed).length).toBe(1);
  });

  it('share codes with out-of-range or malformed fields are rejected', async () => {
    const good = dart('fin-small');
    const variants: Array<(c: CraftData) => void> = [
      (c) => (c.parts[1]!.uid = -1),
      (c) => (c.parts[2]!.config.propellant = 'xenon' as never),
      (c) => (c.parts[1]!.uid = 2 ** 53),
      (c) => (c.parts[3]!.stage = 2e9),
      (c) => (c.parts[3]!.config.cluster = 3e7),
      (c) => (c.parts[4]!.config.groups = 5 as never),
      (c) => (c.parts[1]!.config.diameter = -2),
      (c) => (c.parts[4]!.config.offset = [1, Number.NaN, 0] as never),
      (c) => ((c.parts[0] as unknown as Record<string, unknown>).attach = 'sideways'),
      (c) => (c.parts[2]!.parent = -1),
    ];
    for (const [i, mutate] of variants.entries()) {
      const c = cloneCraft(good);
      mutate(c);
      expect(await decodeCraft(JSON.stringify(c)), `variant ${i}`).toBeNull();
    }
    const ok = await decodeCraft(JSON.stringify(good));
    expect(ok).not.toBeNull();
    expect(ok!.nextUid).toBe(Math.max(...good.parts.map((p) => p.uid)) + 1);
  });
});
