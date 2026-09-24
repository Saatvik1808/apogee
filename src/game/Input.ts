/**
 * LEARNING NOTE: Input as state + events — for keyboards AND fingers
 *
 * Games need two views of the keyboard: "is W held right now?" (continuous
 * controls like pitch) and "was Space pressed this frame?" (discrete actions like
 * staging). We record raw DOM events into both a held-key set and a per-frame
 * queue of presses, and ignore keys while the player types into a text field.
 *
 * Pointer Events unify mouse, pen and touch, but gestures still need care. We
 * track every active pointer ourselves: one finger drags the camera like a mouse,
 * two fingers PINCH (the change in finger spacing becomes an exponential zoom,
 * expressed in the same units as a mouse wheel) and PAN (the midpoint's motion).
 * A short press that barely moved is a TAP. Deltas come from our own stored
 * positions — `movementX` is unreliable for touch on some browsers.
 *
 * Key concepts: polling vs events, edge detection, focus handling, multi-touch
 * gesture recognition, pointer capture
 */

/** Pointer capture can throw for synthetic or already-ended pointers; never let that break input. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* not capturable — the control still works without capture */
  }
}

export interface Tap {
  x: number;
  y: number;
  touch: boolean;
}

interface TrackedPointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
  touch: boolean;
}

/** Wheel units per e-fold of zoom (matches the cameras' 1.0015^wheel). */
const WHEEL_PER_LN = 1 / Math.log(1.0015);

export class Input {
  private readonly held = new Set<string>();
  private readonly pressed: string[] = [];
  private readonly listeners: Array<(code: string, e: KeyboardEvent) => void> = [];
  private readonly pointers = new Map<number, TrackedPointer>();
  private readonly taps: Tap[] = [];
  private pinchDist = 0;
  private pinchMidX = 0;
  private pinchMidY = 0;
  /** A second finger touched during this gesture: its end is not a tap. */
  private multiTouch = false;
  wheelDelta = 0;
  dragDX = 0;
  dragDY = 0;
  panDX = 0;
  panDY = 0;
  dragging = false;
  dragButton = -1;
  pointerX = 0;
  pointerY = 0;
  /** Last pointer interaction came from a finger. */
  lastTouch = false;
  shift = false;
  ctrl = false;
  alt = false;

  constructor(canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (this.isTyping(e)) return;
      if (!this.held.has(e.code)) this.pressed.push(e.code);
      this.held.add(e.code);
      this.mods(e);
      // Key auto-repeat must not re-trigger discrete actions (holding Space
      // would fire STAGE at the OS repeat rate and dump every stage)
      if (!e.repeat) for (const l of this.listeners) l(e.code, e);
      if (['Space', 'Tab', 'F1', 'F2', 'F5', 'F9'].includes(e.code) || (e.code.startsWith('Arrow') && !this.isTyping(e))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
      this.mods(e);
    });
    window.addEventListener('blur', () => {
      this.held.clear();
      this.pointers.clear();
      this.dragging = false;
    });
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      const touch = e.pointerType === 'touch';
      this.lastTouch = touch;
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, startT: performance.now(), touch });
      capture(canvas, e.pointerId);
      if (this.pointers.size === 1) {
        this.multiTouch = false;
        this.dragging = true;
        this.dragButton = e.button;
      } else {
        // Second finger: switch from dragging to pinch/pan
        this.multiTouch = true;
        this.dragging = false;
        this.resetPinch();
      }
    });
    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (e.type === 'pointerup' && !this.multiTouch && this.pointers.size === 0 && moved < (p.touch ? 12 : 5) && performance.now() - p.startT < 450 && e.button === 0) {
        this.taps.push({ x: e.clientX, y: e.clientY, touch: p.touch });
      }
      if (this.pointers.size === 1) {
        // Back to one finger: continue as a drag without a jump
        this.dragging = true;
        this.dragButton = 0;
      } else if (this.pointers.size === 0) {
        this.dragging = false;
        this.dragButton = -1;
      } else this.resetPinch();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        if (this.dragging) {
          this.dragDX += dx;
          this.dragDY += dy;
        }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [TrackedPointer, TrackedPointer];
        const dist = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Fingers apart → zoom in (negative wheel)
        this.wheelDelta += Math.log(this.pinchDist / dist) * WHEEL_PER_LN;
        this.panDX += mx - this.pinchMidX;
        this.panDY += my - this.pinchMidY;
        this.pinchDist = dist;
        this.pinchMidX = mx;
        this.pinchMidY = my;
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheelDelta += e.deltaY;
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private resetPinch(): void {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return;
    const a = ps[0]!;
    const b = ps[1]!;
    this.pinchDist = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
    this.pinchMidX = (a.x + b.x) / 2;
    this.pinchMidY = (a.y + b.y) / 2;
  }

  private mods(e: KeyboardEvent): void {
    this.shift = e.shiftKey;
    this.ctrl = e.ctrlKey || e.metaKey;
    this.alt = e.altKey;
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** Was this key pressed since the last `endFrame()`? */
  wasPressed(code: string): boolean {
    return this.pressed.includes(code);
  }

  onKey(cb: (code: string, e: KeyboardEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Number of fingers/buttons currently down on the canvas. */
  get activePointers(): number {
    return this.pointers.size;
  }

  /** Consume accumulated one-pointer drag deltas. */
  takeDrag(): { dx: number; dy: number } {
    const r = { dx: this.dragDX, dy: this.dragDY };
    this.dragDX = 0;
    this.dragDY = 0;
    return r;
  }

  /** Consume accumulated two-finger pan deltas. */
  takePan(): { dx: number; dy: number } {
    const r = { dx: this.panDX, dy: this.panDY };
    this.panDX = 0;
    this.panDY = 0;
    return r;
  }

  takeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  /** Consume taps (short presses that barely moved) on the canvas. */
  takeTaps(): Tap[] {
    if (!this.taps.length) return this.taps;
    const r = this.taps.slice();
    this.taps.length = 0;
    return r;
  }

  endFrame(): void {
    this.pressed.length = 0;
    // Taps are per-frame events like key presses: unconsumed ones expire
    this.taps.length = 0;
  }

  /**
   * Drop everything accumulated so far: wheel, drag, pan, taps and presses.
   * States that do not consume pointer input (the menu) call this every frame,
   * and every state calls it when it starts — otherwise twenty wheel notches
   * scrolled over the menu backdrop would zoom the first flight frame 20× out.
   */
  flush(): void {
    this.wheelDelta = 0;
    this.dragDX = 0;
    this.dragDY = 0;
    this.panDX = 0;
    this.panDY = 0;
    this.endFrame();
  }
}
