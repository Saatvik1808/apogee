/**
 * LEARNING NOTE: A living main menu
 *
 * The menu reuses the real renderer: a slow cinematic orbit over the Earth's
 * terminator (the day/night line) where the atmosphere glows brightest. Using the
 * actual game world for the backdrop costs nothing extra and immediately shows the
 * player what the engine can do.
 *
 * Key concepts: attract mode, reuse of engine systems, DOM menus over WebGL
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { TEMPLATES } from '../parts/Templates';
import { layoutCraft, totalCost } from '../parts/Craft';
import { analyzeStages, simPartsFromLayout, totalDv } from '../parts/DeltaV';
import { formatMoney } from '../core/math';
import { h, clear } from '../ui/dom';
import { LAUNCH_SITES } from '../world/LaunchSites';
import type { GameContext, GameState } from './GameContext';
import { MISSIONS, type LaunchTimeOfDay, type MissionDef } from './Missions';
import { buildSettingsPanel } from '../ui/SettingsPanel';
import { playDialogue } from '../ui/StoryUI';
import { CHAPTERS, STORY } from './story/Story';
import { CAST, portraitSvg } from './story/Characters';
import { writeSave } from './Save';

export interface MenuCallbacks {
  onCampaign(m: MissionDef): void;
  onSandbox(): void;
  onQuickLaunch(templateId: string, siteId: string, tod: LaunchTimeOfDay): void;
  onMission(m: MissionDef): void;
}

const _m = new Matrix4();

export class MenuState implements GameState {
  private readonly ctx: GameContext;
  private readonly cb: MenuCallbacks;
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private t = 0;
  private readonly camAbs = new Vector3();
  private readonly camQ = new Quaternion();
  private readonly unbindBack: () => void;

  constructor(ctx: GameContext, focusMission: string | null, cb: MenuCallbacks) {
    this.ctx = ctx;
    this.cb = cb;
    this.panel = h('div', { class: 'menu-panel' });
    const btn = (label: string, sub: string, onClick: () => void, primary = false) =>
      h('button', { class: `menu-btn${primary ? ' primary' : ''}`, onClick: () => (ctx.audio.click(), onClick()) }, h('span', { class: 'mb-l', text: label }), h('span', { class: 'mb-s', text: sub }));
    this.root = h(
      'div',
      { class: 'menu' },
      h('div', { class: 'menu-left' },
        h('div', { class: 'menu-logo' }, h('div', { class: 'logo', text: 'APOGEE' }), h('div', { class: 'tag', text: 'Real-scale space program' })),
        h('div', { class: 'menu-btns' },
          btn('Campaign', 'Four chapters: from sounding rockets to Mars', () => this.showCampaign(), true),
          btn('Sandbox', 'Build anything in the assembly building', () => cb.onSandbox()),
          btn('Quick launch', 'Fly a reference rocket right now', () => this.showQuick()),
          btn('Settings', 'Graphics presets, controls, audio', () => this.showSettings()),
          btn('Credits', 'Data sources & licences', () => this.showCredits()),
        ),
        h('div', { class: 'menu-foot mono', text: 'Real Earth & Moon at true scale · patched-conic orbital mechanics · physically based atmosphere' }),
      ),
      this.panel,
    );
    ctx.ui.appendChild(this.root);
    this.unbindBack = ctx.platform.pushBack(() => {
      if (!this.panel.childElementCount) return false;
      clear(this.panel);
      return true;
    });
    ctx.audio.setMusicIntensity(1);
    ctx.space.hemi.visible = true;
    if (focusMission) this.showCampaign(focusMission);
    // Start near sunrise over the Pacific
    this.t = 0;
  }

  private setPanel(title: string, ...content: HTMLElement[]): void {
    clear(this.panel);
    this.panel.appendChild(h('div', { class: 'mp-card card' }, h('div', { class: 'mp-h' }, h('span', { text: title }), h('button', { class: 'btn ghost small', text: '✕', onClick: () => clear(this.panel) })), ...content));
  }

  /** Chapter intro (first time only) and the mission briefing, then continue. */
  private async brief(m: MissionDef): Promise<void> {
    const camp = this.ctx.save.campaign;
    const ch = CHAPTERS.find((c) => c.n === m.chapter);
    if (ch && !camp.storySeen.includes(`ch${ch.n}`)) {
      await playDialogue(this.ctx.ui, ch.intro, { kicker: `Chapter ${ch.n} · ${ch.tagline}`, title: ch.title });
      camp.storySeen.push(`ch${ch.n}`);
      writeSave(this.ctx.save);
    }
    const st = STORY[m.id];
    if (st) await playDialogue(this.ctx.ui, st.brief, { kicker: `Mission briefing · ${LAUNCH_SITES.find((x) => x.id === m.site)?.short ?? ''}`, title: m.title, doneLabel: 'Go ▸' });
  }

  private showCampaign(focus?: string): void {
    const camp = this.ctx.save.campaign;
    const done = new Set(camp.completed);
    const unlockAll = new URLSearchParams(location.search).has('unlock');
    const list = h('div', { class: 'mission-list' });
    const detail = h('div', { class: 'mission-detail' });
    const starText = (n: number) => `${'★'.repeat(n)}${'☆'.repeat(3 - n)}`;
    const select = (m: MissionDef, unlocked: boolean) => {
      clear(detail);
      const ch = CHAPTERS.find((c) => c.n === m.chapter);
      detail.appendChild(h('div', { class: 'md-kicker', text: `Chapter ${m.chapter} · ${ch?.title ?? ''}  ·  ${LAUNCH_SITES.find((s) => s.id === m.site)?.short ?? ''}` }));
      detail.appendChild(h('div', { class: 'md-title', text: m.title }));
      detail.appendChild(h('div', { class: 'md-sub', text: `${m.subtitle}  ·  difficulty ${'●'.repeat(m.difficulty)}${'○'.repeat(5 - m.difficulty)}` }));
      const first = STORY[m.id]?.brief[0];
      if (first) {
        detail.appendChild(
          h('div', { class: 'md-quote' },
            h('div', { class: 'mq-p', html: portraitSvg(first.who, 40) }),
            h('div', {}, h('div', { class: 'mq-n', text: CAST[first.who].name, style: `color:${CAST[first.who].color}` }), h('div', { class: 'mq-t', text: `“${first.text}”` })),
          ),
        );
      }
      detail.appendChild(h('p', { class: 'md-brief', text: m.briefing }));
      const ol = h('ol', { class: 'md-obj' });
      for (const o of m.objectives) ol.appendChild(h('li', { text: o.text }));
      detail.appendChild(ol);
      const best = camp.scores[m.id] ?? 0;
      detail.appendChild(h('div', { class: 'md-bonus-h', text: `Bonus stars · best ${done.has(m.id) ? starText(Math.max(1, best)) : '—'}` }));
      const ul = h('ul', { class: 'md-bonus' });
      for (const b of m.bonus) ul.appendChild(h('li', { text: b.text }));
      detail.appendChild(ul);
      const tpl = TEMPLATES.find((t) => t.id === m.template);
      detail.appendChild(
        h('div', { class: 'md-actions' },
          h('button', { class: 'btn primary', text: `Fly ${tpl ? tpl.name : 'mission'}`, disabled: !unlocked, onClick: () => void this.brief(m).then(() => this.cb.onMission(m)) }),
          h('button', { class: 'btn', text: 'Design my own rocket', disabled: !unlocked, onClick: () => void this.brief(m).then(() => this.cb.onCampaign(m)) }),
        ),
      );
      for (const el of list.querySelectorAll('.mission-item')) el.classList.toggle('sel', (el as HTMLElement).dataset.id === m.id);
    };
    let lastChapter = 0;
    let firstOpen: { m: MissionDef; unlocked: boolean } | null = null;
    MISSIONS.forEach((m, i) => {
      if (m.chapter !== lastChapter) {
        lastChapter = m.chapter;
        const ch = CHAPTERS.find((c) => c.n === m.chapter)!;
        const total = MISSIONS.filter((x) => x.chapter === m.chapter);
        const got = total.reduce((sum, x) => sum + (camp.scores[x.id] ?? (done.has(x.id) ? 1 : 0)), 0);
        list.appendChild(h('div', { class: 'chapter-h' }, h('span', { class: 'ch-n', text: `Chapter ${ch.n}` }), h('span', { class: 'ch-t', text: ch.title }), h('span', { class: 'ch-s mono', text: `${got}/${total.length * 3}★` })));
      }
      const unlocked = i === 0 || done.has(MISSIONS[i - 1]!.id) || done.has(m.id) || unlockAll;
      const stars = done.has(m.id) ? Math.max(1, camp.scores[m.id] ?? 1) : 0;
      const item = h('div', { class: `mission-item${done.has(m.id) ? ' done' : ''}${unlocked ? '' : ' locked'}`, dataset: { id: m.id }, onClick: () => (this.ctx.audio.click(), select(m, unlocked)) },
        h('span', { class: 'mi-n', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'mi-t', text: m.title }),
        h('span', { class: 'mi-s', text: done.has(m.id) ? starText(stars) : unlocked ? '' : '🔒' }),
      );
      list.appendChild(item);
      if (focus === m.id || (!focus && !firstOpen && unlocked && !done.has(m.id))) firstOpen = { m, unlocked };
    });
    const open = firstOpen as { m: MissionDef; unlocked: boolean } | null;
    this.setPanel('Campaign', h('div', { class: 'campaign' }, list, detail));
    if (open) select(open.m, open.unlocked);
    else select(MISSIONS[MISSIONS.length - 1]!, true);
    list.querySelector('.mission-item.sel')?.scrollIntoView({ block: 'nearest' });
  }

  private showQuick(): void {
    let tpl = TEMPLATES[2]!.id;
    let site = 'cape';
    let tod: LaunchTimeOfDay = 'morning';
    const info = h('div', { class: 'quick-info' });
    const renderInfo = () => {
      const t = TEMPLATES.find((x) => x.id === tpl)!;
      const c = t.build();
      const lay = layoutCraft(c);
      const st = analyzeStages(simPartsFromLayout(c, lay), 0, 9.80665);
      const mass = st[0]?.startMass ?? 0;
      clear(info);
      info.appendChild(h('div', { class: 'md-title', text: t.name }));
      info.appendChild(h('div', { class: 'md-sub', text: t.tagline }));
      info.appendChild(
        h('div', { class: 'stats' },
          ...[
            ['Liftoff mass', `${(mass / 1000).toFixed(1)} t`],
            ['Total Δv', `${totalDv(st).toFixed(0)} m/s`],
            ['Liftoff TWR', (st[0]?.twrSL ?? 0).toFixed(2)],
            ['Stages', String(st.length)],
            ['Parts', String(c.parts.length)],
            ['Cost', formatMoney(totalCost(lay))],
          ].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k! }), h('div', { class: 'v mono', text: v! }))),
        ),
      );
    };
    const seg = <T extends string>(opts: Array<[T, string]>, get: () => T, set: (v: T) => void) => {
      const wrap = h('div', { class: 'seg-ctl' });
      const draw = () => {
        clear(wrap);
        for (const [v, label] of opts) wrap.appendChild(h('button', { class: `btn small${get() === v ? ' active' : ''}`, text: label, onClick: () => (set(v), draw(), renderInfo()) }));
      };
      draw();
      return wrap;
    };
    renderInfo();
    this.setPanel(
      'Quick launch',
      h('div', { class: 'quick' },
        h('div', { class: 'ql-label', text: 'Rocket' }),
        seg(TEMPLATES.map((t) => [t.id, t.name] as [string, string]), () => tpl, (v) => (tpl = v)),
        h('div', { class: 'ql-label', text: 'Launch site' }),
        seg(LAUNCH_SITES.map((s) => [s.id, s.short] as [string, string]), () => site, (v) => (site = v)),
        h('div', { class: 'ql-label', text: 'Local time' }),
        seg([['dawn', 'Dawn'], ['morning', 'Morning'], ['noon', 'Noon'], ['dusk', 'Dusk'], ['night', 'Night'], ['lunar', 'Lunar window'], ['mars', 'Mars window']] as Array<[LaunchTimeOfDay, string]>, () => tod, (v) => (tod = v)),
        info,
        h('div', { class: 'md-actions' },
          h('button', { class: 'btn primary', text: 'Go for launch', onClick: () => this.cb.onQuickLaunch(tpl, site, tod) }),
        ),
      ),
    );
  }

  private showSettings(): void {
    this.setPanel('Settings', buildSettingsPanel(this.ctx));
  }

  private showCredits(): void {
    const items: Array<[string, string]> = [
      ['Earth imagery', 'NASA Blue Marble Next Generation & Black Marble (public domain)'],
      ['Earth elevation & coasts', 'NOAA ETOPO 2022; Natural Earth 1:10m (public domain)'],
      ['Clouds', 'NASA Visible Earth cloud composite (public domain)'],
      ['Moon', 'NASA SVS CGI Moon Kit — LRO LROC colour & LOLA elevation (public domain)'],
      ['Mars', 'USGS Viking colour mosaic; MGS MOLA MEGDR elevation (public domain)'],
      ['Stars', 'HYG Database v4.1 by David Nash (CC BY-SA 4.0)'],
      ['Milky Way', 'NASA SVS Deep Star Maps 2020 (public domain)'],
      ['Ground & HDRI textures', 'Poly Haven (CC0)'],
      ['Fonts', 'Rajdhani, Inter, JetBrains Mono (SIL OFL 1.1)'],
      ['Engine', 'three.js (MIT). Physics, atmosphere scattering, terrain, audio: written for APOGEE'],
    ];
    const tbl = h('div', { class: 'credits' });
    for (const [k, v] of items) tbl.appendChild(h('div', { class: 'cr-row' }, h('div', { class: 'cr-k', text: k }), h('div', { class: 'cr-v', text: v })));
    this.setPanel('Credits', tbl);
  }

  update(dt: number): void {
    this.t += dt;
    // The menu does not use pointer input on the canvas: discard it, or it
    // would be applied by the next state's first frame
    this.ctx.input.flush();
    const sys = this.ctx.system;
    // Advance real time slowly for a living backdrop
    sys.update(sys.time + dt * 20);
    const earth = sys.earth;
    // Camera: 700 km over the day/night terminator, looking along the limb
    const sunDir = new Vector3().copy(sys.sun.position).sub(earth.position).normalize();
    const pole = new Vector3(0, 1, 0);
    const side = new Vector3().crossVectors(sunDir, pole).normalize();
    const a = this.t * 0.012 + 0.6;
    const radial = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(pole, Math.sin(a) * 0.35).normalize();
    const r = earth.radius + 650_000;
    this.camAbs.copy(earth.position).addScaledVector(radial, r);
    const fwd = sunDir.clone().multiplyScalar(0.6).addScaledVector(radial, -0.22).addScaledVector(new Vector3().crossVectors(radial, sunDir).normalize(), 0.5).normalize();
    _m.lookAt(new Vector3(), fwd, radial);
    this.camQ.setFromRotationMatrix(_m);
    this.ctx.audio.updateMusic(dt);
  }

  render(): void {
    const ctx = this.ctx;
    const cam = ctx.renderer.camera;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(this.camQ);
    if (cam.fov !== 50) {
      cam.fov = 50;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    ctx.space.update(this.camAbs, cam, performance.now() / 1000, ctx.renderer.pixelRatio);
    ctx.post.render(ctx.space.scene, cam, ctx.space.atmFrame, ctx.space.compFrame);
  }

  dispose(): void {
    this.unbindBack();
    this.root.remove();
  }
}
