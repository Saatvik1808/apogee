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
import type { CraftData } from '../parts/Craft';
import { TEMPLATES } from '../parts/Templates';
import { utFromDate } from '../physics/Ephemeris';
import { h, clear } from '../ui/dom';
import { getLaunchSite, type LaunchSite } from '../world/LaunchSites';
import { FlightState } from './FlightState';
import { lunarLaunchWindow } from './LaunchWindow';
import type { GameContext, GameState } from './GameContext';
import { MenuState } from './MenuState';
import { launchUtFor, MISSIONS, MissionRuntime, type MissionDef, type LaunchTimeOfDay } from './Missions';
import { writeSave } from './Save';
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
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
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

  private setState(s: GameState): void {
    if (this.state) this.state.dispose();
    this.state = s;
    this.hidePause();
  }

  openMenu(): void {
    this.setState(
      new MenuState(this.ctx, {
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
    this.setState(
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
    let heading = 90;
    if (req.timeOfDay === 'lunar') {
      // Search the day for the time/azimuth that puts the Moon in the orbit plane
      const w = lunarLaunchWindow(this.ctx.system, req.site, ut);
      ut = w.ut;
      heading = w.heading;
    }
    const mission = req.mission ? new MissionRuntime(req.mission) : null;
    const fs = new FlightState(this.ctx, {
      craft: JSON.parse(JSON.stringify(req.craft)) as CraftData,
      site: req.site,
      startUt: Number.isFinite(ut) ? ut : utFromDate(now),
      heading,
      mission,
      onExit: (r) => (r === 'vab' ? this.openVAB(req.mission, req.craft) : this.openMenu()),
    });
    if (mission) {
      mission.onFinish = (status) => this.showMissionResult(mission, status, fs);
    }
    this.setState(fs);
  }

  private showMissionResult(m: MissionRuntime, status: 'active' | 'success' | 'failed', fs: FlightState): void {
    const save = this.ctx.save;
    if (status === 'success' && !save.campaign.completed.includes(m.def.id)) {
      save.campaign.completed.push(m.def.id);
      writeSave(save);
    }
    const v = fs.sim.active;
    const next = MISSIONS[MISSIONS.findIndex((x) => x.id === m.def.id) + 1];
    clear(this.pauseEl);
    const ok = status === 'success';
    this.pauseEl.appendChild(
      h('div', { class: 'modal card' },
        h('div', { class: `modal-kicker ${ok ? 'good' : 'bad'}`, text: ok ? 'Mission complete' : 'Mission failed' }),
        h('div', { class: 'modal-title', text: m.def.title }),
        h('div', { class: 'modal-sub', text: ok ? m.def.subtitle : m.failReason || 'Objectives not met' }),
        h('div', { class: 'stats' },
          ...[
            ['Max altitude', `${(v.maxAltitude / 1000).toFixed(1)} km`],
            ['Max speed', `${(v.maxSpeed / 1000).toFixed(2)} km/s`],
            ['Max Q', `${(v.maxQ / 1000).toFixed(1)} kPa`],
            ['Max G', v.maxG.toFixed(2)],
            ['Δv spent', `${v.dvExpended.toFixed(0)} m/s`],
            ['Mission time', `${Math.floor(fs.sim.missionTime / 60)} min`],
          ].map(([k, val]) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k! }), h('div', { class: 'v mono', text: val! }))),
        ),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', text: 'Keep flying', onClick: () => this.hidePause() }),
          h('button', { class: 'btn', text: 'Revert to launch', onClick: () => this.lastLaunch && this.launch(this.lastLaunch) }),
          ok && next
            ? h('button', { class: 'btn primary', text: `Next: ${next.title}`, onClick: () => this.openVAB(next, null) })
            : h('button', { class: 'btn primary', text: 'Main menu', onClick: () => this.openMenu() }),
        ),
      ),
    );
    this.pauseEl.style.display = '';
  }

  private hidePause(): void {
    this.pauseEl.style.display = 'none';
    clear(this.pauseEl);
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
    clear(this.pauseEl);
    const req = this.lastLaunch;
    this.pauseEl.appendChild(
      h('div', { class: 'modal card' },
        h('div', { class: 'modal-kicker', text: 'Flight paused' }),
        h('div', { class: 'modal-title', text: fs.sim.active.name }),
        h('div', { class: 'modal-actions col' },
          h('button', { class: 'btn primary', text: 'Resume', onClick: () => this.hidePause() }),
          h('button', { class: 'btn', text: 'Revert to launch', onClick: () => req && this.launch(req) }),
          h('button', { class: 'btn', text: 'Back to assembly', onClick: () => req && this.openVAB(req.mission, req.craft) }),
          h('button', { class: 'btn', text: 'Main menu', onClick: () => this.openMenu() }),
        ),
      ),
    );
    this.pauseEl.style.display = '';
  }
}
