/**
 * LEARNING NOTE: A whole Moon mission as a test
 *
 * The strongest check of the planners and autopilots is to fly Apollo end to
 * end: launch in the lunar window, trans-lunar injection, mid-course
 * correction, lunar orbit insertion, powered descent, lunar ascent, trans-Earth
 * injection, a second correction and re-entry under parachutes. It takes about
 * a minute of CPU, so it only runs with APOGEE_LONG=1.
 *
 * Key concepts: end-to-end testing, mission design, Δv budgets
 */
import { it, expect } from 'vitest';
import { SolarSystem } from '../src/physics/SolarSystem';
import { utFromDate } from '../src/physics/Ephemeris';
import { FlightSim } from '../src/sim/FlightSim';
import { TEMPLATES } from '../src/parts/Templates';
import { getLaunchSite } from '../src/world/LaunchSites';
import { planCircularize, planCorrection, planMoonTransfer, planReturnToEarth } from '../src/sim/Planner';
import { lunarLaunchWindow } from '../src/game/LaunchWindow';
import { analyzeStages } from '../src/parts/DeltaV';
import { burnLeadTime } from '../src/sim/Maneuver';

const out: string[] = [];
const log = (s: string) => out.push(s);

function run(sim: FlightSim, seconds: number, stop: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 60; i++) {
    sim.update(1 / 60);
    if (stop()) return;
  }
}

function stages(sim: FlightSim): string {
  const v = sim.active;
  const st = analyzeStages(v.toSimParts(), v.nextStage, 1.62);
  return st.map((x) => `[s${x.stage} dv=${x.dvVac.toFixed(0)} twr=${x.twrVac.toFixed(2)} m=${(x.startMass / 1000).toFixed(1)}→${(x.endMass / 1000).toFixed(1)}]`).join(' ');
}

function state(sim: FlightSim, label: string): void {
  const v = sim.active;
  const p = sim.predictor.patches[0];
  const o = p?.orbit;
  const R = v.body.radius;
  const enc = sim.predictor.count > 1 ? ` → ${sim.predictor.patches[0]!.endReason} ${sim.predictor.patches[1]!.body.id} pe=${((sim.predictor.patches[1]!.orbit.periapsis - sim.predictor.patches[1]!.body.radius) / 1000).toFixed(0)}km` : '';
  log(`   stages: ${stages(sim)}`);
  log(`[${label}] t=${((sim.time - sim.launchTime) / 3600).toFixed(2)}h body=${v.body.id} alt=${(v.altitude / 1000).toFixed(0)}km ap=${o ? ((o.apoapsis - R) / 1000).toFixed(0) : '-'} pe=${o ? ((o.periapsis - R) / 1000).toFixed(0) : '-'} sit=${v.situation} mass=${(v.mass / 1000).toFixed(1)}t${enc}`);
}

function executeNode(sim: FlightSim, trace = false): void {
  const n = sim.nodes[0]!;
  const lead = burnLeadTime(sim.active, n.remaining.length());
  sim.setWarpIndex(11);
  run(sim, 20000, () => sim.warpIndex === 0 || sim.time > n.time - lead);
  sim.stopWarp();
  sim.autopilot.engage('node', sim);
  let last = 0;
  run(sim, 3000, () => {
    if (trace && sim.time - last > 20 && sim.active.totalThrust > 0) {
      last = sim.time;
      const v = sim.active;
      const eps = v.v.lengthSq() / 2 - v.body.mu / v.r.length();
      log(`   burn t-node=${(sim.time - n.time).toFixed(0)} eps=${eps.toFixed(0)} target=${n.targetEnergy.toFixed(0)} rem=${n.remaining.length().toFixed(1)} thr=${v.controls.throttle.toFixed(2)} T=${(v.totalThrust / 1000).toFixed(0)}kN m=${(v.mass / 1000).toFixed(1)} guidance=${n.guidance} burning=${n.burning} nodes=${sim.nodes.length} err=${(sim.attitude.error * 57.3).toFixed(1)}`);
    }
    return sim.autopilot.mode === 'off';
  });
  const v = sim.active;
  const eps = v.v.lengthSq() / 2 - v.body.mu / v.r.length();
  log(`  node done: "${sim.autopilot.doneMessage}" nodes=${sim.nodes.length} eps=${eps.toFixed(0)} target=${n.targetEnergy.toFixed(0)}`);
}

