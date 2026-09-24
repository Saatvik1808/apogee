/**
 * LEARNING NOTE: A tiny DOM builder instead of a UI framework
 *
 * Game HUDs update dozens of numbers 60 times a second. Frameworks that diff a
 * virtual DOM add overhead for that; writing `el.textContent = …` directly is the
 * fastest possible update. This helper keeps element creation readable:
 *     h('div', { class: 'panel' }, h('span', { text: 'ALT' }), altEl)
 *
 * Key concepts: imperative DOM, event listeners, minimising layout thrash
 */
type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  text?: string;
  html?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  draggable?: boolean;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerEnter?: (e: PointerEvent) => void;
  onPointerLeave?: (e: PointerEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs.class) el.className = attrs.class;
  if (attrs.id) el.id = attrs.id;
  if (attrs.title) el.title = attrs.title;
  if (attrs.style) {
    if (typeof attrs.style === 'string') el.setAttribute('style', attrs.style);
    else Object.assign(el.style, attrs.style);
  }
  if (attrs.text !== undefined) el.textContent = attrs.text;
  if (attrs.html !== undefined) el.innerHTML = attrs.html;
  if (attrs.dataset) for (const [k, v] of Object.entries(attrs.dataset)) el.dataset[k] = v;
  if (attrs.attrs) for (const [k, v] of Object.entries(attrs.attrs)) el.setAttribute(k, v);
  const anyEl = el as unknown as { type?: string; value?: string; placeholder?: string; disabled?: boolean; draggable?: boolean };
  if (attrs.type !== undefined) anyEl.type = attrs.type;
  if (attrs.value !== undefined) anyEl.value = attrs.value;
  if (attrs.placeholder !== undefined) anyEl.placeholder = attrs.placeholder;
  if (attrs.disabled !== undefined) anyEl.disabled = attrs.disabled;
  if (attrs.draggable !== undefined) el.draggable = attrs.draggable;
  const ev = el as HTMLElement;
  if (attrs.onClick) ev.addEventListener('click', attrs.onClick);
  if (attrs.onInput) ev.addEventListener('input', attrs.onInput);
  if (attrs.onChange) ev.addEventListener('change', attrs.onChange);
  if (attrs.onPointerDown) ev.addEventListener('pointerdown', attrs.onPointerDown);
  if (attrs.onPointerEnter) ev.addEventListener('pointerenter', attrs.onPointerEnter);
  if (attrs.onPointerLeave) ev.addEventListener('pointerleave', attrs.onPointerLeave);
  if (attrs.onContextMenu) ev.addEventListener('contextmenu', attrs.onContextMenu);
  if (attrs.onDragStart) ev.addEventListener('dragstart', attrs.onDragStart);
  if (attrs.onDragOver) ev.addEventListener('dragover', attrs.onDragOver);
  if (attrs.onDrop) ev.addEventListener('drop', attrs.onDrop);
  if (attrs.onKeyDown) ev.addEventListener('keydown', attrs.onKeyDown);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** Set text only if it changed (avoids needless layout work). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function svgIcon(path: string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.innerHTML = path;
  return svg;
}
