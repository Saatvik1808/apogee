/**
 * LEARNING NOTE: A rocket editor — data first, pixels second
 *
 * Everything the player does in the assembly building edits one small data
 * structure: the part TREE (`CraftData`). The 3D hangar, the staging list and the
 * Δv read-outs are all *derived* from it and simply rebuilt after each edit.
 * That makes features like undo/redo trivial: an undo stack is just a list of
 * serialised trees.
 *
 * Building uses a "held part" model: pick a part (from the catalog, or grab one
 * off the rocket), then click a glowing attach node (stack) or a part's surface
 * (radial, with optional N-fold symmetry). Staging is planned automatically by
 * walking the tree from the bottom up — engines light before the decoupler above
 * them fires — until the player drags parts between stages manually.
 *
 * The numbers teach rocketry: Δv per stage from the Tsiolkovsky equation
 * (Δv = Isp·g₀·ln(m₀/m₁)), thrust-to-weight (must exceed 1 to lift off), burn
 * time, and the ~9.4 km/s needed to reach low Earth orbit.
 *
 * Key concepts: model–view separation, undo stacks, trees, picking, symmetry,
 * the rocket equation, staging
 */
import { PerspectiveCamera, Quaternion, Vector2, Vector3 } from 'three';
import {
  cloneCraft,
  createEmptyCraft,
  deserializeCraft,
  findPart,
  layoutCraft,
  rootPart,
  serializeCraft,
  subtreeUids,
  symmetryCounterparts,
  totalCost,
  type CraftData,
  type CraftPart,
  type PartLayout,
} from '../parts/Craft';
import { CATEGORY_LABELS, PART_DEFS, computePartStats, defaultConfig, getPartDef, type PartCategory, type PartConfig, type PartDef } from '../parts/PartCatalog';
import { PROPELLANTS, type PropellantId } from '../parts/Propellants';
import { applyAutoStaging, normalizeStaging, stagesFromCraft } from '../parts/Staging';
import { analyzeStages, simPartsFromLayout, totalDv, type StageInfo } from '../parts/DeltaV';
import { TEMPLATES } from '../parts/Templates';
import { formatMoney } from '../core/math';
import { h, clear, setText } from '../ui/dom';
import { LAUNCH_SITES } from '../world/LaunchSites';
import type { AtmosphereFrame } from '../render/post/AtmospherePass';
import type { CompositeFrame } from '../render/post/PostFX';
import type { GameContext, GameState } from './GameContext';
import { MISSIONS, type LaunchTimeOfDay, type MissionDef } from './Missions';
import { writeSave } from './Save';
import { VABScene, type AttachNode } from './vab/VABScene';
import { renderThumbnails, thumbnailFor } from './vab/PartThumbnails';
import '../ui/vab.css';

export interface VABParams {
  mission: MissionDef | null;
  craft: CraftData | null;
  onLaunch(craft: CraftData, siteId: string, tod: LaunchTimeOfDay): void;
  onExit(): void;
}

/** A detached group of parts being carried by the cursor. */
interface Held {
  parts: CraftPart[];
  root: number;
}

interface RadialTarget {
  parent: number;
  angle: number;
  offsetY: number;
}

const G0 = 9.80665;
const CATEGORIES: PartCategory[] = ['command', 'tanks', 'engines', 'boosters', 'coupling', 'structural', 'aero', 'recovery', 'utility'];
const CATEGORY_ICONS: Record<PartCategory, string> = {
  command: '<path d="M12 3l5 9v6H7v-6z"/><circle cx="12" cy="11" r="1.6"/>',
  tanks: '<rect x="7" y="3" width="10" height="18" rx="3"/><path d="M7 9h10M7 15h10"/>',
  engines: '<path d="M9 3h6v5l3 9H6l3-9z"/><path d="M9 20l3 2 3-2"/>',
  boosters: '<rect x="9" y="2" width="6" height="16" rx="1"/><path d="M9 18l-2 4h10l-2-4"/>',
  coupling: '<rect x="5" y="9" width="14" height="6" rx="1"/><path d="M5 12h14M9 9v6M15 9v6"/>',
  structural: '<path d="M4 20L12 4l8 16z"/><path d="M8 12h8"/>',
  aero: '<path d="M12 2c3 4 4 8 4 12H8c0-4 1-8 4-12z"/><path d="M8 14l-4 6h4M16 14l4 6h-4"/>',
  recovery: '<path d="M3 11a9 7 0 0118 0z"/><path d="M4 11l8 10 8-10M12 11v10"/>',
  utility: '<rect x="3" y="9" width="7" height="6"/><rect x="14" y="9" width="7" height="6"/><path d="M10 12h4"/>',
};
const SYMMETRY_STEPS = [1, 2, 3, 4, 6, 8];
const TODS: Array<[LaunchTimeOfDay, string]> = [
  ['dawn', 'Dawn'],
  ['morning', 'Morning'],
  ['noon', 'Noon'],
  ['dusk', 'Dusk'],
  ['night', 'Night'],
  ['lunar', 'Lunar window'],
];

const _v = new Vector3();
const _qInv = new Quaternion();
const _ndc = new Vector2();

