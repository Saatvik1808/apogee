/**
 * LEARNING NOTE: Designing touch controls for a flight game
 *
 * A keyboard gives a rocket pilot ten fingers of digital input; a phone gives two
 * thumbs. The layout follows the ergonomics of every mobile flight game:
 *
 *  • LEFT THUMB — a vertical throttle slider (absolute: where you touch is the
 *    throttle), with MAX / CUT shortcuts at its ends.
 *  • RIGHT THUMB — a virtual joystick for pitch and yaw. Its output is ANALOG:
 *    offset ÷ radius, with a small dead zone so a resting thumb doesn't drift, and
 *    an exponential response curve (value^1.6) so small deflections give fine
 *    corrections while full deflection still gives full authority. Roll gets two
 *    hold-buttons, since it is needed far less often.
 *  • STAGE — a large button in the corner, with a short cooldown so a nervous
 *    double-tap can't throw away a stage.
 *  • RCS MODE — for docking the left thumb trades the throttle for a second
 *    stick that TRANSLATES the ship (left/right, up/down) with FWD/AFT buttons
 *    along the nose, while the right stick keeps rotating it. That is exactly the
 *    Apollo arrangement: translation controller in the left hand, rotation
 *    controller in the right.
 *  • OPS COLUMN — context buttons above STAGE (RCS, target, port alignment,
 *    port camera, undock, switch vessel) that only appear when they can act.
 *    ACTIONS opens a small pad with the airbrakes and the action groups the
 *    rocket's designer assigned (the phone's stand-in for the 1–0 keys).
 *
 * Each control captures its own pointer (setPointerCapture), so the two thumbs
 * work independently and a finger sliding off a control keeps controlling it.
 * Small haptic ticks confirm discrete actions without the player looking down.
 *
 * Key concepts: multi-touch, pointer capture, dead zones, response curves,
 * thumb-reach layout, haptic confirmation
 */
import './touch.css';
import type { Platform } from '../platform/Platform';
import { h } from './dom';

/** Pointer capture can throw for synthetic or already-ended pointers; never let that break input. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* not capturable — the control still works without capture */
  }
}

export interface TouchActions {
  stage(): void;
  setThrottle(t: number): void;
  toggleMap(): void;
  cycleCamera(): void;
  pause(): void;
  togglePanel(p: 'telemetry' | 'computer'): void;
  setPhotoMode(on: boolean): void;
  toggleRcs(): void;
  cycleTarget(): void;
  toggleAlign(): void;
  toggleDockCam(): void;
  undock(): void;
  switchVessel(): void;
  toggleBrakes(): void;
  actionGroup(n: number): void;
}

/** What the ops column can offer this frame (set by the flight state). */
export interface TouchOps {
  /** The vessel carries RCS thrusters / they are armed. */
  rcsAvailable: boolean;
  rcs: boolean;
  /** Other vessels are around to target. */
  targets: boolean;
  /** A compatible docking port of the target is in range. */
  dock: boolean;
  /** Port alignment (SAS) / port camera active. */
  align: boolean;
  dockCam: boolean;
  docked: boolean;
  canSwitch: boolean;
  /** Action groups with parts: bit n−1 for group n. */
  groups: number;
  /** Airbrakes: 0 none, 1 closed, 2 open. */
  brakes: number;
}

const I = {
  map: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.5"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-20 12 12)"/></svg>',
  cam: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  telem: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  rollL: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 5a9 9 0 1 0 10 1"/><path d="M8 1v4h4"/></svg>',
  rollR: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M16 5a9 9 0 1 1-10 1"/><path d="M16 1v4h-4"/></svg>',
};

const DEAD_ZONE = 0.1;
const STAGE_COOLDOWN = 0.8;

