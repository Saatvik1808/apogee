/**
 * LEARNING NOTE: Reference vehicles
 *
 * These templates are modelled on real launch vehicles scaled to APOGEE's part
 * catalogue: a solid-fuel sounding rocket, an Electron-class small launcher, a
 * Falcon-9-class medium launcher with a crew capsule, a lunar lander probe, and a
 * Saturn-V-class "direct ascent" Moon rocket. Each one is sized with the rocket
 * equation so its Δv budget covers its mission — study them in the assembly
 * building to see how real designers balance thrust, Isp and mass.
 *
 * Key concepts: mission Δv budgets, stage sizing, reference designs
 */
import {
  applyAutoStagingSafe,
  CraftBuilder,
} from './CraftBuilder';
import type { CraftData } from './Craft';
import { getPartDef } from './PartCatalog';

/**
 * Auto-staging fires parachutes last. A Mars lander wants them BEFORE the final
 * stage (heat-shield jettison + descent-engine ignition): swap the last two stages.
 */
function reorderChuteBeforeLast(c: CraftData): void {
  const max = c.parts.reduce((m, p) => Math.max(m, p.stage), -1);
  if (max < 1) return;
  const last = c.parts.filter((p) => p.stage === max);
  if (!last.every((p) => !!getPartDef(p.defId).parachute)) return;
  for (const p of c.parts) {
    if (p.stage === max) p.stage = max - 1;
    else if (p.stage === max - 1) p.stage = max;
  }
  c.manualStaging = true;
}

export interface CraftTemplate {
  id: string;
  name: string;
  tagline: string;
  build: () => CraftData;
}

