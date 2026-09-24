/**
 * LEARNING NOTE: Regression tests for ground contact
 *
 * A lander standing on four long legs is the hardest case for a spring–damper
 * contact model integrated explicitly: the feet sit far from the centre of mass,
 * so a small angular velocity becomes a large foot velocity, and a damper strong
 * enough to settle the vehicle can overshoot within one physics step and pump
 * energy INTO the rotation instead of taking it out. The symptom was landers
 * that touched down gently and then "exploded" (legs destroyed at 20 m/s) while
 * sitting still. These tests set a lander a few centimetres above the ground on
 * Earth, the Moon and Mars and require it to settle without losing a part.
 *
 * Key concepts: numerical stability of explicit integration, effective mass of a
 * contact point, regression testing physics
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';
import { FlightSim } from '../src/sim/FlightSim';
import { CraftBuilder, applyAutoStagingSafe } from '../src/parts/CraftBuilder';
import { getLaunchSite } from '../src/world/LaunchSites';
import type { CelestialBody } from '../src/physics/CelestialBody';
import type { Vessel } from '../src/sim/Vessel';

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const log = (s: string) => {
  if (env?.env.APOGEE_REPORT) env.stderr.write(s + '\n');
};

/** The Selene lander alone (probe core, hypergolic tank, four large legs, Moth engine). */
function landerCraft() {
  const b = new CraftBuilder('Selene', 'Robotic lander');
  const core = b.root('probe-sentinel');
  b.radial(core, 'solar-panel', 2, 0, 0);
  const tank = b.below(core, 'tank-250', { length: 1.25, propellant: 'hypergolic' });
  b.radial(tank, 'leg-large', 4, -0.3, Math.PI / 4);
  b.below(tank, 'eng-moth', { cluster: 1 });
  return applyAutoStagingSafe(b.craft);
}

/**
 * Put the vessel on `body` at body-fixed direction `dirBF`, legs deployed, its
 * lowest foot `gap` metres above the surface, descending at `descent` m/s.
 */
function placeAbove(v: Vessel, body: CelestialBody, dirBF: Vector3, gap: number, descent: number, fuelFraction: number): void {
  v.body = body;
  for (const p of v.parts) {
    if (p.def.legs) {
      p.legsDeployed = true;
      p.legDeploy = 1;
    }
    if (p.fuelCapacity > 0 && !p.isSolid) p.fuel = p.fuelCapacity * fuelFraction;
  }
  v.refreshStructure();
  v.computeMassProperties(false);
  const up = dirBF.clone().normalize().applyQuaternion(body.rotation);
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), up);
  v.w.set(0, 0, 0);
  let lowest = Infinity;
  for (const c of v.contactPoints) {
    const d = c.pos.clone().sub(v.com).applyQuaternion(v.q).dot(up);
    lowest = Math.min(lowest, d);
  }
  const hT = body.terrain ? body.terrain.heightAt(dirBF) : 0;
  v.r.copy(up).multiplyScalar(body.radius + hT - lowest + gap);
  body.surfaceVelocity(v.r, v.v);
  v.v.addScaledVector(up, -descent);
  v.pinned = false;
  v.clamped = false;
  v.onRails = false;
  v.situation = 'flying';
  v.settledTime = 0;
}

function settle(label: string, bodyId: 'earth' | 'moon' | 'mars', fuelFraction: number, descent: number) {
  const t0 = utFromDate(new Date(Date.UTC(2026, 8, 24, 14, 0, 0)));
  const sys = new SolarSystem(t0);
  const site = getLaunchSite('cape');
  const sim = new FlightSim(sys, landerCraft(), site, t0);
  const v = sim.active;
  const body = sys.get(bodyId);
  const dirBF = bodyId === 'earth' ? v.r.clone().applyQuaternion(body.rotationInverse).normalize() : new Vector3(1, 0, 0);
  placeAbove(v, body, dirBF, 0.02, descent, fuelFraction);
  const m0 = v.mass;
  let maxW = 0;
  let maxA = 0;
  const events: string[] = [];
  for (let i = 0; i < 12 * 60; i++) {
    sim.update(1 / 60);
    for (const e of sim.events) events.push(`${(sim.time - t0).toFixed(2)}s ${e.kind}: ${e.message}`);
    sim.events.length = 0;
    maxW = Math.max(maxW, v.w.length());
    maxA = Math.max(maxA, v.acceleration.length());
    if (v.destroyed) break;
  }
  log(`${label}: mass=${(m0 / 1000).toFixed(1)}t sit=${v.situation} pinned=${v.pinned} destroyed=${v.destroyed} parts=${v.parts.length} maxW=${maxW.toFixed(3)} rad/s maxA=${maxA.toFixed(1)} m/s² w=${v.w.length().toFixed(4)}`);
  log(events.join('\n'));
  return { sim, v, maxW, maxA };
}

describe('Legged lander touchdown', () => {
  it('Selene settles on the Earth pad without losing a part', () => {
    const { v, maxW } = settle('earth', 'earth', 1, 0.65);
    expect(v.destroyed).toBe(false);
    expect(v.parts.some((p) => p.destroyed)).toBe(false);
    expect(v.parts.length).toBe(9);
    expect(v.situation).toBe('landed');
    expect(v.pinned).toBe(true);
    expect(maxW).toBeLessThan(0.5);
  }, 60_000);

  it('Selene settles on the Moon with a third of its propellant', () => {
    const { v } = settle('moon', 'moon', 0.3, 0.65);
    expect(v.destroyed).toBe(false);
    expect(v.parts.length).toBe(9);
    expect(v.situation).toBe('landed');
    expect(v.pinned).toBe(true);
    expect(v.w.length()).toBeLessThan(0.05);
  }, 60_000);

  it('Selene settles on Mars half full', () => {
    const { v } = settle('mars', 'mars', 0.5, 1.0);
    expect(v.destroyed).toBe(false);
    expect(v.parts.length).toBe(9);
    expect(v.situation).toBe('landed');
    expect(v.pinned).toBe(true);
  }, 60_000);
});
