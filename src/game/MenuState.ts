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
import { writeSave } from './Save';
import { applyQuality } from './Quality';

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

  constructor(ctx: GameContext, cb: MenuCallbacks) {
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
          btn('Campaign', 'From sounding rockets to the Moon', () => this.showCampaign(), true),
          btn('Sandbox', 'Build anything in the assembly building', () => cb.onSandbox()),
          btn('Quick launch', 'Fly a reference rocket right now', () => this.showQuick()),
          btn('Settings', 'Graphics, audio', () => this.showSettings()),
          btn('Credits', 'Data sources & licences', () => this.showCredits()),
        ),
        h('div', { class: 'menu-device', text: 'APOGEE is built for a desktop browser with a keyboard and mouse. On this screen you can explore the menus and the assembly building; flying needs a keyboard.' }),
        h('div', { class: 'menu-foot mono', text: 'Real Earth & Moon at true scale · patched-conic orbital mechanics · physically based atmosphere' }),
      ),
      this.panel,
    );
    ctx.ui.appendChild(this.root);
    ctx.audio.setMusicIntensity(1);
    ctx.space.hemi.visible = true;
    // Start near sunrise over the Pacific
    this.t = 0;
  }

  private setPanel(title: string, ...content: HTMLElement[]): void {
    clear(this.panel);
    this.panel.appendChild(h('div', { class: 'mp-card card' }, h('div', { class: 'mp-h' }, h('span', { text: title }), h('button', { class: 'btn ghost small', text: '✕', onClick: () => clear(this.panel) })), ...content));
  }

  private showCampaign(): void {
    const done = new Set(this.ctx.save.campaign.completed);
    const list = h('div', { class: 'mission-list' });
    const detail = h('div', { class: 'mission-detail' });
    const select = (m: MissionDef, unlocked: boolean) => {
      clear(detail);
      detail.appendChild(h('div', { class: 'md-kicker', text: `${'★'.repeat(m.difficulty)}${'☆'.repeat(5 - m.difficulty)}  ·  ${LAUNCH_SITES.find((s) => s.id === m.site)?.short ?? ''}` }));
      detail.appendChild(h('div', { class: 'md-title', text: m.title }));
      detail.appendChild(h('div', { class: 'md-sub', text: m.subtitle }));
      detail.appendChild(h('p', { class: 'md-brief', text: m.briefing }));
      const ol = h('ol', { class: 'md-obj' });
      for (const o of m.objectives) ol.appendChild(h('li', { text: o.text }));
      detail.appendChild(ol);
      const tpl = TEMPLATES.find((t) => t.id === m.template);
      detail.appendChild(
        h('div', { class: 'md-actions' },
          h('button', { class: 'btn primary', text: 'Design rocket', disabled: !unlocked, onClick: () => this.cb.onCampaign(m) }),
          h('button', { class: 'btn', text: `Fly ${tpl ? tpl.name : 'reference'}`, disabled: !unlocked, onClick: () => this.cb.onMission(m) }),
        ),
      );
    };
    MISSIONS.forEach((m, i) => {
      const unlocked = i === 0 || done.has(MISSIONS[i - 1]!.id) || done.has(m.id) || new URLSearchParams(location.search).has('unlock');
      const item = h('div', { class: `mission-item${done.has(m.id) ? ' done' : ''}${unlocked ? '' : ' locked'}`, onClick: () => select(m, unlocked) },
        h('span', { class: 'mi-n', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'mi-t', text: m.title }),
        h('span', { class: 'mi-s', text: done.has(m.id) ? '✓' : unlocked ? '' : '🔒' }),
      );
      list.appendChild(item);
    });
    const first = MISSIONS.find((m, i) => !done.has(m.id) && (i === 0 || done.has(MISSIONS[i - 1]!.id))) ?? MISSIONS[0]!;
    select(first, true);
    this.setPanel('Campaign', h('div', { class: 'campaign' }, list, detail));
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
        seg([['dawn', 'Dawn'], ['morning', 'Morning'], ['noon', 'Noon'], ['dusk', 'Dusk'], ['night', 'Night'], ['lunar', 'Lunar window']] as Array<[LaunchTimeOfDay, string]>, () => tod, (v) => (tod = v)),
        info,
        h('div', { class: 'md-actions' },
          h('button', { class: 'btn primary', text: 'Go for launch', onClick: () => this.cb.onQuickLaunch(tpl, site, tod) }),
        ),
      ),
    );
  }

  private showSettings(): void {
    const s = this.ctx.save.settings;
    const save = () => {
      writeSave(this.ctx.save);
      applyQuality(this.ctx);
    };
    const range = (label: string, get: () => number, set: (v: number) => void) =>
      h('label', { class: 'set-row' }, h('span', { text: label }),
        h('input', { type: 'range', attrs: { min: '0', max: '1', step: '0.05' }, value: String(get()), onInput: (e) => (set(Number((e.target as HTMLInputElement).value)), save()) }));
    const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const inp = h('input', { type: 'checkbox', onChange: (e) => (set((e.target as HTMLInputElement).checked), save()) });
      inp.checked = get();
      return h('label', { class: 'set-row' }, h('span', { text: label }), inp);
    };
    const quality = h('div', { class: 'seg-ctl' });
    const drawQ = () => {
      clear(quality);
      for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
        quality.appendChild(h('button', { class: `btn small${s.quality === q ? ' active' : ''}`, text: q, onClick: () => ((s.quality = q), save(), drawQ()) }));
      }
    };
    drawQ();
    this.setPanel(
      'Settings',
      h('div', { class: 'settings' },
        h('div', { class: 'ql-label', text: 'Graphics quality' }),
        quality,
        check('Volumetric-style clouds', () => s.clouds, (v) => (s.clouds = v)),
        check('Bloom & lens flare', () => s.bloom, (v) => (s.bloom = v)),
        check('Film grain', () => s.grain, (v) => (s.grain = v)),
        check('Show FPS', () => s.showFps, (v) => (s.showFps = v)),
        h('div', { class: 'ql-label', text: 'Audio' }),
        range('Master', () => s.master, (v) => ((s.master = v), (this.ctx.audio.settings.master = v), this.ctx.audio.applySettings())),
        range('Effects', () => s.sfx, (v) => ((s.sfx = v), (this.ctx.audio.settings.sfx = v), this.ctx.audio.applySettings())),
        range('Music', () => s.music, (v) => ((s.music = v), (this.ctx.audio.settings.music = v), this.ctx.audio.applySettings())),
        check('Mission control voice', () => s.voice, (v) => ((s.voice = v), (this.ctx.audio.settings.voice = v))),
      ),
    );
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
    this.root.remove();
  }
}