export class TouchControls {
  readonly root: HTMLDivElement;
  /** Joystick output, −1..1 (x = yaw right, y = pitch up). */
  stickX = 0;
  stickY = 0;
  /** Roll button output, −1..1. */
  roll = 0;
  /** RCS translation in the pilot frame, −1..1: right, up, forward. */
  tx = 0;
  tu = 0;
  tf = 0;
  sensitivity = 1;
  private readonly thcBase: HTMLDivElement;
  private readonly thcKnob: HTMLDivElement;
  private readonly thcCut: HTMLButtonElement;
  private thcPointer = -1;
  private fwdHeld = false;
  private aftHeld = false;
  private readonly opsBtns: Record<'rcs' | 'target' | 'align' | 'cam' | 'undock' | 'switch' | 'actions', HTMLButtonElement>;
  private opsMask = -1;
  private readonly agPop: HTMLDivElement;
  private readonly agBrake: HTMLButtonElement;
  private readonly agBtns: HTMLButtonElement[] = [];
  private agKey = -1;
  private agOpen = false;
  private thrHot: boolean | null = null;
  private readonly platform: Platform;
  private readonly actions: TouchActions;
  private readonly thrTrack: HTMLDivElement;
  private readonly thrFill: HTMLDivElement;
  private readonly thrThumb: HTMLDivElement;
  private readonly thrVal: HTMLDivElement;
  private readonly stickBase: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly stageBtn: HTMLButtonElement;
  private readonly stageSub: HTMLSpanElement;
  private readonly photoExit: HTMLButtonElement;
  private readonly panelBtns = new Map<string, HTMLButtonElement>();
  private readonly mapBtn: HTMLButtonElement;
  private stickPointer = -1;
  private thrPointer = -1;
  private stageCooldown = 0;
  private lastThrottle = -1;
  private photo = false;

