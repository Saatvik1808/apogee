/**
 * LEARNING NOTE: A game as a state machine
 *
 * The game is always in exactly one STATE — main menu, assembly building, or
 * flight — each with its own update/render logic and UI. Switching state disposes
 * the old one (removing its meshes and DOM) and builds the new one. The App owns
 * the long-lived services and the single requestAnimationFrame loop.
 *
 * Key concepts: finite state machines, resource lifetimes, the render loop
 */
import type { Vector3 } from 'three';
import type { CraftData } from '../parts/Craft';
import { TEMPLATES } from '../parts/Templates';
import { utFromDate } from '../physics/Ephemeris';
import { h, clear } from '../ui/dom';
import { getLaunchSite, type LaunchSite } from '../world/LaunchSites';
import { FlightState } from './FlightState';
import { lunarLaunchWindow, marsLaunchWindow } from './LaunchWindow';
import type { GameContext, GameState } from './GameContext';
import { MenuState } from './MenuState';
import { launchUtFor, MISSIONS, MissionRuntime, type MissionDef, type LaunchTimeOfDay } from './Missions';
import { writeSave } from './Save';
import { resolution } from './Quality';
import { buildSettingsPanel } from '../ui/SettingsPanel';
import { STORY } from './story/Story';
import { CAST, portraitSvg } from './story/Characters';
import { VABState } from './VABState';

export interface LaunchRequest {
  craft: CraftData;
  site: LaunchSite;
  timeOfDay: LaunchTimeOfDay;
  mission: MissionDef | null;
}

