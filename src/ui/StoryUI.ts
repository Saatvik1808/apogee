/**
 * LEARNING NOTE: Dialogue and radio presentation
 *
 * Two presentation layers carry the story:
 *
 *  • The DIALOGUE PLAYER for briefings and debriefs: one speaker at a time, a
 *    portrait and a "typewriter" reveal (text appears at reading speed; a tap
 *    completes the line, a second tap advances). Players skim, so everything is
 *    skippable.
 *  • The RADIO FEED in flight: short subtitle-style transmissions that queue up
 *    and never block the controls. Each one opens and closes with a Quindar tone
 *    — the famous beeps (2,525 Hz and 2,475 Hz) that keyed Apollo's ground
 *    transmitters. While the spacecraft is behind the Moon or wrapped in
 *    re-entry plasma, transmissions wait in the queue, exactly like real
 *    loss-of-signal.
 *
 * Key concepts: dialogue systems, message queues, typewriter text, diegetic UI
 */
import './story.css';
import type { Beat } from '../game/story/Story';
import { CAST, portraitSvg } from '../game/story/Characters';
import { h } from './dom';

const CPS = 55;

/** Play a sequence of beats inside `host`; resolves when finished or skipped. */
export function playDialogue(host: HTMLElement, beats: Beat[], opts: { kicker?: string; title?: string; doneLabel?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    if (!beats.length) {
      resolve();
      return;
    }
    const portrait = h('div', { class: 'dlg-portrait' });
    const name = h('div', { class: 'dlg-name' });
    const role = h('div', { class: 'dlg-role' });
    const text = h('div', { class: 'dlg-text' });
    const dots = h('div', { class: 'dlg-dots' });
    const next = h('button', { class: 'btn primary small dlg-next', text: 'Next ▸' });
    const skip = h('button', { class: 'btn ghost small', text: 'Skip' });
    const card = h('div', { class: 'dlg card' },
      opts.kicker || opts.title
        ? h('div', { class: 'dlg-head' }, opts.kicker ? h('div', { class: 'dlg-kicker', text: opts.kicker }) : null, opts.title ? h('div', { class: 'dlg-title', text: opts.title }) : null)
        : null,
      h('div', { class: 'dlg-body' }, portrait, h('div', { class: 'dlg-main' }, h('div', { class: 'dlg-who' }, name, role), text)),
      h('div', { class: 'dlg-foot' }, dots, h('div', { class: 'dlg-btns' }, skip, next)),
    );
    const wrap = h('div', { class: 'dlg-wrap' }, card);
    host.appendChild(wrap);
    let i = 0;
    let shown = 0;
    let full = '';
    let timer = 0;
    const finish = () => {
      clearInterval(timer);
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 220);
      resolve();
    };
    const show = () => {
      const b = beats[i]!;
      const c = CAST[b.who];
      portrait.innerHTML = portraitSvg(b.who, 64);
      name.textContent = c.name;
      role.textContent = c.role;
      name.style.color = c.color;
      full = b.text;
      shown = 0;
      text.textContent = '';
      dots.innerHTML = '';
      beats.forEach((_, k) => dots.appendChild(h('i', { class: k === i ? 'on' : k < i ? 'done' : '' })));
      next.textContent = i === beats.length - 1 ? (opts.doneLabel ?? 'Continue ▸') : 'Next ▸';
      clearInterval(timer);
      timer = window.setInterval(() => {
        shown = Math.min(full.length, shown + 2);
        text.textContent = full.slice(0, shown);
        if (shown >= full.length) clearInterval(timer);
      }, 2000 / CPS);
    };
    const advance = () => {
      if (shown < full.length) {
        // First tap completes the line
        shown = full.length;
        text.textContent = full;
        clearInterval(timer);
        return;
      }
      i++;
      if (i >= beats.length) finish();
      else show();
    };
    next.addEventListener('click', (e) => (e.stopPropagation(), advance()));
    card.addEventListener('click', advance);
    skip.addEventListener('click', (e) => (e.stopPropagation(), finish()));
    show();
  });
}

export type SignalState = 'link' | 'los' | 'blackout';

interface QueuedLine {
  beat: Beat;
  seconds: number;
}

/** In-flight radio subtitles with Quindar tones and loss-of-signal holds. */
export class RadioFeed {
  readonly root: HTMLDivElement;
  private readonly portrait: HTMLDivElement;
  private readonly name: HTMLSpanElement;
  private readonly text: HTMLDivElement;
  private readonly queue: QueuedLine[] = [];
  private current: QueuedLine | null = null;
  private remaining = 0;
  private signal: SignalState = 'link';
  private readonly beep: (high: boolean) => void;

  constructor(parent: HTMLElement, beep: (high: boolean) => void) {
    this.beep = beep;
    this.portrait = h('div', { class: 'rf-portrait' });
    this.name = h('span', { class: 'rf-name' });
    this.text = h('div', { class: 'rf-text' });
    this.root = h('div', { class: 'radio-feed' }, this.portrait, h('div', { class: 'rf-main' }, this.name, this.text));
    parent.appendChild(this.root);
  }

  say(lines: Beat[]): void {
    for (const b of lines) this.queue.push({ beat: b, seconds: Math.max(3.8, b.text.length / 15) });
    // Keep the backlog short: old chatter is dropped, not delayed forever
    while (this.queue.length > 6) this.queue.shift();
  }

  setSignal(s: SignalState): void {
    this.signal = s;
  }

  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  update(dt: number): void {
    if (this.current) {
      this.remaining -= dt;
      if (this.remaining <= 0 || this.signal !== 'link') {
        this.current = null;
        this.root.classList.remove('show');
        this.beep(false);
      }
      return;
    }
    if (this.signal !== 'link' || !this.queue.length) return;
    const q = this.queue.shift()!;
    this.current = q;
    this.remaining = q.seconds;
    const c = CAST[q.beat.who];
    this.portrait.innerHTML = portraitSvg(q.beat.who, 38);
    this.name.textContent = `${c.name} · ${c.role}`;
    this.name.style.color = c.color;
    this.text.textContent = q.beat.text;
    this.root.classList.add('show');
    this.beep(true);
  }

  dispose(): void {
    this.root.remove();
  }
}
