/**
 * LEARNING NOTE: A tiny builder DSL for rockets
 *
 * Writing part trees by hand (uids, parents, attach modes) is error-prone. A
 * builder with `below`, `above` and `radial` methods reads like a parts list and
 * guarantees a valid tree. `radial` creates a symmetry group so the copies behave
 * as one in the editor.
 *
 * Key concepts: builder pattern, fluent APIs, symmetry groups
 */
import { createEmptyCraft, layoutCraft, newPart, type CraftData } from './Craft';
import type { PartConfig } from './PartCatalog';
import { applyAutoStaging } from './Staging';

export class CraftBuilder {
  readonly craft: CraftData;

  constructor(name: string, description = '') {
    this.craft = createEmptyCraft(name);
    this.craft.description = description;
  }

  root(defId: string, cfg?: PartConfig): number {
    const p = newPart(this.craft, defId, -1, 'root', cfg);
    this.craft.parts.push(p);
    return p.uid;
  }

  below(parent: number, defId: string, cfg?: PartConfig): number {
    const p = newPart(this.craft, defId, parent, 'below');
    if (cfg) Object.assign(p.config, cfg);
    this.craft.parts.push(p);
    return p.uid;
  }

  above(parent: number, defId: string, cfg?: PartConfig): number {
    const p = newPart(this.craft, defId, parent, 'above');
    if (cfg) Object.assign(p.config, cfg);
    this.craft.parts.push(p);
    return p.uid;
  }

  /** Radial copies in symmetry around `parent`'s axis. Returns their uids. */
  radial(parent: number, defId: string, count: number, offsetY: number, angle0 = 0, cfg?: PartConfig): number[] {
    const sym = count > 1 ? this.craft.nextSymmetry++ : 0;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = newPart(this.craft, defId, parent, 'radial');
      if (cfg) Object.assign(p.config, cfg);
      p.angle = angle0 + (i / count) * Math.PI * 2;
      p.offsetY = offsetY;
      p.symmetry = sym;
      this.craft.parts.push(p);
      out.push(p.uid);
    }
    return out;
  }
}

export function applyAutoStagingSafe(c: CraftData): CraftData {
  const layout = layoutCraft(c);
  applyAutoStaging(c, layout);
  return c;
}