export class App {
  readonly ctx: GameContext;
  private state: GameState | null = null;
  private last = performance.now();
  private readonly pauseEl: HTMLDivElement;
  private lastLaunch: LaunchRequest | null = null;
  private fpsEl: HTMLDivElement;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private readonly hintEl: HTMLDivElement;
  private hintTimer = 0;
  private unbackPause: (() => void) | null = null;
  private pauseView: 'menu' | 'settings' | 'result' | null = null;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.pauseEl = h('div', { class: 'overlay pause', style: 'display:none' });
    ctx.ui.appendChild(this.pauseEl);
    this.fpsEl = h('div', { class: 'fps mono', style: 'display:none' });
    ctx.ui.appendChild(this.fpsEl);
    ctx.ui.addEventListener('apogee:pause', () => this.togglePause());
    const unlock = () => ctx.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.hintEl = h('div', { class: 'app-hint' });
    ctx.ui.appendChild(this.hintEl);
    ctx.platform.onExitHint = () => this.hint('Press Back again to exit');
    // Backgrounded (home button, phone call): pause the flight and go quiet
    ctx.platform.onPause(() => {
      if (this.state instanceof FlightState && this.pauseEl.style.display === 'none') this.togglePause();
      ctx.audio.suspend();
    });
    ctx.platform.onResume(() => ctx.audio.resume());
  }

  /** Brief message at the bottom of the screen. */
  hint(text: string): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hintEl.classList.remove('show'), 1800);
  }

  /** Back button while an overlay is open: step back through it. */
  private armBack(): void {
    if (this.unbackPause) return;
    this.unbackPause = this.ctx.platform.pushBack(() => {
      if (this.pauseView === 'settings' && this.state instanceof FlightState) this.showPauseMenu(this.state);
      else this.hidePause();
      return true;
    });
  }

  start(): void {
    const q = new URLSearchParams(location.search);
    const quick = q.get('quick');
    const tpl = quick ? TEMPLATES.find((t) => t.id === quick) : undefined;
    if (tpl) {
      this.launch({ craft: tpl.build(), site: getLaunchSite(q.get('site') ?? 'cape'), timeOfDay: (q.get('tod') as LaunchTimeOfDay) ?? 'morning', mission: null });
    } else if (q.get('vab') !== null) {
      this.openVAB(null, null);
    } else {
      this.openMenu();
    }
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number) => {
    let cap: number = this.ctx.save.settings.frameCap;
    // Menus and the assembly building don't need 60 FPS: halve the GPU work (and
    // battery drain) on phones and tablets outside of flight
    if (this.ctx.platform.touchDevice && !(this.state instanceof FlightState)) cap = cap === 0 ? 30 : Math.min(cap, 30);
    if (cap > 0 && now - this.last < 1000 / cap - 2) {
      // Frame-rate cap: skip this display refresh (saves battery on phones)
      requestAnimationFrame(this.frame);
      return;
    }
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.1, raw);
    this.last = now;
    resolution.frame(this.ctx, raw, cap);
    if (this.state) {
      this.state.update(dt);
      this.state.render();
    }
    if (this.ctx.save.settings.showFps) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc > 0.5) {
        this.fpsEl.style.display = '';
        this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps`;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
    } else this.fpsEl.style.display = 'none';
    requestAnimationFrame(this.frame);
  };

  /**
   * Tear the current state down BEFORE the next one is built: both touch shared
   * scene state (shadow casting, the hemisphere light, the environment map), so
   * constructing first and disposing second would let the old state's cleanup
   * undo the new state's setup (a "Revert to launch" flight without shadows).
   */
  private setState(make: () => GameState): void {
    if (this.state) this.state.dispose();
    this.state = null;
    this.ctx.input.flush();
    this.state = make();
    this.hidePause();
  }

  openMenu(focusMission?: string): void {
    this.setState(() =>
      new MenuState(this.ctx, focusMission ?? null, {
        onCampaign: (m) => this.openVAB(m, null),
        onSandbox: () => this.openVAB(null, null),
        onQuickLaunch: (tplId, siteId, tod) => {
          const t = TEMPLATES.find((x) => x.id === tplId)!;
          this.launch({ craft: t.build(), site: getLaunchSite(siteId), timeOfDay: tod, mission: null });
        },
        onMission: (m) => {
          const t = TEMPLATES.find((x) => x.id === m.template)!;
          this.launch({ craft: t.build(), site: getLaunchSite(m.site), timeOfDay: m.timeOfDay, mission: m });
        },
      }),
    );
  }

  openVAB(mission: MissionDef | null, craft: CraftData | null): void {
    this.setState(() =>
      new VABState(this.ctx, {
        mission,
        craft,
        onLaunch: (c, siteId, tod) => this.launch({ craft: c, site: getLaunchSite(siteId), timeOfDay: tod, mission }),
        onExit: () => this.openMenu(),
      }),
    );
  }

  launch(req: LaunchRequest): void {
    this.lastLaunch = req;
    const now = new Date(Date.UTC(2026, 8, 24));
    let ut = launchUtFor(now, req.site.lon, req.timeOfDay);
    let heading = req.mission?.heading ?? 90;
    let planeNormal: Vector3 | null = null;
    if (req.timeOfDay === 'lunar') {
      // Search the day for the time/azimuth that puts the Moon in the orbit plane
      const w = lunarLaunchWindow(this.ctx.system, req.site, ut);
      ut = w.ut;
      heading = w.heading;
      planeNormal = w.normal;
    } else if (req.timeOfDay === 'mars') {
      // Next Earth–Mars transfer window (Lambert porkchop search), aligned launch plane
      const w = marsLaunchWindow(this.ctx.system, req.site, ut);
      ut = w.ut;
      heading = w.heading;
      planeNormal = w.normal;
    }
    const mission = req.mission ? new MissionRuntime(req.mission) : null;
    let fs: FlightState | null = null;
    this.setState(() => {
      fs = new FlightState(this.ctx, {
        craft: JSON.parse(JSON.stringify(req.craft)) as CraftData,
        site: req.site,
        startUt: Number.isFinite(ut) ? ut : utFromDate(now),
        heading,
        planeNormal,
        targetKm: req.mission?.targetKm ?? 200,
        mission,
        onExit: (r) => (r === 'vab' ? this.openVAB(req.mission, req.craft) : this.openMenu()),
      });
      return fs;
    });
    if (mission && fs) {
      const flight: FlightState = fs;
      mission.onFinish = (status) => this.showMissionResult(mission, status, flight);
    }
  }

  private showMissionResult(m: MissionRuntime, status: 'active' | 'success' | 'failed', fs: FlightState): void {
    const save = this.ctx.save;
    const ok = status === 'success';
    // Freeze the flight behind the debrief (the stats shown must not go stale,
    // and the rocket must not crash while the player reads); "Keep flying" resumes
    fs.sim.paused = true;
    let newRecord = false;
    if (ok) {
      if (!save.campaign.completed.includes(m.def.id)) save.campaign.completed.push(m.def.id);
      const stars = m.finalize(fs.sim);
      newRecord = stars > (save.campaign.scores[m.def.id] ?? 0);
      save.campaign.scores[m.def.id] = Math.max(save.campaign.scores[m.def.id] ?? 0, stars);
      writeSave(save);
      this.ctx.platform.haptic('success');
    } else this.ctx.platform.haptic('error');
    const v = fs.sim.active;
    const next = MISSIONS[MISSIONS.findIndex((x) => x.id === m.def.id) + 1];
    clear(this.pauseEl);
    this.pauseView = 'result';
    this.armBack();
    const starsRow = h('div', { class: 'res-stars' });
    for (let i = 0; i < 3; i++) starsRow.appendChild(h('span', { class: `rs${ok && i < m.stars ? ' on' : ''}`, text: '★', style: `animation-delay:${0.25 + i * 0.35}s` }));
    const bonus = h('div', { class: 'res-bonus' },
      ...m.bonusViews(fs.sim).map((b) => h('div', { class: `rb${b.ok ? ' ok' : ''}` }, h('span', { class: 'rb-i', text: b.ok ? '✓' : '·' }), h('span', { text: b.text }))),
    );
    const story = STORY[m.def.id];
    const lines = story ? (ok ? story.success : story.failure) : [];
    const debrief = h('div', { class: 'res-debrief' },
      ...lines.map((b) => h('div', { class: 'rd' }, h('div', { class: 'rd-p', html: portraitSvg(b.who, 34) }), h('div', {}, h('div', { class: 'rd-n', text: CAST[b.who].name, style: `color:${CAST[b.who].color}` }), h('div', { class: 'rd-t', text: b.text })))),
    );
    this.pauseEl.appendChild(
      h('div', { class: 'modal card modal-result' },
        h('div', { class: `modal-kicker ${ok ? 'good' : 'bad'}`, text: ok ? (newRecord ? 'Mission complete · new best' : 'Mission complete') : 'Mission failed' }),
        h('div', { class: 'modal-title', text: m.def.title }),
        ok ? starsRow : h('div', { class: 'modal-sub', text: m.failReason || 'Objectives not met' }),
        ok ? bonus : null,
        lines.length ? debrief : null,
        h('div', { class: 'stats' },
          ...[
            ['Max altitude', `${(v.maxAltitude / 1000).toFixed(1)} km`],
            ['Max speed', `${(v.maxSpeed / 1000).toFixed(2)} km/s`],
            ['Max G', m.stats.maxG.toFixed(2)],
            ['Δv spent', `${v.dvExpended.toFixed(0)} m/s`],
            ['Peak heat', `${Math.round(m.stats.maxHeat * 100)} %`],
            ['Mission time', fs.sim.missionTime > 86400 * 2 ? `${(fs.sim.missionTime / 86400).toFixed(1)} days` : `${Math.floor(fs.sim.missionTime / 60)} min`],
          ].map(([k, val]) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k! }), h('div', { class: 'v mono', text: val! }))),
        ),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', text: 'Keep flying', onClick: () => this.hidePause() }),
          h('button', { class: 'btn', text: 'Revert to launch', onClick: () => this.lastLaunch && this.launch(this.lastLaunch) }),
          ok && next
            ? h('button', { class: 'btn primary', text: `Next: ${next.title}`, onClick: () => this.openMenu(next.id) })
            : h('button', { class: 'btn primary', text: 'Main menu', onClick: () => this.openMenu() }),
        ),
      ),
    );
    this.pauseEl.style.display = '';
  }

  private hidePause(): void {
    this.pauseEl.style.display = 'none';
    clear(this.pauseEl);
    this.pauseView = null;
    if (this.unbackPause) {
      this.unbackPause();
      this.unbackPause = null;
    }
    if (this.state instanceof FlightState) this.state.sim.paused = false;
  }

  togglePause(): void {
    if (!(this.state instanceof FlightState)) return;
    const fs = this.state;
    if (this.pauseEl.style.display !== 'none') {
      this.hidePause();
      return;
    }
    fs.sim.paused = true;
    this.showPauseMenu(fs);
  }

  private showPauseMenu(fs: FlightState): void {
    clear(this.pauseEl);
    this.pauseView = 'menu';
    this.armBack();
    const req = this.lastLaunch;
    this.pauseEl.appendChild(
      h('div', { class: 'modal card' },
        h('div', { class: 'modal-kicker', text: 'Flight paused' }),
        h('div', { class: 'modal-title', text: fs.sim.active.name }),
        h('div', { class: 'modal-actions col' },
          h('button', { class: 'btn primary', text: 'Resume', onClick: () => this.hidePause() }),
          h('button', { class: 'btn', text: 'Settings', onClick: () => this.showPauseSettings(fs) }),
          h('button', { class: 'btn', text: 'Revert to launch', onClick: () => req && this.launch(req) }),
          h('button', { class: 'btn', text: 'Back to assembly', onClick: () => req && this.openVAB(req.mission, req.craft) }),
          h('button', { class: 'btn', text: 'Main menu', onClick: () => this.openMenu() }),
        ),
      ),
    );
    this.pauseEl.style.display = '';
  }

  private showPauseSettings(fs: FlightState): void {
    clear(this.pauseEl);
    this.pauseView = 'settings';
    this.pauseEl.appendChild(
      h('div', { class: 'modal card modal-wide' },
        h('div', { class: 'mp-h' }, h('span', { text: 'Settings' }), h('button', { class: 'btn ghost small', text: '← Back', onClick: () => this.showPauseMenu(fs) })),
        buildSettingsPanel(this.ctx),
      ),
    );
  }
}