export const TEMPLATES: CraftTemplate[] = [
  {
    id: 'pathfinder',
    name: 'Pathfinder',
    tagline: 'Solid-fuel sounding rocket. Goes straight up, comes down under a parachute.',
    build: () => {
      const b = new CraftBuilder('Pathfinder', 'Sounding rocket: probe core, parachute and a single Pip SRB.');
      const core = b.root('probe-sentinel');
      b.above(core, 'chute-main', { canopies: 1 });
      const dec = b.below(core, 'decoupler-stack', { diameter: 1.25 });
      const srb = b.below(dec, 'srb-pip', { thrustLimit: 1 });
      b.radial(srb, 'fin-small', 3, -1.6);
      return applyAutoStagingSafe(b.craft);
    },
  },
  {
    id: 'sprite',
    name: 'Sprite',
    tagline: 'Two-stage small-satellite launcher. ~300 kg to low Earth orbit.',
    build: () => {
      const b = new CraftBuilder('Sprite', 'Electron-class kerolox launcher with nine Rotor-1 engines.');
      const core = b.root('probe-sentinel');
      b.above(core, 'nosecone', { diameter: 1.25 });
      const t2 = b.below(core, 'tank-125', { length: 2.5, propellant: 'kerolox' });
      const e2 = b.below(t2, 'eng-rotor-vac', { cluster: 1 });
      const dec = b.below(e2, 'decoupler-stack', { diameter: 1.25 });
      const t1 = b.below(dec, 'tank-125', { length: 10.5, propellant: 'kerolox' });
      b.below(t1, 'eng-rotor', { cluster: 9 });
      return applyAutoStagingSafe(b.craft);
    },
  },
  {
    id: 'heron',
    name: 'Heron 9 · Kestrel',
    tagline: 'Medium launcher with a two-seat capsule and service module. Orbit and return.',
    build: () => {
      const b = new CraftBuilder('Heron 9 Kestrel', 'Falcon-9-class two-stage kerolox launcher carrying a Kestrel capsule.');
      const cap = b.root('capsule-kestrel');
      b.above(cap, 'chute-main', { canopies: 2 });
      const hs = b.below(cap, 'heatshield', { diameter: 2.5 });
      const decSM = b.below(hs, 'decoupler-stack', { diameter: 2.5 });
      const sm = b.below(decSM, 'tank-250', { length: 0.75, propellant: 'hypergolic' });
      b.radial(sm, 'solar-panel', 2, 0, Math.PI / 2);
      const smEng = b.below(sm, 'eng-kestrel-sps', { cluster: 1 });
      const dec2 = b.below(smEng, 'decoupler-stack', { diameter: 2.5 });
      const ad = b.below(dec2, 'adapter', { diameter: 2.5, diameterBottom: 3.75 });
      const t2 = b.below(ad, 'tank-375', { length: 10.5, propellant: 'kerolox' });
      const e2 = b.below(t2, 'eng-hawk-vac', { cluster: 1 });
      const dec1 = b.below(e2, 'decoupler-stack', { diameter: 3.75 });
      const t1 = b.below(dec1, 'tank-375', { length: 39, propellant: 'kerolox' });
      b.below(t1, 'eng-hawk', { cluster: 9 });
      return applyAutoStagingSafe(b.craft);
    },
  },
  {
    id: 'heron-lander',
    name: 'Heron 9 · Selene Lander',
    tagline: 'Uncrewed lunar lander on a medium launcher. Soft-land on the Moon.',
    build: () => {
      const b = new CraftBuilder('Heron 9 Selene', 'Robotic lunar lander: hypergolic descent stage with deep-throttling engine and legs.');
      const core = b.root('probe-sentinel');
      b.radial(core, 'solar-panel', 2, 0, 0);
      const tank = b.below(core, 'tank-250', { length: 1.25, propellant: 'hypergolic' });
      b.radial(tank, 'leg-large', 4, -0.3, Math.PI / 4);
      const eng = b.below(tank, 'eng-moth', { cluster: 1 });
      const dec2 = b.below(eng, 'decoupler-stack', { diameter: 2.5 });
      const fair = b.below(dec2, 'adapter', { diameter: 2.5, diameterBottom: 3.75 });
      const t2 = b.below(fair, 'tank-375', { length: 10.5, propellant: 'kerolox' });
      const e2 = b.below(t2, 'eng-hawk-vac', { cluster: 1 });
      const dec1 = b.below(e2, 'decoupler-stack', { diameter: 3.75 });
      const t1 = b.below(dec1, 'tank-375', { length: 39, propellant: 'kerolox' });
      b.below(t1, 'eng-hawk', { cluster: 9 });
      return applyAutoStagingSafe(b.craft);
    },
  },
  {
    id: 'nimbus',
    name: 'Heron 9 · Nimbus',
    tagline: 'Medium launcher with a weather satellite and its own kick stage. Polar and sun-synchronous orbits.',
    build: () => {
      const b = new CraftBuilder('Heron 9 Nimbus', 'Falcon-9-class launcher carrying the Nimbus weather satellite: probe core, solar arrays and a Rotor-1 Vac kick stage for orbit trims.');
      const core = b.root('probe-sentinel');
      b.radial(core, 'solar-panel', 2, 0, 0);
      b.above(core, 'nosecone', { diameter: 1.25 });
      const kt = b.below(core, 'tank-125', { length: 1.5, propellant: 'kerolox' });
      const ke = b.below(kt, 'eng-rotor-vac', { cluster: 1 });
      const dec2 = b.below(ke, 'decoupler-stack', { diameter: 1.25 });
      const ad = b.below(dec2, 'adapter', { diameter: 1.25, diameterBottom: 3.75 });
      const t2 = b.below(ad, 'tank-375', { length: 10.5, propellant: 'kerolox' });
      const e2 = b.below(t2, 'eng-hawk-vac', { cluster: 1 });
      const dec1 = b.below(e2, 'decoupler-stack', { diameter: 3.75 });
      const t1 = b.below(dec1, 'tank-375', { length: 39, propellant: 'kerolox' });
      b.below(t1, 'eng-hawk', { cluster: 9 });
      return applyAutoStagingSafe(b.craft);
    },
  },
  {
    id: 'ares',
    name: 'Colossus · Ares',
    tagline: 'Heavy launcher, hydrogen transfer stage and a Mars lander with heat shield, parachute and legs.',
    build: () => {
      const b = new CraftBuilder(
        'Colossus Ares',
        'Mars mission: Ares lander (heat shield, parachutes, Moth descent engine, legs) on a twin-Wren hydrogen transfer stage, launched by a four-Titan / five-Vega heavy lifter.',
      );
      const core = b.root('probe-sentinel');
      b.above(core, 'chute-main', { canopies: 3 });
      b.radial(core, 'solar-panel', 2, 0, 0);
      const lt = b.below(core, 'tank-250', { length: 1.25, propellant: 'hypergolic' });
      b.radial(lt, 'leg-large', 4, -0.3, Math.PI / 4);
      const le = b.below(lt, 'eng-moth', { cluster: 1 });
      const decHS = b.below(le, 'decoupler-stack', { diameter: 3.75 });
      const hs = b.below(decHS, 'heatshield', { diameter: 3.75 });
      const decC = b.below(hs, 'decoupler-stack', { diameter: 3.75 });
      const tt = b.below(decC, 'tank-375', { length: 7, propellant: 'hydrolox' });
      const te = b.below(tt, 'eng-wren', { cluster: 2 });
      const dec2 = b.below(te, 'decoupler-stack', { diameter: 3.75 });
      const ad2 = b.below(dec2, 'adapter', { diameter: 3.75, diameterBottom: 7.5 });
      const t2 = b.below(ad2, 'tank-750', { length: 16, propellant: 'hydrolox' });
      const e2 = b.below(t2, 'eng-vega', { cluster: 5 });
      const dec1 = b.below(e2, 'decoupler-stack', { diameter: 7.5 });
      const t1 = b.below(dec1, 'tank-750', { length: 34, propellant: 'kerolox' });
      b.below(t1, 'eng-titan', { cluster: 4 });
      b.radial(t1, 'fin-large', 4, -15.2, Math.PI / 4);
      const craft = applyAutoStagingSafe(b.craft);
      // Entry, descent and landing order: parachute first, then drop the heat shield and light the descent engine
      reorderChuteBeforeLast(craft);
      return craft;
    },
  },
  {
    id: 'colossus',
    name: 'Colossus · Condor',
    tagline: 'Saturn-V-class heavy lifter. Three crew, lunar landing and return.',
    build: () => {
      const b = new CraftBuilder(
        'Colossus Condor',
        'Direct-ascent Moon ship: 7×Titan F-1 first stage, 9×Vega J-2X second stage, twin-J-2X TLI stage, hypergolic lunar descent stage and a Condor capsule with its return module.',
      );
      const cap = b.root('capsule-condor');
      b.above(cap, 'chute-main', { canopies: 3 });
      const hs = b.below(cap, 'heatshield', { diameter: 3.75 });
      const decSM = b.below(hs, 'decoupler-stack', { diameter: 3.75 });
      const sm = b.below(decSM, 'tank-375', { length: 1.5, propellant: 'hypergolic' });
      b.radial(sm, 'solar-panel', 2, 0, Math.PI / 2);
      const smEng = b.below(sm, 'eng-kestrel-sps', { cluster: 1 });
      const decD = b.below(smEng, 'decoupler-stack', { diameter: 5 });
      const dTank = b.below(decD, 'tank-500', { length: 3.6, propellant: 'hypergolic' });
      b.radial(dTank, 'leg-large', 4, -0.5, Math.PI / 4);
      const dEng = b.below(dTank, 'eng-moth', { cluster: 4 });
      const decT = b.below(dEng, 'decoupler-stack', { diameter: 5 });
      const adT = b.below(decT, 'adapter', { diameter: 5, diameterBottom: 7.5 });
      const t3 = b.below(adT, 'tank-750', { length: 17, propellant: 'hydrolox' });
      const e3 = b.below(t3, 'eng-vega', { cluster: 2 });
      const dec2 = b.below(e3, 'decoupler-stack', { diameter: 7.5 });
      const ad2 = b.below(dec2, 'adapter', { diameter: 7.5, diameterBottom: 10 });
      const t2 = b.below(ad2, 'tank-1000', { length: 28, propellant: 'hydrolox' });
      const e2 = b.below(t2, 'eng-vega', { cluster: 9 });
      const dec1 = b.below(e2, 'decoupler-stack', { diameter: 10 });
      const t1 = b.below(dec1, 'tank-1000', { length: 40, propellant: 'kerolox' });
      b.below(t1, 'eng-titan', { cluster: 7 });
      b.radial(t1, 'fin-large', 4, -18.2, Math.PI / 4);
      return applyAutoStagingSafe(b.craft);
    },
  },
];
