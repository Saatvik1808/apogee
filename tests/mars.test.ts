/**
 * LEARNING NOTE: Flying to Mars in a unit test
 *
 * The Mars campaign relies on a chain of tools working together: the porkchop
 * search picks the departure, the launch window aligns the parking orbit with the
 * departure asymptote, the injection planner finds the burn, a mid-course
 * correction trims the arrival, and a periapsis burn captures into orbit. This
 * test flies that chain headless (about a minute of CPU; APOGEE_LONG=1).
 *
 * Key concepts: interplanetary mission design, end-to-end tests
 */
import { expect, it } from 'vitest';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';
import { FlightSim } from '../src/sim/FlightSim';
import { TEMPLATES } from '../src/parts/Templates';
import { getLaunchSite } from '../src/world/LaunchSites';
import { planCapture, planCorrection, planMarsTransfer } from '../src/sim/Planner';
import { marsLaunchWindow } from '../src/game/LaunchWindow';

const out: string[] = [];
const envEarly = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const log = (s: string) => {
  out.push(s);
  if (envEarly?.env.APOGEE_TRACE) envEarly.stderr.write(`${s}\n`);
};

function run(sim: FlightSim, seconds: number, stop: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 60; i++) {
    sim.update(1 / 60);
    if (stop()) return;
  }
}

function state(sim: FlightSim, label: string): void {
  const v = sim.active;
  const p = sim.predictor.patches[0];
  const o = p?.orbit;
  const R = v.body.radius;
  let enc = '';
  for (let i = 1; i < sim.predictor.count; i++) {
    const q = sim.predictor.patches[i]!;
    enc += ` → ${q.body.id}(pe ${((q.orbit.periapsis - q.body.radius) / 1000).toFixed(0)} km)`;
  }
  log(`[${label}] day=${((sim.time - sim.launchTime) / 86400).toFixed(2)} body=${v.body.id} alt=${(v.altitude / 1000).toFixed(0)}km ap=${o && o.isElliptic ? ((o.apoapsis - R) / 1000).toFixed(0) : '∞'} pe=${o ? ((o.periapsis - R) / 1000).toFixed(0) : '-'} mass=${(v.mass / 1000).toFixed(1)}t${enc}`);
}

function executeNode(sim: FlightSim): void {
  // As a player would: press Execute, then time-warp; the warp drops out in
  // time for the burn and the vessel already holds the burn attitude
  sim.autopilot.engage('node', sim);
  sim.setWarpIndex(11);
  run(sim, 20000, () => sim.warpIndex === 0);
  sim.stopWarp();
  run(sim, 4000, () => sim.autopilot.mode === 'off');
  log(`  node done: "${sim.autopilot.doneMessage}"`);
}

function coastUntil(sim: FlightSim, cond: () => boolean, maxSimSeconds: number): void {
  const t0 = sim.time;
  sim.setWarpIndex(11);
  for (let i = 0; i < 400000 && sim.time - t0 < maxSimSeconds; i++) {
    sim.update(1 / 60);
    if (cond()) break;
    if (sim.warpIndex < 8) sim.setWarpIndex(11);
  }
  sim.stopWarp();
}

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;

it.skipIf(!env?.env.APOGEE_LONG)('flies the Ares probe from Cape Canaveral into Mars orbit', () => {
  const tA = utFromDate(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)));
  const sys = new SolarSystem(tA);
  const site = getLaunchSite('cape');
  const win = marsLaunchWindow(sys, site, tA);
  log(`window: launch ${new Date(Date.UTC(2000, 0, 1, 12) + win.ut * 1000).toISOString()} heading ${win.heading.toFixed(1)}° inc ${win.inclination.toFixed(1)}° vInf ${win.vInf.toFixed(0)}`);
  sys.update(win.ut);
  const sim = new FlightSim(sys, TEMPLATES.find((t) => t.id === 'ares')!.build(), site, win.ut);
  sim.autopilot.ascent.targetAltitude = 200_000;
  sim.autopilot.ascent.heading = win.heading;
  sim.autopilot.ascent.planeNormal = win.normal;
  sim.autopilot.engage('ascent', sim);
  run(sim, 1500, () => sim.autopilot.mode === 'off');
  run(sim, 2);
  state(sim, 'parking');
  const w0 = performance.now();
  const tmi = planMarsTransfer(sim);
  log(`TMI plan (${(performance.now() - w0).toFixed(0)} ms): ${tmi.message}`);
  if (!tmi.ok && env?.env.APOGEE_REPORT) env.stderr.write(out.join('\n') + '\n');
  expect(tmi.ok).toBe(true);
  state(sim, 'planned');
  executeNode(sim);
  run(sim, 2);
  state(sim, 'after TMI');
  // Leave Earth's sphere of influence, then correct
  coastUntil(sim, () => sim.active.body.id === 'sun', 10 * 86400);
  run(sim, 2);
  state(sim, 'solar orbit');
  const w1 = performance.now();
  const mcc = planCorrection(sim);
  log(`MCC plan (${(performance.now() - w1).toFixed(0)} ms): ${mcc.message}`);
  if (mcc.ok && mcc.node) {
    executeNode(sim);
    run(sim, 2);
    state(sim, 'after MCC');
  }
  // Second correction a few weeks out, as real missions do (TCM-4/5)
  const arrive = sim.predictor.patches[0]!.endTime;
  coastUntil(sim, () => sim.time > arrive - 20 * 86400, 400 * 86400);
  run(sim, 2);
  const mcc2 = planCorrection(sim);
  log(`MCC-2 plan: ${mcc2.message}`);
  if (mcc2.ok && mcc2.node) {
    executeNode(sim);
    run(sim, 2);
    state(sim, 'after MCC-2');
  }
  coastUntil(sim, () => sim.active.body.id === 'mars', 400 * 86400);
  run(sim, 2);
  state(sim, 'Mars SOI');
  expect(sim.active.body.id).toBe('mars');
  const moi = planCapture(sim);
  log(`MOI plan: ${moi.message}`);
  if (moi.ok) {
    executeNode(sim);
    run(sim, 2);
    state(sim, 'Mars orbit');
  }
  if (env?.env.APOGEE_REPORT) env.stderr.write(out.join('\n') + '\n');
  run(sim, 2);
  expect(sim.active.body.id).toBe('mars');
  expect(sim.predictor.count).toBeGreaterThan(0);
  const o = sim.predictor.patches[0]!.orbit;
  expect(o.e).toBeLessThan(1);
  expect(o.periapsis - sys.mars.radius).toBeGreaterThan(60_000);
}, 600_000);
