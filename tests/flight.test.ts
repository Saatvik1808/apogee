/**
 * LEARNING NOTE: End-to-end flight tests
 *
 * The strongest test of a physics engine is to fly a real mission: launch a
 * template rocket from Cape Canaveral with the ascent autopilot and check it
 * reaches a stable orbit, with every subsystem involved (engines, staging,
 * aerodynamics, gimbal control, guidance, integration).
 *
 * Key concepts: integration testing, simulation telemetry
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';
import { FlightSim } from '../src/sim/FlightSim';
import { TEMPLATES } from '../src/parts/Templates';
import { getLaunchSite } from '../src/world/LaunchSites';
import { Orbit } from '../src/physics/Orbit';

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const log = (s: string) => {
  if (env?.env.APOGEE_REPORT) env.stderr.write(s + '\n');
};

function flyToOrbit(templateId: string, targetAlt: number, maxTime = 1500) {
  const t0 = utFromDate(new Date(Date.UTC(2026, 8, 24, 14, 0, 0)));
  const sys = new SolarSystem(t0);
  const craft = TEMPLATES.find((t) => t.id === templateId)!.build();
  const sim = new FlightSim(sys, craft, getLaunchSite('cape'), t0);
  sim.autopilot.ascent.targetAltitude = targetAlt;
  sim.autopilot.engage('ascent', sim);
  const o = new Orbit();
  let nextLog = 0;
  let gLogged = false;
  const events: string[] = [];
  for (let i = 0; i < maxTime * 60; i++) {
    sim.update(1 / 60);
    for (const e of sim.events) events.push(`${(e.time - t0).toFixed(1)}s ${e.kind}: ${e.message}`);
    sim.events.length = 0;
    const v = sim.active;
    const t = sim.time - t0;
    if (t >= nextLog) {
      nextLog += 10;
      o.setFromState(v.r, v.v, v.body.mu, sim.time);
      const up = v.r.clone().normalize();
      const fwd = new Vector3(0, 1, 0).applyQuaternion(v.q);
      const pitch = (Math.asin(Math.max(-1, Math.min(1, fwd.dot(up)))) * 180) / Math.PI;
      log(
        `${templateId} t=${t.toFixed(0)} alt=${(v.altitude / 1000).toFixed(1)}km v=${v.v.length().toFixed(0)} vs=${v.surfaceVelocity.length().toFixed(0)} pitch=${pitch.toFixed(1)} q=${(v.dynamicPressure / 1000).toFixed(1)}kPa aoa=${((v.angleOfAttack * 180) / Math.PI).toFixed(1)} ` +
          `m=${(v.mass / 1000).toFixed(1)}t T=${(v.totalThrust / 1e3).toFixed(0)}kN ap=${((o.apoapsis - v.body.radius) / 1000).toFixed(0)} pe=${((o.periapsis - v.body.radius) / 1000).toFixed(0)} stage=${v.nextStage} ${sim.autopilot.phase} ${v.situation}`,
      );
    }
    if (v.gForce > 6 && !gLogged) {
      gLogged = true;
      log(`HIGH G ${v.gForce.toFixed(1)} at t=${t.toFixed(1)} thrust=${v.totalThrust.toFixed(0)} mass=${v.mass.toFixed(0)} q=${v.dynamicPressure.toFixed(0)} stage=${v.nextStage} touching=${v.touchingGround}`);
    }
    if (sim.autopilot.mode === 'off' || v.destroyed) break;
  }
  const v = sim.active;
  o.setFromState(v.r, v.v, v.body.mu, sim.time);
  log(events.join('\n'));
  log(`${templateId}: done="${sim.autopilot.doneMessage}" ap=${((o.apoapsis - v.body.radius) / 1000).toFixed(1)} pe=${((o.periapsis - v.body.radius) / 1000).toFixed(1)} inc=${((o.inc * 180) / Math.PI).toFixed(2)} dvUsed=${v.dvExpended.toFixed(0)} maxQ=${(v.maxQ / 1000).toFixed(1)}kPa maxG=${v.maxG.toFixed(2)}`);
  return { sim, orbit: o, vessel: v };
}

describe('Ascent autopilot', () => {
  it('Sprite reaches orbit', () => {
    const { orbit, vessel } = flyToOrbit('sprite', 250_000);
    expect(vessel.destroyed).toBe(false);
    expect(orbit.periapsis - vessel.body.radius).toBeGreaterThan(140_000);
  }, 120_000);

  it('Colossus reaches orbit', () => {
    const { orbit, vessel } = flyToOrbit('colossus', 200_000, 2000);
    expect(vessel.destroyed).toBe(false);
    expect(orbit.periapsis - vessel.body.radius).toBeGreaterThan(140_000);
  }, 240_000);

  it('Heron 9 reaches orbit', () => {
    const { orbit, vessel } = flyToOrbit('heron', 250_000);
    expect(vessel.destroyed).toBe(false);
    expect(orbit.periapsis - vessel.body.radius).toBeGreaterThan(140_000);
  }, 120_000);
});
