/**
 * LEARNING NOTE: Verifying mission budgets
 *
 * A template rocket is only useful if its Δv budget actually covers its mission.
 * This test runs every template through the same stage analyser the assembly
 * building uses and checks liftoff thrust-to-weight and total Δv against the
 * mission requirements (≈9.4 km/s to orbit, ≈18 km/s for a direct-ascent Moon
 * landing and return).
 *
 * Key concepts: design verification, Δv budgets
 */
import { describe, expect, it } from 'vitest';
import { layoutCraft, totalCost } from '../src/parts/Craft';
import { analyzeStages, simPartsFromLayout, totalDv } from '../src/parts/DeltaV';
import { planStages } from '../src/parts/Staging';
import { TEMPLATES } from '../src/parts/Templates';

function report(id: string) {
  const t = TEMPLATES.find((x) => x.id === id)!;
  const craft = t.build();
  const layout = layoutCraft(craft);
  const stages = analyzeStages(simPartsFromLayout(craft, layout), 0, 9.80665);
  const lines = stages.map(
    (s) =>
      `  stage ${s.stage}: dv ${s.dvVac.toFixed(0)} (SL ${s.dvSL.toFixed(0)}) m/s, TWR ${s.twrSL.toFixed(2)} (vac ${s.twrVac.toFixed(2)}), burn ${s.burnTime.toFixed(0)} s, mass ${(s.startMass / 1000).toFixed(1)}→${(s.endMass / 1000).toFixed(1)} t`,
  );
  const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
  if (env?.env.APOGEE_REPORT) env.stderr.write(`${t.name}: ${craft.parts.length} parts, $${(totalCost(layout) / 1e6).toFixed(1)}M\n${lines.join('\n')}\n  total ${totalDv(stages).toFixed(0)} m/s\n`);
  return { craft, layout, stages };
}

describe('Templates', () => {
  it('Pathfinder can reach space', () => {
    const { stages } = report('pathfinder');
    expect(stages[0]!.twrSL).toBeGreaterThan(1.5);
    expect(totalDv(stages)).toBeGreaterThan(1500);
  });

  it('Sprite reaches orbit', () => {
    const { stages } = report('sprite');
    expect(stages[0]!.twrSL).toBeGreaterThan(1.1);
    expect(totalDv(stages)).toBeGreaterThan(9300);
  });

  it('Heron stages in the right order', () => {
    const { craft, layout, stages } = report('heron');
    const plan = planStages(craft, layout);
    const names = plan.map((s) => s.map((u) => layout.get(u)!.def.id).sort().join('+'));
    expect(names[0]).toBe('eng-hawk');
    expect(names[1]).toBe('decoupler-stack+eng-hawk-vac');
    expect(names[names.length - 1]).toBe('chute-main');
    expect(stages[0]!.twrSL).toBeGreaterThan(1.2);
    expect(totalDv(stages)).toBeGreaterThan(11000);
  });

  it('Heron Selene lander has lunar landing budget', () => {
    const { stages } = report('heron-lander');
    expect(totalDv(stages)).toBeGreaterThan(14000);
  });

  it('Colossus can fly a direct-ascent lunar mission', () => {
    const { stages } = report('colossus');
    expect(stages[0]!.twrSL).toBeGreaterThan(1.1);
    expect(totalDv(stages)).toBeGreaterThan(18000);
  });
});
