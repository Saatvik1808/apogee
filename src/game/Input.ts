/**
 * LEARNING NOTE: Input as state + events
 *
 * Games need two views of the keyboard: "is W held right now?" (continuous
 * controls like pitch) and "was Space pressed this frame?" (discrete actions like
 * staging). We record raw DOM events into both a held-key set and a per-frame
 * queue of presses, and ignore keys while the player types into a text field.
 *
 * Key concepts: polling vs events, edge detection, focus handling
 */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressed: string[] = [];
  private readonly listeners: Array<(code: string, e: KeyboardEvent) => void> = [];
  wheelDelta = 0;
  dragDX = 0;
  dragDY = 0;
  dragging = false;
  dragButton = -1;
  pointerX = 0;
  pointerY = 0;
  shift = false;
  ctrl = false;
  alt = false;

  constructor(canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (this.isTyping(e)) return;
      if (!this.held.has(e.code)) this.pressed.push(e.code);
      this.held.add(e.code);
      this.mods(e);
      for (const l of this.listeners) l(e.code, e);
      if (['Space', 'Tab', 'F1', 'F2', 'F5', 'F9'].includes(e.code) || (e.code.startsWith('Arrow') && !this.isTyping(e))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
      this.mods(e);
    });
    window.addEventListener('blur', () => this.held.clear());
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragButton = e.button;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      this.dragButton = -1;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      if (this.dragging) {
        this.dragDX += e.movementX;
        this.dragDY += e.movementY;
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

  /** Consume accumulated mouse deltas. */
  takeDrag(): { dx: number; dy: number } {
    const r = { dx: this.dragDX, dy: this.dragDY };
    this.dragDX = 0;
    this.dragDY = 0;
    return r;
  }

  takeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  endFrame(): void {
    this.pressed.length = 0;
  }
}