  constructor(parent: HTMLElement, platform: Platform, actions: TouchActions) {
    this.platform = platform;
    this.actions = actions;
    this.root = h('div', { class: 'touch-ui' });

    // ---------------------------------------------------------------- throttle
    this.thrFill = h('div', { class: 'tc-thr-fill' });
    this.thrThumb = h('div', { class: 'tc-thr-thumb' });
    this.thrVal = h('div', { class: 'tc-thr-val mono', text: '0' });
    this.thrTrack = h('div', { class: 'tc-thr-track' }, this.thrFill, h('div', { class: 'tc-thr-ticks' }), this.thrThumb);
    const setFromPointer = (e: PointerEvent) => {
      const r = this.thrTrack.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      // Snap to the ends so 0 % and 100 % are easy to hit
      const snapped = t < 0.03 ? 0 : t > 0.97 ? 1 : t;
      this.actions.setThrottle(snapped);
    };
    this.thrTrack.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.thrPointer = e.pointerId;
      capture(this.thrTrack, e.pointerId);
      setFromPointer(e);
    });
    this.thrTrack.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.thrPointer) setFromPointer(e);
    });
    const thrEnd = (e: PointerEvent) => {
      if (e.pointerId === this.thrPointer) this.thrPointer = -1;
    };
    this.thrTrack.addEventListener('pointerup', thrEnd);
    this.thrTrack.addEventListener('pointercancel', thrEnd);
    const thrBtn = (label: string, v: number, cls: string) =>
      h('button', { class: `tc-btn tc-thr-btn ${cls}`, text: label, onPointerDown: (e) => (e.preventDefault(), this.actions.setThrottle(v), this.platform.haptic('light')) });
    this.root.appendChild(h('div', { class: 'tc-throttle' }, thrBtn('MAX', 1, 'max'), this.thrTrack, this.thrVal, thrBtn('CUT', 0, 'cut')));

    // ------------------------------------------- RCS translation (left thumb)
    this.thcKnob = h('div', { class: 'tc-knob tc-knob-t' });
    this.thcBase = h('div', { class: 'tc-tstick' }, h('div', { class: 'tc-stick-cross' }), h('span', { class: 'tc-tstick-l', text: 'TRANSLATE' }), this.thcKnob);
    const moveThc = (e: PointerEvent) => {
      const r = this.thcBase.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / R;
      let dy = (e.clientY - (r.top + R)) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      this.thcKnob.style.transform = `translate(${dx * R * 0.62}px, ${dy * R * 0.62}px)`;
      this.tx = this.curve(dx);
      // Screen up = translate up (dorsal)
      this.tu = -this.curve(dy);
    };
    this.thcBase.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.thcPointer = e.pointerId;
      capture(this.thcBase, e.pointerId);
      this.thcBase.classList.add('active');
      moveThc(e);
    });
    this.thcBase.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.thcPointer) moveThc(e);
    });
    const thcEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.thcPointer) return;
      this.thcPointer = -1;
      this.tx = this.tu = 0;
      this.thcKnob.style.transform = '';
      this.thcBase.classList.remove('active');
    };
    this.thcBase.addEventListener('pointerup', thcEnd);
    this.thcBase.addEventListener('pointercancel', thcEnd);
    const holdBtn = (label: string, set: (on: boolean) => void) => {
      const b = h('button', { class: 'tc-btn tc-thc-btn', text: label });
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(b, e.pointerId);
        set(true);
        b.classList.add('held');
      });
      const up = () => {
        set(false);
        b.classList.remove('held');
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      return b;
    };
    const fwd = holdBtn('FWD ▲', (on) => ((this.fwdHeld = on), this.syncFore()));
    const aft = holdBtn('AFT ▼', (on) => ((this.aftHeld = on), this.syncFore()));
    // The throttle slider is hidden in RCS mode: keep a way to cut a running engine
    this.thcCut = h('button', { class: 'tc-btn tc-thc-cut', text: 'CUT ENGINE', onPointerDown: (e) => (e.preventDefault(), this.actions.setThrottle(0), this.platform.haptic('light')) });
    this.root.appendChild(h('div', { class: 'tc-thc' }, this.thcCut, fwd, this.thcBase, aft));

    // ------------------------------------------------ ops column (above STAGE)
    const opsBtn = (label: string, title: string, fn: () => void) =>
      h('button', { class: 'tc-btn tc-op', text: label, title, onClick: () => (this.platform.haptic('tick'), fn()) });
    this.opsBtns = {
      rcs: opsBtn('RCS', 'Arm the RCS thrusters: the left stick translates the ship', () => this.actions.toggleRcs()),
      target: opsBtn('TARGET', 'Cycle the navigation target', () => this.actions.cycleTarget()),
      align: opsBtn('ALIGN', 'Hold our docking port facing the target port', () => this.actions.toggleAlign()),
      cam: opsBtn('PORT CAM', 'View out of the docking port', () => this.actions.toggleDockCam()),
      undock: opsBtn('UNDOCK', 'Release the docked module', () => this.actions.undock()),
      switch: opsBtn('SWITCH', 'Fly another vessel of this flight', () => this.actions.switchVessel()),
      actions: opsBtn('ACTIONS', 'Airbrakes and action groups', () => this.setActionsOpen(!this.agOpen)),
    };
    const ops = h('div', { class: 'tc-ops' });
    for (const k of ['rcs', 'target', 'align', 'cam', 'undock', 'switch', 'actions'] as const) {
      this.opsBtns[k].style.display = 'none';
      ops.appendChild(this.opsBtns[k]);
    }
    this.root.appendChild(ops);
    // Action pad (opens from ACTIONS)
    this.agBrake = h('button', { class: 'tc-btn tc-ag tc-ag-brake', text: 'BRAKES', onClick: () => (this.platform.haptic('tick'), this.actions.toggleBrakes()) });
    this.agPop = h('div', { class: 'tc-agpop' }, this.agBrake);
    for (let n = 1; n <= 10; n++) {
      const b = h('button', { class: 'tc-btn tc-ag', text: String(n % 10), title: `Action group ${n}`, onClick: () => (this.platform.haptic('tick'), this.actions.actionGroup(n)) });
      this.agBtns.push(b);
      this.agPop.appendChild(b);
    }
    this.agPop.style.display = 'none';
    this.root.appendChild(this.agPop);

    // ---------------------------------------------------------------- joystick
    this.stickKnob = h('div', { class: 'tc-knob' });
    this.stickBase = h('div', { class: 'tc-stick' }, h('div', { class: 'tc-stick-cross' }), this.stickKnob);
    const moveStick = (e: PointerEvent) => {
      const r = this.stickBase.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / R;
      let dy = (e.clientY - (r.top + R)) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      this.stickKnob.style.transform = `translate(${dx * R * 0.62}px, ${dy * R * 0.62}px)`;
      this.stickX = this.curve(dx);
      // Screen down = pull back = pitch up
      this.stickY = this.curve(dy);
    };
    this.stickBase.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stickPointer = e.pointerId;
      capture(this.stickBase, e.pointerId);
      this.stickBase.classList.add('active');
      moveStick(e);
    });
    this.stickBase.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) moveStick(e);
    });
    const stickEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = -1;
      this.stickX = this.stickY = 0;
      this.stickKnob.style.transform = '';
      this.stickBase.classList.remove('active');
    };
    this.stickBase.addEventListener('pointerup', stickEnd);
    this.stickBase.addEventListener('pointercancel', stickEnd);

    const rollBtn = (html: string, dir: number) => {
      const b = h('button', { class: 'tc-btn tc-roll-btn', html });
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(b, e.pointerId);
        this.roll = dir;
        b.classList.add('held');
      });
      const up = () => {
        this.roll = 0;
        b.classList.remove('held');
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      return b;
    };
    this.root.appendChild(h('div', { class: 'tc-roll' }, rollBtn(I.rollL, -1), h('span', { class: 'tc-roll-l', text: 'ROLL' }), rollBtn(I.rollR, 1)));
    this.root.appendChild(this.stickBase);

    // ------------------------------------------------------------------- stage
    this.stageSub = h('span', { class: 'tc-stage-sub', text: '' });
    this.stageBtn = h('button', { class: 'tc-stage' }, h('span', { class: 'tc-stage-l', text: 'STAGE' }), this.stageSub);
    this.stageBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.stageCooldown > 0) return;
      this.stageCooldown = STAGE_COOLDOWN;
      this.stageBtn.classList.add('fired');
      this.platform.haptic('heavy');
      this.actions.stage();
    });
    this.root.appendChild(this.stageBtn);

    // ---------------------------------------------------------------- top bar
    const bar = h('div', { class: 'tc-bar' });
    const barBtn = (html: string, title: string, fn: () => void) => {
      const b = h('button', { class: 'tc-btn tc-icon', html, title, onClick: () => (this.platform.haptic('tick'), fn()) });
      bar.appendChild(b);
      return b;
    };
    this.mapBtn = barBtn(I.map, 'Map', () => this.actions.toggleMap());
    barBtn(I.cam, 'Camera', () => this.actions.cycleCamera());
    this.panelBtns.set('telemetry', barBtn(I.telem, 'Telemetry', () => this.actions.togglePanel('telemetry')));
    this.panelBtns.set('computer', barBtn(I.cpu, 'Flight computer', () => this.actions.togglePanel('computer')));
    barBtn(I.eye, 'Photo mode', () => this.setPhoto(true));
    barBtn(I.pause, 'Pause', () => this.actions.pause());
    this.root.appendChild(bar);

    this.photoExit = h('button', { class: 'tc-btn tc-icon tc-photo-exit', html: I.eye, title: 'Show HUD', onClick: () => this.setPhoto(false) });
    this.root.appendChild(this.photoExit);
    parent.appendChild(this.root);
  }

  private curve(v: number): number {
    const a = Math.abs(v);
    if (a < DEAD_ZONE) return 0;
    const t = (a - DEAD_ZONE) / (1 - DEAD_ZONE);
    return Math.sign(v) * Math.min(1, Math.pow(t, 1.6) * this.sensitivity);
  }

  private setActionsOpen(on: boolean): void {
    this.agOpen = on;
    this.agPop.style.display = on ? '' : 'none';
    this.opsBtns.actions.classList.toggle('active', on);
  }

  private syncFore(): void {
    this.tf = (this.fwdHeld ? 1 : 0) - (this.aftHeld ? 1 : 0);
  }

  private resetTranslation(): void {
    this.tx = this.tu = this.tf = 0;
    this.fwdHeld = this.aftHeld = false;
    this.thcPointer = -1;
    this.thcKnob.style.transform = '';
    this.thcBase.classList.remove('active');
  }

  setPhoto(on: boolean): void {
    this.photo = on;
    this.root.classList.toggle('photo', on);
    this.actions.setPhotoMode(on);
  }

  get photoMode(): boolean {
    return this.photo;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    if (!v) {
      this.stickX = this.stickY = this.roll = 0;
      this.resetTranslation();
    }
  }

  /** Show only the ops buttons that can act, and switch the left thumb between throttle and RCS. */
  private updateOps(o: TouchOps, throttle: number): void {
    const rcsMode = o.rcsAvailable && o.rcs;
    const mask =
      (o.rcsAvailable ? 1 : 0) | (rcsMode ? 2 : 0) | (o.targets ? 4 : 0) | (o.dock ? 8 : 0) | (o.align ? 16 : 0) | (o.dockCam ? 32 : 0) | (o.docked ? 64 : 0) | (o.canSwitch ? 128 : 0);
    if (mask !== this.opsMask) {
      const wasRcs = (this.opsMask & 2) !== 0;
      this.opsMask = mask;
      const b = this.opsBtns;
      const show = (el: HTMLButtonElement, on: boolean) => (el.style.display = on ? '' : 'none');
      show(b.rcs, o.rcsAvailable);
      show(b.target, o.targets);
      show(b.align, o.dock || o.align);
      show(b.cam, o.dock || o.dockCam);
      show(b.undock, o.docked);
      show(b.switch, o.canSwitch);
      b.rcs.classList.toggle('active', rcsMode);
      b.align.classList.toggle('active', o.align);
      b.cam.classList.toggle('active', o.dockCam);
      this.root.classList.toggle('rcs', rcsMode);
      if (wasRcs && !rcsMode) this.resetTranslation();
    }
    const agKey = o.groups | (o.brakes << 10);
    if (agKey !== this.agKey) {
      this.agKey = agKey;
      const any = o.groups !== 0 || o.brakes !== 0;
      this.opsBtns.actions.style.display = any ? '' : 'none';
      if (!any && this.agOpen) this.setActionsOpen(false);
      this.agBrake.style.display = o.brakes ? '' : 'none';
      this.agBrake.classList.toggle('active', o.brakes === 2);
      this.agBtns.forEach((b, i) => (b.style.display = o.groups & (1 << i) ? '' : 'none'));
    }
    const hot = rcsMode && throttle > 0;
    if (hot !== this.thrHot) {
      this.thrHot = hot;
      this.thcCut.classList.toggle('show', hot);
    }
  }

  /** Per-frame refresh of the widgets from the vessel state. */
  update(dt: number, throttle: number, stageLabel: string, canStage: boolean, panels: { telemetry: boolean; computer: boolean }, mapMode: boolean, ops: TouchOps): void {
    this.updateOps(ops, throttle);
    if (Math.abs(throttle - this.lastThrottle) > 1e-4) {
      // Haptic tick when the throttle reaches either end
      if (this.thrPointer >= 0 && ((throttle === 0 && this.lastThrottle > 0) || (throttle === 1 && this.lastThrottle < 1))) this.platform.haptic('tick');
      this.lastThrottle = throttle;
      const pct = `${(throttle * 100).toFixed(1)}%`;
      this.thrFill.style.height = pct;
      this.thrThumb.style.bottom = pct;
      this.thrVal.textContent = String(Math.round(throttle * 100));
    }
    if (this.stageCooldown > 0) {
      this.stageCooldown -= dt;
      if (this.stageCooldown <= 0) this.stageBtn.classList.remove('fired');
    }
    if (this.stageSub.textContent !== stageLabel) this.stageSub.textContent = stageLabel;
    this.stageBtn.classList.toggle('empty', !canStage);
    for (const [k, b] of this.panelBtns) b.classList.toggle('active', panels[k as 'telemetry' | 'computer']);
    this.mapBtn.classList.toggle('active', mapMode);
    this.root.classList.toggle('map-mode', mapMode);
  }

  dispose(): void {
    this.root.remove();
  }
}