function svg(paths: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${paths}</svg>`;
}

function fmtMass(kg: number): string {
  return kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 100_000 ? 0 : 1)} t` : `${kg.toFixed(0)} kg`;
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${Math.round(s % 60)}s` : `${s.toFixed(0)}s`;
}

export class VABState implements GameState {
  private readonly ctx: GameContext;
  private readonly params: VABParams;
  private craft: CraftData;
  private readonly vab: VABScene;
  private readonly camera: PerspectiveCamera;
  private readonly atmFrame: AtmosphereFrame;
  private readonly compFrame: CompositeFrame;
  // editing state
  private readonly undoStack: string[] = [];
  private readonly redoStack: string[] = [];
  private selected: number | null = null;
  private hovered: number | null = null;
  private held: Held | null = null;
  private nodes: AttachNode[] = [];
  private hotNode: AttachNode | null = null;
  private radial: RadialTarget | null = null;
  private ghostKey = '';
  private symmetry = 1;
  private category: PartCategory = 'command';
  private siteId: string;
  private tod: LaunchTimeOfDay;
  private readonly maxTier: number;
  private layout: Map<number, PartLayout> = new Map();
  private stages: StageInfo[] = [];
  // camera orbit
  private yaw = 0.6;
  private pitch = 0.16;
  private dist = 40;
  private distTarget = 40;
  private focusY = 10;
  private focusTarget = 10;
  // pointer
  private pointerX = 0;
  private pointerY = 0;
  private downX = 0;
  private downY = 0;
  private downButton = -1;
  private pointerDirty = true;
  private t = 0;
  // DOM
  private readonly root: HTMLDivElement;
  private readonly catalogTabs: HTMLDivElement;
  private readonly catalogGrid: HTMLDivElement;
  private readonly catalogInfo: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly stagesEl: HTMLDivElement;
  private readonly inspector: HTMLDivElement;
  private readonly warnEl: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly hint: HTMLDivElement;
  private readonly symBtn: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly overlay: HTMLDivElement;
  private readonly touchBar: HTMLDivElement;
  private readonly cleanup: Array<() => void> = [];

  constructor(ctx: GameContext, params: VABParams) {
    this.ctx = ctx;
    this.params = params;
    const m = params.mission;
    this.siteId = m?.site ?? 'cape';
    this.tod = m?.timeOfDay ?? 'morning';
    this.maxTier = this.unlockedTier();
    this.craft = this.initialCraft();
    this.camera = ctx.renderer.camera;
    this.vab = new VABScene(ctx.renderer.gl, ctx.assets, { enabled: ctx.renderer.shadowsEnabled, size: ctx.renderer.shadowSize });
    this.atmFrame = { ...ctx.space.atmFrame, enabled: false, cloudsEnabled: false };
    this.compFrame = {
      exposure: 1.05,
      sunUV: new Vector2(0.5, 0.5),
      sunOnScreen: false,
      flare: 0,
      flareTint: new Vector3(1, 1, 1),
      time: 0,
      fade: 1,
    };
    renderThumbnails(ctx.renderer.gl, this.vab.scene.environment, PART_DEFS);

    // ------------------------------------------------------------------ DOM
    this.catalogTabs = h('div', { class: 'vab-tabs' });
    this.catalogGrid = h('div', { class: 'vab-grid' });
    this.catalogInfo = h('div', { class: 'vab-cat-info' });
    this.statsEl = h('div', { class: 'vab-stats' });
    this.stagesEl = h('div', { class: 'vab-stages' });
    this.inspector = h('div', { class: 'vab-inspector' });
    this.warnEl = h('div', { class: 'vab-warn' });
    this.hint = h('div', { class: 'vab-hint mono' });
    this.overlay = h('div', { class: 'overlay', style: 'display:none' });
    this.nameInput = h('input', {
      class: 'vab-name',
      value: this.craft.name,
      attrs: { maxlength: '40', spellcheck: 'false' },
      onInput: () => (this.craft.name = this.nameInput.value || 'Untitled Rocket'),
    });
    this.symBtn = h('button', { class: 'btn small', title: 'Radial symmetry (X)', onClick: () => this.cycleSymmetry() });
    this.undoBtn = h('button', { class: 'btn small ghost', html: '↶', title: 'Undo (Ctrl+Z)', onClick: () => this.undo() });
    this.redoBtn = h('button', { class: 'btn small ghost', html: '↷', title: 'Redo (Ctrl+Shift+Z)', onClick: () => this.redo() });
    const top = h(
      'div',
      { class: 'vab-top card' },
      h('button', { class: 'btn small ghost', text: '← Menu', onClick: () => this.exit() }),
      h('div', { class: 'vab-title' }, h('span', { class: 'vab-kicker', text: m ? `Mission · ${m.title}` : 'Vehicle Assembly' }), this.nameInput),
      h('div', { class: 'vab-top-actions' },
        h('button', { class: 'btn small', text: 'New', onClick: () => this.newCraft() }),
        h('button', { class: 'btn small', text: 'Open', onClick: () => this.showOpen() }),
        h('button', { class: 'btn small', text: 'Save', onClick: () => this.saveCraft() }),
        this.undoBtn,
        this.redoBtn,
        h('span', { class: 'vab-sep' }),
        this.symBtn,
        h('button', { class: 'btn small vab-stats-toggle', text: 'Δv', title: 'Vehicle stats & staging', onClick: () => this.root.classList.toggle('show-right') }),
      ),
      h('button', { class: 'btn primary vab-launch', text: 'Launch ▸', onClick: () => this.showLaunch() }),
    );
    const left = h(
      'div',
      { class: 'vab-left card' },
      h('div', { class: 'card-h' }, h('span', { text: 'Parts' }), h('span', { class: 'accent', text: `${PART_DEFS.length}` })),
      this.catalogTabs,
      this.catalogGrid,
      this.catalogInfo,
    );
    const right = h(
      'div',
      { class: 'vab-right' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('span', { text: 'Vehicle' }), h('span', { class: 'accent', text: 'Δv' })), this.statsEl, this.warnEl),
      h('div', { class: 'card vab-stage-card' },
        h('div', { class: 'card-h' }, h('span', { text: 'Staging' }), h('button', { class: 'btn small ghost', text: 'Auto', title: 'Reset to automatic staging', onClick: () => this.autoStage() })),
        this.stagesEl,
      ),
      this.inspector,
    );
    // Touch: actions for the selected / held part (no keyboard shortcuts on a phone)
    const tb = (label: string, title: string, fn: () => void, cls = '') => h('button', { class: `btn small ${cls}`, text: label, title, onClick: () => (ctx.platform.haptic('tick'), fn()) });
    this.touchBar = h('div', { class: 'vab-touchbar card' },
      tb('Move', 'Pick up the selected part', () => this.grabSelected(), 'sel'),
      tb('Copy', 'Duplicate the selected part', () => this.duplicateSelected(), 'sel'),
      tb('Delete', 'Delete the selected part', () => this.deleteSelected(), 'sel danger'),
      tb('Drop', 'Put the held part back', () => this.dropHeld(), 'hold'),
      tb('Symmetry', 'Cycle radial symmetry', () => this.cycleSymmetry(), 'hold'),
    );
    this.root = h('div', { class: `vab${ctx.platform.touch ? ' touch' : ''}` }, top, left, right, this.hint, this.touchBar, this.overlay);
    if (m) {
      right.prepend(
        h('div', { class: 'card vab-mission' },
          h('div', { class: 'card-h' }, h('span', { text: 'Mission brief' }), h('span', { class: 'accent', text: '★'.repeat(m.difficulty) })),
          h('div', { class: 'vab-mission-body' },
            h('div', { class: 'vm-title', text: m.title }),
            h('ol', {}, ...m.objectives.map((o) => h('li', { text: o.text }))),
            h('button', { class: 'btn small', text: `Load reference design`, onClick: () => this.loadTemplate(m.template) }),
          ),
        ),
      );
    }
    ctx.ui.appendChild(this.root);
    this.buildTabs();
    this.buildCatalog();
    this.updateSymBtn();

    // ------------------------------------------------------------------ input
    const canvas = ctx.renderer.canvas;
    const onDown = (e: PointerEvent) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.downButton = e.button;
    };
    const onMove = (e: PointerEvent) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointerDirty = true;
    };
    const onUp = (e: PointerEvent) => {
      // Finger taps are recognised by Input (it also filters out pinches)
      if (e.pointerType === 'touch') return;
      if (this.downButton !== e.button) return;
      const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
      this.downButton = -1;
      if (moved > 5) return;
      if (e.button === 0) this.click();
      else if (e.button === 2) this.dropHeld();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
    });
    this.cleanup.push(ctx.input.onKey((code, e) => this.onKey(code, e)));
    this.cleanup.push(
      ctx.platform.pushBack(() => {
        if (this.overlay.style.display !== 'none') this.hideOverlay();
        else if (this.root.classList.contains('show-right')) this.root.classList.remove('show-right');
        else if (this.held) this.dropHeld();
        else if (this.selected !== null) this.select(null);
        else this.exit();
        return true;
      }),
    );

    this.rebuild(true);
    this.frameCraft(true);
    ctx.audio.setMusicIntensity(0.5);
  }

  // =================================================================== setup

  private unlockedTier(): number {
    if (!this.params.mission) return 99;
    let tier = 0;
    for (const id of this.ctx.save.campaign.completed) {
      const m = MISSIONS.find((x) => x.id === id);
      if (m) tier = Math.max(tier, m.unlocksTier);
    }
    return tier;
  }

  private initialCraft(): CraftData {
    if (this.params.craft) return cloneCraft(this.params.craft);
    const last = this.ctx.save.lastCraft ? deserializeCraft(this.ctx.save.lastCraft) : null;
    if (!this.params.mission && last) return last;
    const tplId = this.params.mission?.template ?? 'sprite';
    const t = TEMPLATES.find((x) => x.id === tplId) ?? TEMPLATES[0]!;
    return t.build();
  }

  // =================================================================== catalog

  private buildTabs(): void {
    clear(this.catalogTabs);
    for (const c of CATEGORIES) {
      const count = PART_DEFS.filter((d) => d.category === c).length;
      if (!count) continue;
      this.catalogTabs.appendChild(
        h('button', {
          class: `vab-tab${c === this.category ? ' on' : ''}`,
          title: CATEGORY_LABELS[c],
          html: svg(CATEGORY_ICONS[c]),
          onClick: () => {
            this.category = c;
            this.buildTabs();
            this.buildCatalog();
          },
        }),
      );
    }
  }

  private buildCatalog(): void {
    clear(this.catalogGrid);
    this.catalogGrid.appendChild(h('div', { class: 'vab-grid-h', text: CATEGORY_LABELS[this.category] }));
    for (const def of PART_DEFS) {
      if (def.category !== this.category) continue;
      const locked = def.tier > this.maxTier;
      const thumb = thumbnailFor(def);
      const card = h(
        'div',
        {
          class: `vab-part${locked ? ' locked' : ''}`,
          title: locked ? 'Unlocked by later campaign missions' : def.description,
          onClick: () => {
            if (locked) return;
            this.ctx.audio.click();
            this.holdNew(def);
          },
          onPointerEnter: () => this.showPartInfo(def),
          onPointerLeave: () => clear(this.catalogInfo),
        },
        thumb ? h('img', { attrs: { src: thumb, alt: def.name, draggable: 'false' } }) : h('div', { class: 'vab-noimg' }),
        h('div', { class: 'vp-name', text: def.name }),
        h('div', { class: 'vp-sub mono', text: this.partSubline(def) }),
        locked ? h('div', { class: 'vp-lock', text: '🔒' }) : null,
      );
      this.catalogGrid.appendChild(card);
    }
  }

  private partSubline(def: PartDef): string {
    const st = computePartStats(def, {});
    if (def.engine) return `${(st.thrustVac / 1000).toFixed(0)} kN · ${st.ispVac.toFixed(0)} s`;
    if (def.solid) return `${(st.thrustSL / 1000).toFixed(0)} kN · ${fmtMass(st.propellantCapacity)}`;
    if (def.tank) return `${def.diameter} m · ${fmtMass(st.propellantCapacity)}`;
    if (def.command) return def.command.crew ? `${def.command.crew} crew` : 'uncrewed';
    return `${def.diameter} m · ${fmtMass(def.dryMass)}`;
  }

  private showPartInfo(def: PartDef): void {
    clear(this.catalogInfo);
    const st = computePartStats(def, {});
    const rows: Array<[string, string]> = [
      ['Mass', fmtMass(st.dryMass + (st.propellant ? st.propellantCapacity : 0))],
      ['Cost', formatMoney(def.cost)],
    ];
    if (def.engine) {
      rows.push(['Thrust (vac)', `${(st.thrustVac / 1000).toFixed(0)} kN`], ['Isp vac / SL', `${st.ispVac.toFixed(0)} / ${st.ispSL.toFixed(0)} s`], ['Propellant', PROPELLANTS[def.engine.propellant as PropellantId]?.name ?? def.engine.propellant]);
    }
    if (st.propellant) rows.push(['Propellant', `${fmtMass(st.propellantCapacity)} ${PROPELLANTS[st.propellant].name}`]);
    if (def.command?.crew) rows.push(['Crew', String(def.command.crew)]);
    this.catalogInfo.appendChild(h('div', { class: 'vci-name', text: def.name }));
    this.catalogInfo.appendChild(h('div', { class: 'vci-desc', text: def.description }));
    for (const [k, v] of rows) this.catalogInfo.appendChild(h('div', { class: 'vci-row' }, h('span', { text: k }), h('span', { class: 'mono', text: v })));
  }

  // =================================================================== editing

  private snapshot(): string {
    return serializeCraft(this.craft);
  }

  private pushUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.craft = deserializeCraft(s) ?? this.craft;
    this.selected = null;
    this.rebuild();
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.craft = deserializeCraft(s) ?? this.craft;
    this.selected = null;
    this.rebuild();
  }

  private holdNew(def: PartDef, cfg?: PartConfig): void {
    const part: CraftPart = { uid: 1, defId: def.id, parent: -1, attach: 'root', angle: 0, offsetY: 0, symmetry: 0, config: cfg ? { ...cfg } : this.defaultConfigFor(def), stage: -1 };
    this.held = { parts: [part], root: 1 };
    this.selected = null;
    this.refreshHeld();
  }

  /** New parts inherit the diameter of the selected part when it fits. */
  private defaultConfigFor(def: PartDef): PartConfig {
    const cfg = defaultConfig(def);
    const s = def.configurable;
    const sel = this.selected !== null ? this.layout.get(this.selected) : undefined;
    if (sel && s?.diameter) {
      const d = sel.stats.diameterBottom || sel.stats.diameterTop;
      if (s.diameter.includes(d)) cfg.diameter = d;
    }
    return cfg;
  }

  private dropHeld(): void {
    if (!this.held) return;
    this.held = null;
    this.refreshHeld();
  }

  /** Take the selected part (and everything attached below it) off the rocket. */
  private grabSelected(): void {
    if (this.selected === null) return;
    const p = findPart(this.craft, this.selected);
    if (!p) return;
    this.pushUndo();
    this.held = this.extract(p.uid, true);
    this.selected = null;
    this.afterEdit();
    this.refreshHeld();
  }

  private duplicateSelected(): void {
    if (this.selected === null) return;
    this.held = this.extract(this.selected, false);
    this.selected = null;
    this.refreshHeld();
  }

  private deleteSelected(): void {
    if (this.selected === null) return;
    const p = findPart(this.craft, this.selected);
    if (!p) return;
    this.pushUndo();
    const victims = [p, ...symmetryCounterparts(this.craft, p)];
    const ids = new Set<number>();
    for (const v of victims) for (const u of subtreeUids(this.craft, v.uid)) ids.add(u);
    this.craft.parts = this.craft.parts.filter((x) => !ids.has(x.uid));
    this.selected = null;
    this.ctx.audio.click();
    this.afterEdit();
  }

  /** Copy (and optionally remove) a subtree as a held fragment. */
  private extract(uid: number, remove: boolean): Held {
    const ids = subtreeUids(this.craft, uid);
    const idSet = new Set(ids);
    const parts = this.craft.parts.filter((x) => idSet.has(x.uid)).map((x) => JSON.parse(JSON.stringify(x)) as CraftPart);
    const root = parts.find((x) => x.uid === uid)!;
    root.parent = -1;
    root.attach = 'root';
    root.symmetry = 0;
    if (remove) {
      const p = findPart(this.craft, uid)!;
      const kill = new Set<number>(ids);
      for (const cp of symmetryCounterparts(this.craft, p)) for (const u of subtreeUids(this.craft, cp.uid)) kill.add(u);
      this.craft.parts = this.craft.parts.filter((x) => !kill.has(x.uid));
    }
    return { parts, root: uid };
  }

  /** Which stack sides of the held fragment's root are free. */
  private heldCaps(): { above: boolean; below: boolean; radial: boolean; def: PartDef } | null {
    const hd = this.held;
    if (!hd) return null;
    const root = hd.parts.find((p) => p.uid === hd.root)!;
    const def = getPartDef(root.defId);
    let topUsed = false;
    let bottomUsed = false;
    for (const p of hd.parts) {
      if (p.parent !== root.uid) continue;
      if (p.attach === 'above') topUsed = true;
      if (p.attach === 'below') bottomUsed = true;
    }
    return { above: def.stackBottom && !bottomUsed, below: def.stackTop && !topUsed, radial: def.radialMount, def };
  }

  /** Insert the held fragment at a target; returns the new root uids. */
  private insertHeld(parent: number, attach: CraftPart['attach'], angle: number, offsetY: number, symmetry: number): number[] {
    const hd = this.held!;
    const roots: number[] = [];
    const n = attach === 'radial' ? symmetry : 1;
    const group = n > 1 ? this.craft.nextSymmetry++ : 0;
    for (let k = 0; k < n; k++) {
      const map = new Map<number, number>();
      for (const p of hd.parts) map.set(p.uid, this.craft.nextUid++);
      // Symmetry groups inside the fragment get fresh ids per copy
      const symMap = new Map<number, number>();
      for (const p of hd.parts) {
        const copy = JSON.parse(JSON.stringify(p)) as CraftPart;
        copy.uid = map.get(p.uid)!;
        if (p.uid === hd.root) {
          copy.parent = parent;
          copy.attach = attach;
          copy.angle = attach === 'radial' ? angle + (k * Math.PI * 2) / n : 0;
          copy.offsetY = attach === 'radial' ? offsetY : 0;
          copy.symmetry = group;
        } else {
          copy.parent = map.get(p.parent)!;
          if (copy.symmetry) {
            if (!symMap.has(copy.symmetry)) symMap.set(copy.symmetry, this.craft.nextSymmetry++);
            copy.symmetry = symMap.get(copy.symmetry)!;
          }
        }
        copy.stage = -1;
        this.craft.parts.push(copy);
      }
      roots.push(map.get(hd.root)!);
    }
    return roots;
  }

  private place(): void {
    if (!this.held) return;
    const caps = this.heldCaps()!;
    let roots: number[] = [];
    if (!this.craft.parts.length) {
      this.pushUndo();
      roots = this.insertHeld(-1, 'root', 0, 0, 1);
    } else if (this.hotNode) {
      const node = this.hotNode;
      this.pushUndo();
      roots = this.insertHeld(node.parent, node.kind === 'root' ? 'root' : node.kind, 0, 0, 1);
    } else if (this.radial && caps.radial) {
      this.pushUndo();
      roots = this.insertHeld(this.radial.parent, 'radial', this.radial.angle, this.radial.offsetY, this.symmetry);
    } else {
      return;
    }
    this.ctx.audio.click();
    // Keep holding copies of a new part while Shift is held
    if (!this.ctx.input.shift) this.held = null;
    this.selected = roots[0] ?? null;
    this.afterEdit();
    this.refreshHeld();
  }

  private afterEdit(): void {
    this.layout = layoutCraft(this.craft);
    if (!this.craft.manualStaging) applyAutoStaging(this.craft, this.layout);
    else normalizeStaging(this.craft, this.layout);
    this.rebuild();
  }

  private rebuild(first = false): void {
    this.layout = layoutCraft(this.craft);
    if (first) normalizeStaging(this.craft, this.layout);
    this.vab.setCraft(this.craft);
    this.ghostKey = '';
    this.vab.setGhost(null, []);
    this.pointerDirty = true;
    this.refreshStats();
    this.refreshStages();
    this.refreshInspector();
    this.refreshHeld();
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
    if (this.nameInput.value !== this.craft.name) this.nameInput.value = this.craft.name;
    this.ctx.save.lastCraft = serializeCraft(this.craft);
  }

  private refreshHeld(): void {
    this.hotNode = null;
    this.radial = null;
    // Float the rocket while carrying a part so there's room to attach underneath
    this.vab.setLift(this.held && this.craft.parts.length ? this.heldHeight() + 1 : 0);
    this.highlightKey = '';
    const caps = this.heldCaps();
    this.nodes = caps ? this.vab.computeNodes(this.craft, caps.above, caps.below) : [];
    this.vab.showNodes(this.nodes, null, this.nodeRadius());
    this.pointerDirty = true;
    this.root.classList.toggle('holding', !!this.held);
    this.ctx.renderer.canvas.classList.toggle('vab-holding', !!this.held);
    const hd = this.held;
    if (hd) {
      const def = getPartDef(hd.parts.find((p) => p.uid === hd.root)!.defId);
      const extra = hd.parts.length > 1 ? ` (+${hd.parts.length - 1} attached)` : '';
      if (this.ctx.platform.touch) setText(this.hint, `Holding ${def.name}${extra} · tap a glowing node${caps?.radial ? ' or a surface' : ''} to attach`);
      else setText(this.hint, `Holding ${def.name}${extra} · click a glowing node${caps?.radial ? ' or a surface' : ''} to attach · Shift keeps holding · right-click / Esc to drop`);
    } else if (this.ctx.platform.touch) {
      setText(this.hint, 'Tap a part in the list, then a glowing node · tap the rocket to select · drag to rotate · pinch to zoom · two fingers to pan');
    } else {
      setText(this.hint, 'Click a part in the catalog to pick it up · click the rocket to select · G grab · Ctrl+D duplicate · Del delete · X symmetry · drag to orbit · wheel to zoom · Shift-drag to pan');
    }
    this.updateTouchBar();
  }

  private heldHeight(): number {
    const hd = this.held;
    if (!hd) return 0;
    const tmp = createEmptyCraft();
    tmp.parts = hd.parts;
    const lay = layoutCraft(tmp);
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of lay.values()) {
      lo = Math.min(lo, l.position.y - l.stats.height / 2);
      hi = Math.max(hi, l.position.y + l.stats.height / 2);
    }
    return isFinite(hi - lo) ? hi - lo : 1;
  }

  private nodeRadius(): number {
    return Math.max(0.5, Math.min(2.2, this.dist * 0.018));
  }

  // =================================================================== staging & stats

  private autoStage(): void {
    this.pushUndo();
    this.craft.manualStaging = false;
    this.afterEdit();
  }

  private refreshStats(): void {
    const parts = simPartsFromLayout(this.craft, this.layout);
    this.stages = parts.length ? analyzeStages(parts, 0, G0) : [];
    const st = this.stages;
    let mass = 0;
    for (const l of this.layout.values()) mass += l.stats.dryMass + (l.stats.propellant ? l.stats.propellantCapacity : 0);
    const dvVac = totalDv(st, true);
    const first = st[0];
    const twr = first ? first.twrSL : 0;
    const height = this.vab.height;
    clear(this.statsEl);
    const big = (k: string, v: string, cls = '') => h('div', { class: `vs-big ${cls}` }, h('div', { class: 'k', text: k }), h('div', { class: 'v mono', text: v }));
    const orbitFrac = Math.min(1, dvVac / 9400);
    this.statsEl.appendChild(
      h('div', { class: 'vs-row' },
        big('Total Δv (vac)', `${dvVac.toFixed(0)} m/s`, dvVac >= 9400 ? 'good' : ''),
        big('Liftoff TWR', twr.toFixed(2), twr < 1.05 ? 'bad' : twr < 1.2 ? 'warn' : 'good'),
      ),
    );
    this.statsEl.appendChild(
      h('div', { class: 'vs-orbit' },
        h('div', { class: 'vs-orbit-bar' }, h('div', { style: `width:${(orbitFrac * 100).toFixed(1)}%` })),
        h('div', { class: 'vs-orbit-lbl mono', text: dvVac >= 9400 ? 'Orbit capable (≈9.4 km/s to LEO)' : `${(9400 - dvVac).toFixed(0)} m/s short of low Earth orbit` }),
      ),
    );
    const grid = h('div', { class: 'vs-grid' });
    for (const [k, v] of [
      ['Mass', fmtMass(mass)],
      ['Height', `${height.toFixed(1)} m`],
      ['Parts', String(this.craft.parts.length)],
      ['Cost', formatMoney(totalCost(this.layout))],
    ] as Array<[string, string]>) {
      grid.appendChild(h('div', { class: 'vs-cell' }, h('div', { class: 'k', text: k }), h('div', { class: 'v mono', text: v })));
    }
    this.statsEl.appendChild(grid);

    // Warnings
    clear(this.warnEl);
    const warns: Array<[string, 'bad' | 'warn']> = [];
    const hasCmd = this.craft.parts.some((p) => !!getPartDef(p.defId).command);
    if (!this.craft.parts.length) warns.push(['Empty design — pick a command pod or probe core to start', 'warn']);
    else if (!hasCmd) warns.push(['No command pod or probe core: the vehicle cannot be controlled', 'bad']);
    if (first && first.thrustSL <= 0 && this.craft.parts.length) warns.push(['First stage has no engines', 'bad']);
    else if (first && twr < 1.05) warns.push(['Liftoff thrust-to-weight below 1: it will not leave the pad', 'bad']);
    const m = this.params.mission;
    if (m?.crewed && !this.craft.parts.some((p) => (getPartDef(p.defId).command?.crew ?? 0) > 0)) warns.push(['This mission needs a crewed capsule', 'bad']);
    if (m && m.objectives.some((o) => /home|recover|splash|land/i.test(o.text)) && !this.craft.parts.some((p) => !!getPartDef(p.defId).parachute)) warns.push(['No parachute for the return', 'warn']);
    const rt = rootPart(this.craft);
    if (rt && getPartDef(rt.defId).category !== 'command' && hasCmd) warns.push(['Tip: build from the command pod down so it stays the root part', 'warn']);
    for (const [t, k] of warns) this.warnEl.appendChild(h('div', { class: `vw ${k}`, text: t }));
  }

  private refreshStages(): void {
    clear(this.stagesEl);
    const seq = stagesFromCraft(this.craft);
    if (!seq.length) {
      this.stagesEl.appendChild(h('div', { class: 'vst-empty', text: 'No stageable parts yet — engines, decouplers, fairings and parachutes appear here.' }));
      return;
    }
    const byStage = new Map<number, StageInfo>();
    for (const s of this.stages) byStage.set(s.stage, s);
    seq.forEach((uids, i) => {
      const info = byStage.get(i);
      const box = h('div', {
        class: 'vst',
        onDragOver: (e) => {
          e.preventDefault();
          box.classList.add('over');
        },
        onDrop: (e) => {
          e.preventDefault();
          box.classList.remove('over');
          const uid = Number(e.dataTransfer?.getData('text/apogee-part'));
          if (Number.isFinite(uid)) this.moveToStage(uid, i);
        },
      });
      box.addEventListener('dragleave', () => box.classList.remove('over'));
      const hdr = h('div', { class: 'vst-h' },
        h('span', { class: 'vst-n', text: `Stage ${i + 1}` }),
        info && info.dvVac > 1 ? h('span', { class: 'vst-dv mono', text: `${info.dvVac.toFixed(0)} m/s` }) : null,
      );
      box.appendChild(hdr);
      if (info && info.dvVac > 1) {
        box.appendChild(
          h('div', { class: 'vst-meta mono', text: `TWR ${(i === 0 ? info.twrSL : info.twrVac).toFixed(2)} · ${fmtTime(info.burnTime)} · ${fmtMass(info.startMass)}` }),
        );
      }
      const chips = h('div', { class: 'vst-chips' });
      const counted = new Map<string, { n: number; uid: number; kind: string }>();
      for (const u of uids) {
        const p = findPart(this.craft, u);
        if (!p) continue;
        const def = getPartDef(p.defId);
        const kind = def.engine || def.solid ? 'engine' : def.decoupler ? 'decoupler' : def.parachute ? 'chute' : 'fairing';
        const key = `${def.id}:${p.symmetry || p.uid}`;
        const c = counted.get(key);
        if (c) c.n++;
        else counted.set(key, { n: 1, uid: u, kind });
      }
      for (const [key, c] of counted) {
        const def = getPartDef(key.split(':')[0]!);
        const chip = h('div', {
          class: `chip ${c.kind}${this.selected === c.uid ? ' sel' : ''}`,
          draggable: true,
          text: `${def.name}${c.n > 1 ? ` ×${c.n}` : ''}`,
          title: 'Drag to another stage',
          onDragStart: (e) => e.dataTransfer?.setData('text/apogee-part', String(c.uid)),
          onClick: () => {
            this.selected = c.uid;
            this.refreshInspector();
            this.refreshStages();
          },
        });
        chips.appendChild(chip);
      }
      box.appendChild(chips);
      this.stagesEl.appendChild(box);
    });
    // Drop zone for a brand-new stage
    const add = h('div', {
      class: 'vst vst-new',
      text: '+ new stage',
      onDragOver: (e) => {
        e.preventDefault();
        add.classList.add('over');
      },
      onDrop: (e) => {
        e.preventDefault();
        const uid = Number(e.dataTransfer?.getData('text/apogee-part'));
        if (Number.isFinite(uid)) this.moveToStage(uid, seq.length);
      },
    });
    add.addEventListener('dragleave', () => add.classList.remove('over'));
    this.stagesEl.appendChild(add);
  }

  private moveToStage(uid: number, stage: number): void {
    const p = findPart(this.craft, uid);
    if (!p) return;
    this.pushUndo();
    this.craft.manualStaging = true;
    for (const q of [p, ...symmetryCounterparts(this.craft, p)]) q.stage = stage;
    normalizeStaging(this.craft, this.layout);
    this.rebuild();
  }

  // =================================================================== inspector

  private refreshInspector(): void {
    clear(this.inspector);
    const uid = this.selected;
    if (uid === null) return;
    const p = findPart(this.craft, uid);
    const l = this.layout.get(uid);
    if (!p || !l) return;
    const def = l.def;
    const st = l.stats;
    const card = h('div', { class: 'card vab-insp' });
    card.appendChild(h('div', { class: 'card-h' }, h('span', { text: CATEGORY_LABELS[def.category] }), h('button', { class: 'btn small ghost', text: '✕', onClick: () => this.select(null) })));
    const body = h('div', { class: 'vi-body' });
    body.appendChild(h('div', { class: 'vi-name', text: def.name }));
    const sym = symmetryCounterparts(this.craft, p).length;
    body.appendChild(h('div', { class: 'vi-desc', text: def.description + (sym ? ` (×${sym + 1} symmetry)` : '') }));
    const facts: Array<[string, string]> = [['Mass', fmtMass(st.dryMass + (st.propellant ? st.propellantCapacity : 0))]];
    if (st.propellant) facts.push(['Propellant', `${fmtMass(st.propellantCapacity)} · ${PROPELLANTS[st.propellant].name}`]);
    if (st.thrustVac > 0) facts.push(['Thrust SL / vac', `${(st.thrustSL / 1000).toFixed(0)} / ${(st.thrustVac / 1000).toFixed(0)} kN`], ['Isp SL / vac', `${st.ispSL.toFixed(0)} / ${st.ispVac.toFixed(0)} s`]);
    facts.push(['Size', `${st.diameterTop}${st.diameterBottom !== st.diameterTop ? `→${st.diameterBottom}` : ''} m × ${st.height.toFixed(2)} m`], ['Cost', formatMoney(st.cost)]);
    const factsEl = h('div', { class: 'vi-facts' });
    for (const [k, v] of facts) factsEl.appendChild(h('div', { class: 'vci-row' }, h('span', { text: k }), h('span', { class: 'mono', text: v })));
    body.appendChild(factsEl);

    const s = def.configurable;
    const cfg = p.config;
    const apply = (mut: (c: PartConfig) => void) => {
      this.pushUndo();
      for (const q of [p, ...symmetryCounterparts(this.craft, p)]) mut(q.config);
      this.afterEdit();
    };
    const seg = <T extends string | number>(label: string, opts: T[], cur: T | undefined, fmt: (v: T) => string, set: (c: PartConfig, v: T) => void) => {
      const wrap = h('div', { class: 'vi-seg' });
      for (const o of opts) wrap.appendChild(h('button', { class: `btn small${o === cur ? ' active' : ''}`, text: fmt(o), onClick: () => apply((c) => set(c, o)) }));
      body.appendChild(h('div', { class: 'vi-field' }, h('div', { class: 'vi-lbl', text: label }), wrap));
    };
    if (s?.diameter && s.diameter.length > 1) seg('Diameter', s.diameter, cfg.diameter ?? def.diameter, (v) => `${v} m`, (c, v) => (c.diameter = v));
    if (s?.diameterBottom && s.diameterBottom.length > 1) seg('Bottom diameter', s.diameterBottom, cfg.diameterBottom ?? def.diameterBottom ?? def.diameter, (v) => `${v} m`, (c, v) => (c.diameterBottom = v));
    if (s?.propellant) {
      const props = (Object.keys(PROPELLANTS) as PropellantId[]).filter((k) => k !== 'solid');
      seg('Propellant', props, cfg.propellant ?? 'kerolox', (v) => PROPELLANTS[v].short ?? PROPELLANTS[v].name, (c, v) => (c.propellant = v));
    }
    if (s?.cluster && s.cluster.length > 1) seg('Engines', s.cluster, cfg.cluster ?? 1, (v) => `×${v}`, (c, v) => (c.cluster = v));
    if (s?.canopies && s.canopies.length > 1) seg('Canopies', s.canopies, cfg.canopies ?? 1, (v) => `×${v}`, (c, v) => (c.canopies = v));
    if (s?.length) {
      const [lo, hi, step] = s.length;
      const val = cfg.length ?? def.height;
      const out = h('span', { class: 'mono vi-val', text: `${val.toFixed(1)} m` });
      const range = h('input', {
        type: 'range',
        attrs: { min: String(lo), max: String(hi), step: String(step) },
        value: String(val),
        onInput: () => setText(out, `${Number(range.value).toFixed(1)} m`),
        onChange: () => apply((c) => (c.length = Number(range.value))),
      });
      body.appendChild(h('div', { class: 'vi-field' }, h('div', { class: 'vi-lbl' }, h('span', { text: 'Length' }), out), range));
    }
    if (s?.thrustLimit) {
      const val = cfg.thrustLimit ?? 1;
      const out = h('span', { class: 'mono vi-val', text: `${Math.round(val * 100)}%` });
      const range = h('input', {
        type: 'range',
        attrs: { min: '0.3', max: '1', step: '0.05' },
        value: String(val),
        onInput: () => setText(out, `${Math.round(Number(range.value) * 100)}%`),
        onChange: () => apply((c) => (c.thrustLimit = Number(range.value))),
      });
      body.appendChild(h('div', { class: 'vi-field' }, h('div', { class: 'vi-lbl' }, h('span', { text: 'Thrust limit' }), out), range));
    }
    body.appendChild(
      h('div', { class: 'vi-actions' },
        h('button', { class: 'btn small', text: 'Grab (G)', onClick: () => this.grabSelected() }),
        h('button', { class: 'btn small', text: 'Duplicate', onClick: () => this.duplicateSelected() }),
        h('button', { class: 'btn small danger', text: 'Delete', onClick: () => this.deleteSelected() }),
      ),
    );
    card.appendChild(body);
    this.inspector.appendChild(card);
  }

  private select(uid: number | null): void {
    this.selected = uid;
    this.refreshInspector();
    this.refreshStages();
    this.updateTouchBar();
  }

  private updateTouchBar(): void {
    const bar = this.touchBar;
    if (!bar) return;
    const mode = this.held ? 'hold' : this.selected !== null ? 'sel' : '';
    bar.dataset.mode = mode;
    bar.style.display = mode && this.ctx.platform.touch ? '' : 'none';
  }

  // =================================================================== files

  private newCraft(): void {
    this.pushUndo();
    this.craft = createEmptyCraft();
    this.selected = null;
    this.held = null;
    this.rebuild();
    this.frameCraft(true);
  }

  private loadTemplate(id: string): void {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    this.pushUndo();
    this.craft = t.build();
    this.selected = null;
    this.held = null;
    this.rebuild();
    this.frameCraft(true);
    this.hideOverlay();
  }

  private saveCraft(): void {
    const s = this.ctx.save;
    const name = this.craft.name.trim() || 'Untitled Rocket';
    this.craft.name = name;
    const i = s.crafts.findIndex((c) => c.name === name);
    const copy = cloneCraft(this.craft);
    if (i >= 0) s.crafts[i] = copy;
    else s.crafts.push(copy);
    writeSave(s);
    this.toast(`Saved “${name}”`);
  }

  private showOpen(): void {
    const s = this.ctx.save;
    const list = h('div', { class: 'vab-open-list' });
    const row = (title: string, sub: string, onOpen: () => void, onDelete?: () => void) =>
      h('div', { class: 'vab-open-row', onClick: onOpen },
        h('div', {}, h('div', { class: 'vor-t', text: title }), h('div', { class: 'vor-s mono', text: sub })),
        onDelete ? h('button', { class: 'btn small ghost', text: 'Delete', onClick: (e) => (e.stopPropagation(), onDelete()) }) : null,
      );
    const describe = (c: CraftData) => {
      const lay = layoutCraft(c);
      const st = analyzeStages(simPartsFromLayout(c, lay), 0, G0);
      return `${c.parts.length} parts · ${totalDv(st).toFixed(0)} m/s · TWR ${(st[0]?.twrSL ?? 0).toFixed(2)}`;
    };
    list.appendChild(h('div', { class: 'vab-open-h', text: 'Reference designs' }));
    for (const t of TEMPLATES) list.appendChild(row(t.name, `${t.tagline} · ${describe(t.build())}`, () => this.loadTemplate(t.id)));
    list.appendChild(h('div', { class: 'vab-open-h', text: 'Your designs' }));
    if (!s.crafts.length) list.appendChild(h('div', { class: 'vab-open-empty', text: 'Nothing saved yet — use Save in the top bar.' }));
    s.crafts.forEach((c, i) =>
      list.appendChild(
        row(c.name, describe(c), () => {
          this.pushUndo();
          this.craft = cloneCraft(c);
          this.selected = null;
          this.held = null;
          this.rebuild();
          this.frameCraft(true);
          this.hideOverlay();
        }, () => {
          s.crafts.splice(i, 1);
          writeSave(s);
          this.showOpen();
        }),
      ),
    );
    this.showOverlay(h('div', { class: 'modal card vab-modal' }, h('div', { class: 'modal-kicker', text: 'Open design' }), list, h('div', { class: 'modal-actions' }, h('button', { class: 'btn', text: 'Close', onClick: () => this.hideOverlay() }))));
  }

  private showLaunch(): void {
    const m = this.params.mission;
    const siteSeg = h('div', { class: 'seg-ctl' });
    const todSeg = h('div', { class: 'seg-ctl' });
    const draw = () => {
      clear(siteSeg);
      clear(todSeg);
      for (const s of LAUNCH_SITES) siteSeg.appendChild(h('button', { class: `btn small${s.id === this.siteId ? ' active' : ''}`, text: s.short, disabled: !!m && s.id !== m.site, onClick: () => ((this.siteId = s.id), draw()) }));
      for (const [id, label] of TODS) todSeg.appendChild(h('button', { class: `btn small${id === this.tod ? ' active' : ''}`, text: label, disabled: !!m && id !== m.timeOfDay, onClick: () => ((this.tod = id), draw()) }));
    };
    draw();
    const bad = [...this.warnEl.querySelectorAll('.vw.bad')].map((e) => e.textContent ?? '');
    const site = LAUNCH_SITES.find((s) => s.id === this.siteId);
    this.showOverlay(
      h('div', { class: 'modal card vab-modal' },
        h('div', { class: 'modal-kicker', text: m ? `Mission · ${m.title}` : 'Launch' }),
        h('div', { class: 'modal-title', text: this.craft.name }),
        h('div', { class: 'modal-sub', text: site ? site.name : '' }),
        h('div', { class: 'ql-label', text: 'Launch site' }),
        siteSeg,
        h('div', { class: 'ql-label', text: 'Local time' }),
        todSeg,
        bad.length ? h('div', { class: 'vab-launch-warn' }, ...bad.map((b) => h('div', { class: 'vw bad', text: b }))) : null,
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', text: 'Cancel', onClick: () => this.hideOverlay() }),
          h('button', {
            class: 'btn primary',
            text: 'Go for launch',
            disabled: !this.craft.parts.length,
            onClick: () => {
              this.ctx.save.lastCraft = serializeCraft(this.craft);
              writeSave(this.ctx.save);
              this.params.onLaunch(cloneCraft(this.craft), this.siteId, this.tod);
            },
          }),
        ),
      ),
    );
  }

  private showOverlay(content: HTMLElement): void {
    clear(this.overlay);
    this.overlay.appendChild(content);
    this.overlay.style.display = '';
  }

  private hideOverlay(): void {
    this.overlay.style.display = 'none';
    clear(this.overlay);
  }

  private toast(text: string): void {
    const t = h('div', { class: 'vab-toast', text });
    this.root.appendChild(t);
    setTimeout(() => t.classList.add('out'), 1600);
    setTimeout(() => t.remove(), 2200);
  }

  private exit(): void {
    this.ctx.save.lastCraft = serializeCraft(this.craft);
    writeSave(this.ctx.save);
    this.params.onExit();
  }

  // =================================================================== input

  private cycleSymmetry(back = false): void {
    const i = SYMMETRY_STEPS.indexOf(this.symmetry);
    this.symmetry = SYMMETRY_STEPS[(i + (back ? SYMMETRY_STEPS.length - 1 : 1)) % SYMMETRY_STEPS.length]!;
    this.updateSymBtn();
    this.ghostKey = '';
    this.pointerDirty = true;
  }

  private updateSymBtn(): void {
    this.symBtn.innerHTML = `${svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>', 16)}<span>×${this.symmetry}</span>`;
  }

  private onKey(code: string, e: KeyboardEvent): void {
    if (this.overlay.style.display !== 'none') {
      if (code === 'Escape') this.hideOverlay();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && code === 'KeyY') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && code === 'KeyD') {
      e.preventDefault();
      this.duplicateSelected();
      return;
    }
    if (mod && code === 'KeyS') {
      e.preventDefault();
      this.saveCraft();
      return;
    }
    switch (code) {
      case 'Escape':
        if (this.held) this.dropHeld();
        else this.select(null);
        break;
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        break;
      case 'KeyG':
        this.grabSelected();
        break;
      case 'KeyX':
        this.cycleSymmetry(e.shiftKey);
        break;
      case 'KeyF':
        this.frameCraft(false);
        break;
    }
  }

  private click(): void {
    if (this.held) {
      this.place();
      return;
    }
    const hit = this.pick();
    this.select(hit ? hit.uid : null);
    if (hit) this.ctx.audio.click();
  }

  private pick(): { uid: number; point: Vector3 } | null {
    const w = window.innerWidth;
    const hh = window.innerHeight;
    _ndc.set((this.pointerX / w) * 2 - 1, -(this.pointerY / hh) * 2 + 1);
    return this.vab.pickPart(this.camera, _ndc.x, _ndc.y);
  }

  /** Recompute hover target / attach target from the pointer. */
  private updateHover(): void {
    this.pointerDirty = false;
    const hd = this.held;
    if (!hd) {
      const hit = this.pick();
      this.hovered = hit ? hit.uid : null;
      this.hotNode = null;
      this.radial = null;
      return;
    }
    this.hovered = null;
    const w = window.innerWidth;
    const hh = window.innerHeight;
    const node = this.vab.pickNode(this.nodes, this.camera, this.pointerX, this.pointerY, w, hh, this.ctx.input.lastTouch ? 64 : 42);
    let radial: RadialTarget | null = null;
    const caps = this.heldCaps()!;
    if (!node && caps.radial) {
      const hit = this.pick();
      if (hit) {
        const l = this.layout.get(hit.uid);
        if (l && l.def.allowRadialChildren) {
          const local = _v.copy(hit.point).sub(l.position).applyQuaternion(_qInv.copy(l.rotation).invert());
          const half = l.stats.height / 2;
          const offsetY = Math.max(-half * 0.95, Math.min(half * 0.95, local.y));
          const angle = Math.atan2(-local.z, local.x);
          radial = { parent: hit.uid, angle, offsetY };
        }
      }
    }
    this.hotNode = node;
    this.radial = radial;
    this.vab.showNodes(this.nodes, node, this.nodeRadius());
    // Ghost preview (rebuilt only when the target changes)
    const key = node
      ? `n:${node.parent}:${node.kind}`
      : radial
        ? `r:${radial.parent}:${radial.angle.toFixed(2)}:${radial.offsetY.toFixed(2)}:${this.symmetry}`
        : !this.craft.parts.length
          ? 'root'
          : '';
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (!key) {
      this.vab.setGhost(null, []);
      return;
    }
    const saved = this.craft;
    const savedUid = saved.nextUid;
    this.craft = cloneCraft(saved);
    let roots: number[] = [];
    if (key === 'root') roots = this.insertHeld(-1, 'root', 0, 0, 1);
    else if (node) roots = this.insertHeld(node.parent, node.kind === 'root' ? 'root' : node.kind, 0, 0, 1);
    else if (radial) roots = this.insertHeld(radial.parent, 'radial', radial.angle, radial.offsetY, this.symmetry);
    const preview = this.craft;
    this.craft = saved;
    saved.nextUid = savedUid;
    const ids: number[] = [];
    for (const r of roots) ids.push(...subtreeUids(preview, r));
    // Drawn against the current craft's floor offset so it lines up with what's shown
    this.vab.setGhost(preview, ids, this.craft.parts.length ? this.vab.floorOffset + this.vab.lift : null);
  }

  private highlightKey = '';

  private updateHighlight(): void {
    const sel: number[] = [];
    if (this.selected !== null) {
      const p = findPart(this.craft, this.selected);
      if (p) sel.push(p.uid, ...symmetryCounterparts(this.craft, p).map((q) => q.uid));
    }
    const key = `${sel.join(',')}|${this.hovered ?? ''}|${this.craft.nextUid}`;
    if (key === this.highlightKey) return;
    this.highlightKey = key;
    this.vab.setHighlight(sel, this.hovered);
  }

  private frameCraft(snap: boolean): void {
    const hgt = this.vab.height;
    const width = Math.max(4, this.vab.bounds.max.x - this.vab.bounds.min.x);
    this.distTarget = Math.max(12, Math.max(hgt, width) * 1.35 + 6);
    this.focusTarget = Math.max(2, this.vab.centerY());
    if (snap) {
      this.dist = this.distTarget;
      this.focusY = this.focusTarget;
    }
  }

  // =================================================================== loop

  update(dt: number): void {
    this.t += dt;
    const inp = this.ctx.input;
    const drag = inp.takeDrag();
    const wheel = inp.takeWheel();
    const pan = inp.takePan();
    if (pan.dy) {
      // Two-finger drag slides the view up and down the rocket
      this.focusTarget = Math.max(0.5, Math.min(this.vab.bounds.max.y + 5, this.focusTarget + pan.dy * this.dist * 0.0022));
      this.pointerDirty = true;
    }
    for (const tap of inp.takeTaps()) {
      if (!tap.touch) continue;
      this.pointerX = tap.x;
      this.pointerY = tap.y;
      this.updateHover();
      this.click();
    }
    if (drag.dx || drag.dy) {
      if (inp.shift || inp.dragButton === 1) {
        this.focusTarget = Math.max(0.5, Math.min(this.vab.bounds.max.y + 5, this.focusTarget + drag.dy * this.dist * 0.0022));
      } else {
        this.yaw -= drag.dx * 0.006;
        this.pitch = Math.max(-0.2, Math.min(1.35, this.pitch + drag.dy * 0.005));
      }
      this.pointerDirty = true;
    }
    if (wheel) {
      this.distTarget = Math.max(4, Math.min(400, this.distTarget * Math.pow(1.0012, wheel)));
      this.pointerDirty = true;
    }
    if (inp.isDown('ArrowUp')) this.focusTarget += dt * this.dist * 0.4;
    if (inp.isDown('ArrowDown')) this.focusTarget = Math.max(0.5, this.focusTarget - dt * this.dist * 0.4);
    if (inp.isDown('ArrowLeft')) this.yaw += dt * 1.2;
    if (inp.isDown('ArrowRight')) this.yaw -= dt * 1.2;
    const k = 1 - Math.exp(-dt * 10);
    this.dist += (this.distTarget - this.dist) * k;
    this.focusY += (this.focusTarget - this.focusY) * k;
    const cam = this.camera;
    const cp = Math.cos(this.pitch);
    cam.position.set(Math.sin(this.yaw) * cp * this.dist, this.focusY + Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * cp * this.dist);
    if (cam.position.y < 0.6) cam.position.y = 0.6;
    cam.up.set(0, 1, 0);
    cam.lookAt(0, this.focusY, 0);
    if (Math.abs(cam.fov - 40) > 1e-3) {
      cam.fov = 40;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    if (this.pointerDirty && !inp.dragging) this.updateHover();
    this.updateHighlight();
    this.ctx.audio.updateMusic(dt);
    inp.endFrame();
  }

  render(): void {
    this.compFrame.time = this.t;
    this.ctx.post.render(this.vab.scene, this.camera, this.atmFrame, this.compFrame);
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.ctx.renderer.canvas.classList.remove('vab-holding');
    this.vab.dispose();
    this.root.remove();
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.camera.updateMatrixWorld();
  }
}