function coastUntil(sim: FlightSim, cond: () => boolean, maxSimSeconds: number): void {
  const t0 = sim.time;
  sim.setWarpIndex(11);
  for (let i = 0; i < 200000 && sim.time - t0 < maxSimSeconds; i++) {
    sim.update(1 / 60);
    if (cond()) break;
    if (sim.warpIndex < 8) sim.setWarpIndex(11);
  }
  sim.stopWarp();
}

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;

it.skipIf(!env?.env.APOGEE_LONG)('flies a full lunar landing mission and returns the crew', () => {
  const tA = utFromDate(new Date(Date.UTC(2026, 8, 24, 10, 0, 0)));
  const sys = new SolarSystem(tA);
  const win = lunarLaunchWindow(sys, getLaunchSite('cape'), tA);
  const t0 = win.ut;
  sys.update(t0);
  const sim = new FlightSim(sys, TEMPLATES.find((t) => t.id === 'colossus')!.build(), getLaunchSite('cape'), t0);
  sim.autopilot.ascent.targetAltitude = 200_000;
  sim.autopilot.ascent.heading = win.heading;
  sim.autopilot.ascent.planeNormal = win.normal;
  sim.autopilot.engage('ascent', sim);
  run(sim, 1500, () => sim.autopilot.mode === 'off');
  run(sim, 2);
  state(sim, 'parking');
  const w0 = performance.now();
  const r1 = planMoonTransfer(sim);
  log(`TLI plan (${(performance.now() - w0).toFixed(0)} ms): ${r1.message}`);
  if (r1.ok) {
    executeNode(sim, true);
    run(sim, 2);
    state(sim, 'after TLI');
    // coast a little, then correct
    coastUntil(sim, () => false, 6 * 3600);
    run(sim, 2);
    const w2 = performance.now();
    const rc = planCorrection(sim);
    log(`MCC plan (${(performance.now() - w2).toFixed(0)} ms): ${rc.message}`);
    if (rc.ok && rc.node) {
      executeNode(sim);
      run(sim, 2);
      state(sim, 'after MCC');
    }
    {
      const p0 = sim.predictor.patches[0]!;
      log(`  predicted: ${p0.endReason} at +${((p0.endTime - sim.time) / 3600).toFixed(2)}h next=${p0.nextBody?.id}`);
      const moon = sim.system.moon;
      const tEnc = p0.endTime;
      const V = sim.active.r.constructor as unknown as new () => import('three').Vector3;
      const a = new V();
      let lastLog = 0;
      sim.setWarpIndex(11);
      for (let i = 0; i < 300000; i++) {
        sim.update(1 / 60);
        if (sim.warpIndex < 8) sim.setWarpIndex(11);
        if (sim.active.body.id === 'moon') break;
        if (sim.time > tEnc + 7200) break;
        if (Math.abs(sim.time - tEnc) < 20000 && sim.time - lastLog > 1800) {
          lastLog = sim.time;
          moon.relativeStateAt(sim.time, a);
          const d = a.distanceTo(sim.active.r);
          const q0 = sim.predictor.patches[0]!;
          log(`  t-tEnc=${((sim.time - tEnc) / 60).toFixed(1)}min dMoon=${(d / 1000).toFixed(0)}km soi=${(moon.soiRadius / 1000).toFixed(0)} warp=${sim.warpIndex} pred=${q0.endReason}@${((q0.endTime - sim.time) / 60).toFixed(1)}min`);
        }
      }
      sim.stopWarp();
    }
    run(sim, 2);
    state(sim, 'moon SOI');
    const r2 = planCircularize(sim, 'pe');
    log(`LOI plan: ${r2.message}`);
    if (r2.ok) {
      executeNode(sim);
      run(sim, 2);
      state(sim, 'lunar orbit');
      // --- landing
      sim.autopilot.engage('land', sim);
      let lastPhase = '';
      for (let i = 0; i < 3600 * 60 && sim.autopilot.mode !== 'off'; i++) {
        sim.update(1 / 60);
        const ph = sim.autopilot.phase.replace(/[0-9.]+/g, '#');
        const av = sim.active;
        if (av.radarAltitude < 2500 && i % 120 === 0) {
          const up = av.r.clone().normalize();
          const vs = av.surfaceVelocity.dot(up);
          const vhm = av.surfaceVelocity.clone().addScaledVector(up, -vs).length();
          const nose = new (up.constructor as unknown as new (x: number, y: number, z: number) => import('three').Vector3)(0, 1, 0).applyQuaternion(av.q);
          log(`    h=${av.radarAltitude.toFixed(0)} vs=${vs.toFixed(1)} vh=${vhm.toFixed(1)} thr=${av.controls.throttle.toFixed(2)} T=${(av.totalThrust / 1000).toFixed(0)}kN m=${(av.mass / 1000).toFixed(1)} noseUp=${nose.dot(up).toFixed(2)} tgtUp=${sim.autopilot.target.dot(up).toFixed(2)} err=${(sim.attitude.error * 57.3).toFixed(0)} ${sim.autopilot.phase}`);
        }
        if (ph !== lastPhase) {
          lastPhase = ph;
          log(`  land: ${sim.autopilot.phase} alt=${sim.active.radarAltitude.toFixed(0)} vs=${sim.active.surfaceVelocity.length().toFixed(1)} mass=${(sim.active.mass / 1000).toFixed(1)}t`);
        }
        if (sim.active.destroyed) break;
      }
      run(sim, 3);
      log(`  landing result: "${sim.autopilot.doneMessage}" sit=${sim.active.situation} destroyed=${sim.active.destroyed} maxG=${sim.active.maxG.toFixed(1)} parts=${sim.active.parts.length}`);
      state(sim, 'on the Moon');
      // --- ascent back to lunar orbit
      sim.stage();
      run(sim, 1);
      sim.autopilot.ascent.targetAltitude = 40_000;
      sim.autopilot.ascent.heading = 90;
      sim.autopilot.engage('ascent', sim);
      run(sim, 1200, () => sim.autopilot.mode === 'off' || sim.active.destroyed);
      run(sim, 2);
      log(`  ascent: "${sim.autopilot.doneMessage}"`);
      state(sim, 'lunar ascent');
      const w1 = performance.now();
      const r3 = planReturnToEarth(sim);
      log(`TEI plan (${(performance.now() - w1).toFixed(0)} ms): ${r3.message}`);
      if (r3.ok) {
        executeNode(sim);
        run(sim, 2);
        state(sim, 'after TEI');
        coastUntil(sim, () => false, 8 * 3600);
        run(sim, 2);
        const rc2 = planCorrection(sim);
        log(`MCC2 plan: ${rc2.message}`);
        if (rc2.ok && rc2.node) {
          executeNode(sim);
          run(sim, 2);
          state(sim, 'after MCC2');
        }
        coastUntil(sim, () => sim.active.body.id === 'earth', 6 * 86400);
        run(sim, 2);
        state(sim, 'earth SOI');
        // --- re-entry: coast to the atmosphere, drop the service module, heat shield first
        coastUntil(sim, () => sim.active.altitude < 160_000, 4 * 86400);
        sim.stopWarp();
        state(sim, 'entry interface');
        sim.stage(); // separate SM
        run(sim, 1);
        const cap = sim.active;
        cap.controls.sas = true;
        cap.controls.sasMode = 'retrograde';
        cap.controls.speedMode = 'surface';
        let maxHeat = 0;
        let chuted = false;
        for (let i = 0; i < 3600 * 60; i++) {
          sim.update(1 / 60);
          const v = sim.active;
          maxHeat = Math.max(maxHeat, v.heatFlux);
          if (!chuted && v.altitude < 7000 && v.surfaceVelocity.length() < 280) {
            sim.stage();
            chuted = true;
          }
          if (v.destroyed || v.situation === 'splashed' || v.situation === 'landed') break;
          if (i % (60 * 60) === 0) log(`   entry: alt=${(v.altitude / 1000).toFixed(1)}km v=${v.surfaceVelocity.length().toFixed(0)} g=${v.gForce.toFixed(1)} heat=${(v.heatFlux / 1000).toFixed(0)}kW/m2 q=${(v.dynamicPressure / 1000).toFixed(1)}kPa`);
        }
        const v = sim.active;
        log(`  splash: sit=${v.situation} destroyed=${v.destroyed} maxG=${v.maxG.toFixed(1)} maxHeat=${(maxHeat / 1e6).toFixed(2)}MW/m2 speed=${v.surfaceVelocity.length().toFixed(1)} parts=${v.parts.map((p) => p.def.id).join(',')}`);
      }
    }
  }
  if (env?.env.APOGEE_REPORT) env.stderr.write(out.join('\n') + '\n');
  expect(r1.ok).toBe(true);
}, 600_000);
