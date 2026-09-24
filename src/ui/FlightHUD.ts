/**
 * LEARNING NOTE: A flight HUD that teaches orbital mechanics
 *
 * Everything a real flight controller watches is here: altitude and vertical
 * speed, Mach number and dynamic pressure (max-Q is the moment of peak
 * aerodynamic stress), g-load, apoapsis/periapsis with time-to-reach, inclination,
 * thrust-to-weight and remaining Δv per stage. Watching Ap and Pe change while you
 * burn is the fastest way to build intuition for orbits: burn prograde at Ap to
 * raise Pe, and so on.
 *
 * The navball shows attitude plus markers for orbital directions; clicking a SAS
 * mode makes the autopilot hold that direction.
 *
 * Key concepts: telemetry, flight displays, throttled UI updates (text refreshed at
 * ~15 Hz while markers move every frame)
 */
import './hud.css';
import { Vector3 } from 'three';
import { formatDistance, formatDuration, formatMass, formatSpeed } from '../core/math';
import { RAD } from '../core/constants';
import type { StageInfo } from '../parts/DeltaV';
import { PROPELLANTS, type PropellantId } from '../parts/Propellants';
import type { FlightSim } from '../sim/FlightSim';
import { WARP_LEVELS } from '../sim/FlightSim';
import type { SASMode, Vessel } from '../sim/Vessel';
import { dateFromUt } from '../physics/Ephemeris';
import { orbitalFrame } from '../physics/Orbit';
import { h, setText, clear } from './dom';
import { ICONS, RETICLE_SVG, sasIcon } from './icons';
import type { Navball } from './Navball';

export interface HudActions {
  stage(): void;
  warpUp(): void;
  warpDown(): void;
  stopWarp(): void;
  togglePause(): void;
  toggleSAS(): void;
  setSASMode(m: SASMode): void;
  cycleSpeedMode(): void;
  setThrottle(t: number): void;
  toggleMap(): void;
  toggleLegs(): void;
  engageAscent(targetKm: number, heading: number): void;
  executeNode(): void;
  warpToNode(): void;
  engageLanding(): void;
  disengageAutopilot(): void;
  /** Ask the flight computer to plan a maneuver node; returns a status message. */
  plan(kind: PlanKind): { ok: boolean; message: string };
  deleteNodes(): void;
  /** Cycle the navigation target through the Moon, Mars and the other vessels of this flight. */
  cycleTarget(): void;
  toggleRcs(): void;
  undock(): void;
  /** Hand control to the next / previous vessel of this flight. */
  switchVessel(dir: 1 | -1): void;
}

export type PlanKind = 'circ-ap' | 'circ-pe' | 'capture' | 'tli' | 'tmi' | 'mcc' | 'tei' | 'deorbit' | 'intercept' | 'match';

export interface TargetView {
  name: string;
  isVessel: boolean;
  /** Range (m) and relative speed (m/s); NaN for a body target. */
  distance: number;
  relSpeed: number;
  /** Predicted closest approach (m) and seconds until it (NaN if unknown). */
  caDistance: number;
  caIn: number;
}

export interface ObjectiveView {
  text: string;
  state: 'pending' | 'active' | 'done' | 'failed';
}

export interface HudExtra {
  missionTitle: string;
  missionSub: string;
  objectives: ObjectiveView[];
  stageInfo: StageInfo[];
  navballSize: number;
  mapView: boolean;
  target: TargetView | null;
  rcs: boolean;
  /** A module is docked to the active vessel (Undock becomes available). */
  docked: boolean;
  /** Controllable vessels in this flight (switching becomes available above one). */
  vessels: number;
}

const SAS_MODES: SASMode[] = ['stability', 'maneuver', 'prograde', 'retrograde', 'normal', 'antinormal', 'radial-out', 'radial-in', 'target', 'anti-target'];

const _p = new Vector3();
const _n = new Vector3();
const _r = new Vector3();
const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _tmp = new Vector3();
const _right = new Vector3();
const _dorsal = new Vector3();
const _nose = new Vector3();
const _vel = new Vector3();
const _tgt = new Vector3();
const _tgtVel = new Vector3();
const _dir = new Vector3();
const _proj = { x: 0, y: 0, front: false };

interface Row {
  row: HTMLDivElement;
  v: HTMLSpanElement;
}

export class FlightHUD {
  readonly root: HTMLDivElement;
  private readonly actions: HudActions;
  private readonly navball: Navball;
  // top bar
  private readonly met: HTMLDivElement;
  private readonly ut: HTMLDivElement;
  private readonly warpVal: HTMLDivElement;
  private readonly pips: HTMLDivElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly sigChip: HTMLSpanElement;
  private sigKey = '';
  // mission
  private readonly mTitle: HTMLDivElement;
  private readonly mSub: HTMLDivElement;
  private readonly objList: HTMLDivElement;
  private lastObjKey = '';
  private readonly events: HTMLDivElement;
  // telemetry
  private readonly rows = new Map<string, Row>();
  // navball
  readonly ballFrame: HTMLDivElement;
  private readonly markers = new Map<string, HTMLDivElement>();
  private readonly markerShown = new Map<string, boolean>();
  private readonly shownMarkers = new Set<string>();
  private ballSize = -1;
  private pauseShown: boolean | null = null;
  private readonly speedMode: HTMLSpanElement;
  private readonly speedVal: HTMLSpanElement;
  private readonly warnChip: HTMLSpanElement;
  private readonly hdg: HTMLDivElement;
  private readonly sasBtns = new Map<SASMode, HTMLDivElement>();
  private readonly sasMaster: HTMLDivElement;
  private readonly thrFill: HTMLDivElement;
  private readonly thrVal: HTMLDivElement;
  private readonly gFill: HTMLDivElement;
  private readonly gVal: HTMLDivElement;
  private readonly heatFill: HTMLDivElement;
  private readonly heatVal: HTMLDivElement;
  // staging & resources
  private readonly stagesEl: HTMLDivElement;
  private lastStageKey = '';
  private readonly resEl: HTMLDivElement;
  private lastResKey = '';
  private readonly legsBtn: HTMLButtonElement;
  private readonly rcsBtn: HTMLButtonElement;
  private readonly undockBtn: HTMLButtonElement;
  private readonly switchBtn: HTMLButtonElement;
  // target
  private readonly tgtName: HTMLSpanElement;
  private readonly tgtInfo: HTMLSpanElement;
  // autopilot
  private apTab: 'ascent' | 'node' | 'land' = 'ascent';
  private readonly apBody: HTMLDivElement;
  private readonly apStatus: HTMLDivElement;
  private readonly apAlt: HTMLInputElement;
  private readonly apHdg: HTMLInputElement;
  private readonly toast: HTMLDivElement;
  private readonly warnBanner: HTMLDivElement;
  private warnText = '';
  private toastTimer = 0;
  private readonly help: HTMLDivElement;
  private textTimer = 0;
  readonly mapBtn: HTMLButtonElement;

  private readonly panelState = { telemetry: false, computer: false };

  constructor(parent: HTMLElement, actions: HudActions, navball: Navball, touch = false) {
    this.actions = actions;
    this.navball = navball;
    this.root = h('div', { class: `hud${touch ? ' touch' : ''}` });

    // --- top bar ---
    this.met = h('div', { class: 'val', text: 'T− 00:00' });
    this.ut = h('div', { class: 'val', text: '' });
    this.warpVal = h('div', { class: 'val', text: '1×' });
    this.pips = h('div', { class: 'pips' });
    for (let i = 0; i < WARP_LEVELS.length; i++) this.pips.appendChild(h('i'));
    this.pauseBtn = h('button', { class: 'wbtn', html: ICONS.pause, title: 'Pause (P)', onClick: () => actions.togglePause() });
    this.sigChip = h('span', { class: 'sig-chip', text: 'LINK' });
    const top = h(
      'div',
      { class: 'topbar card pe' },
      h('div', { class: 'seg met' }, h('div', { class: 'lbl', text: 'Mission time' }), this.met),
      h('div', { class: 'seg sig' }, h('div', { class: 'lbl', text: 'Comms' }), this.sigChip),
      h('div', { class: 'seg utc' }, h('div', { class: 'lbl', text: 'UTC' }), this.ut),
      h(
        'div',
        { class: 'seg warp' },
        h('button', { class: 'wbtn', html: ICONS.back, title: 'Slower (,)', onClick: () => actions.warpDown() }),
        this.pauseBtn,
        h('div', { class: 'wlevel' }, h('div', { class: 'lbl', text: 'Time warp' }), this.warpVal, this.pips),
        h('button', { class: 'wbtn', html: ICONS.fwd, title: 'Faster (.)', onClick: () => actions.warpUp() }),
      ),
    );
    this.root.appendChild(top);

    // --- mission ---
    this.mTitle = h('div', { class: 'title', text: '' });
    this.mSub = h('div', { class: 'sub', text: '' });
    this.objList = h('div', { style: 'padding-bottom:8px' });
    const missionCard = h('div', { class: 'mission card pe' }, h('div', { class: 'card-h' }, h('span', { text: 'Mission' }), h('span', { class: 'accent', text: '●' })), this.mTitle, this.mSub, this.objList);
    // On phones the card shows only the current objective; tap to see them all
    missionCard.addEventListener('click', () => missionCard.classList.toggle('expanded'));
    this.root.appendChild(missionCard);
    this.events = h('div', { class: 'events' });
    this.root.appendChild(this.events);

    // --- telemetry ---
    const telem = h('div', { class: 'telem card pe' }, h('div', { class: 'card-h' }, h('span', { text: 'Telemetry' }), h('span', { class: 'accent', text: 'LIVE' })));
    const grp = (title: string, keys: Array<[string, string, boolean?]>) => {
      const g = h('div', { class: 'grp' }, h('div', { class: 'grp-h', text: title }));
      for (const [key, label, big] of keys) {
        const v = h('span', { class: `v${big ? ' big' : ''}`, text: '—' });
        const row = h('div', { class: 'row' }, h('span', { class: 'k', text: label }), v);
        this.rows.set(key, { row, v });
        g.appendChild(row);
      }
      telem.appendChild(g);
    };
    grp('Flight', [
      ['alt', 'Altitude', true],
      ['radar', 'Radar alt'],
      ['vs', 'Vertical spd'],
      ['hs', 'Horiz. spd'],
      ['mach', 'Mach'],
      ['q', 'Dyn. pressure'],
      ['aoa', 'Angle of attack'],
      ['wind', 'Wind'],
    ]);
    grp('Orbit', [
      ['soi', 'Body'],
      ['ap', 'Apoapsis', true],
      ['pe', 'Periapsis', true],
      ['inc', 'Inclination'],
      ['ecc', 'Eccentricity'],
      ['period', 'Period'],
      ['next', 'Next event'],
    ]);
    grp('Vessel', [
      ['mass', 'Mass'],
      ['twr', 'TWR'],
      ['sdv', 'Stage Δv'],
      ['tdv', 'Total Δv'],
      ['sit', 'Situation'],
    ]);
    this.root.appendChild(telem);

    // --- navball cluster ---
    this.speedMode = h('span', { class: 'mode', text: 'SURFACE' });
    this.speedVal = h('span', { class: 'spd', text: '0.0 m/s' });
    this.warnChip = h('span', { class: 'warnchip', text: '' });
    const speedbox = h('div', { class: 'speedbox card pe', title: 'Click to cycle surface / orbit / target speed', onClick: () => actions.cycleSpeedMode() }, this.speedMode, this.speedVal, this.warnChip);
    this.ballFrame = h('div', { class: 'ballframe' });
    this.ballFrame.appendChild(h('div', { class: 'reticle', html: RETICLE_SVG }));
    for (const m of ['prograde', 'retrograde', 'normal', 'antinormal', 'radial-out', 'radial-in', 'target', 'anti-target', 'maneuver'] as SASMode[]) {
      const el = h('div', { class: 'marker', html: sasIcon(m, 26) });
      el.style.display = 'none';
      this.ballFrame.appendChild(el);
      this.markers.set(m, el);
    }
    this.hdg = h('div', { class: 'hdg', text: '' });
    const navwrap = h('div', { class: 'navwrap' }, speedbox, this.ballFrame, this.hdg);

    // SAS grid
    this.sasMaster = h('div', { class: 'sasbtn master pe', text: 'SAS', title: 'Toggle SAS (T)', onClick: () => actions.toggleSAS() });
    const sasGrid = h('div', { class: 'sasgrid card pe' }, this.sasMaster);
    for (const m of SAS_MODES) {
      const b = h('div', { class: 'sasbtn', html: sasIcon(m, 20), title: m.replace('-', ' '), onClick: () => actions.setSASMode(m) });
      this.sasBtns.set(m, b);
      sasGrid.appendChild(b);
    }

    // Gauges: throttle, G, heat
    const mkGauge = (cls: string, label: string) => {
      const fill = h('div', { class: 'fill' });
      const track = h('div', { class: 'track' }, fill);
      const val = h('div', { class: 'gv', text: '0' });
      const g = h('div', { class: `gauge ${cls}` }, h('div', { class: 'gl', text: label }), track, val);
      return { g, fill, track, val };
    };
    const thr = mkGauge('thr', 'THR');
    this.thrFill = thr.fill;
    this.thrVal = thr.val;
    const setThrFromPointer = (e: PointerEvent) => {
      const r = thr.track.getBoundingClientRect();
      actions.setThrottle(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)));
    };
    thr.track.addEventListener('pointerdown', (e) => {
      thr.track.setPointerCapture(e.pointerId);
      setThrFromPointer(e);
    });
    thr.track.addEventListener('pointermove', (e) => {
      if (thr.track.hasPointerCapture(e.pointerId)) setThrFromPointer(e);
    });
    const gg = mkGauge('g', 'G');
    this.gFill = gg.fill;
    this.gVal = gg.val;
    const hg = mkGauge('heat', 'HEAT');
    this.heatFill = hg.fill;
    this.heatVal = hg.val;
    const gauges = h('div', { class: 'gauges card pe' }, thr.g, gg.g, hg.g);
    this.root.appendChild(h('div', { class: 'navcluster' }, gauges, navwrap, sasGrid));

    // --- staging ---
    this.stagesEl = h('div', { class: 'stages' });
    const stageBtn = h('button', { class: 'btn primary stagebtn pe', text: touch ? 'Stage ▸' : 'Stage ▸  Space', onClick: () => actions.stage() });
    this.root.appendChild(h('div', { class: 'staging card pe' }, h('div', { class: 'card-h' }, h('span', { text: 'Staging' }), h('span', { class: 'accent', text: '▲' })), this.stagesEl, stageBtn));

    // --- resources + autopilot ---
    this.resEl = h('div', { class: 'res' });
    this.legsBtn = h('button', { class: 'btn small', text: 'Legs (G)', onClick: () => actions.toggleLegs() });
    this.rcsBtn = h('button', { class: 'btn small', text: 'RCS (R)', title: 'Arm the reaction-control thrusters: H/N fore-aft, I/K up-down, J/L left-right', onClick: () => actions.toggleRcs() });
    this.undockBtn = h('button', { class: 'btn small', text: 'Undock', title: 'Release the docked module', onClick: () => actions.undock() });
    this.undockBtn.style.display = 'none';
    this.switchBtn = h('button', { class: 'btn small', text: 'Switch vessel ( ] )', title: 'Control another vessel of this flight', onClick: () => actions.switchVessel(1) });
    this.switchBtn.style.display = 'none';
    const resCard = h(
      'div',
      { class: 'card pe' },
      h('div', { class: 'card-h' }, h('span', { text: 'Resources' })),
      this.resEl,
      h('div', { class: 'toggles' }, this.legsBtn, this.rcsBtn, this.undockBtn, this.switchBtn),
    );
    // Navigation target strip (top of the flight computer)
    this.tgtName = h('span', { class: 'tgt-name', text: 'No target' });
    this.tgtInfo = h('span', { class: 'tgt-info mono', text: '' });
    const tgtRow = h('div', { class: 'tgtrow' }, h('button', { class: 'btn small', text: 'Target ▸', title: 'Cycle the target: Moon, Mars, other vessels (map view: click a label)', onClick: () => actions.cycleTarget() }), this.tgtName, this.tgtInfo);
    this.apAlt = h('input', { type: 'number', value: '200' });
    this.apHdg = h('input', { type: 'number', value: '90' });
    this.apBody = h('div');
    this.apStatus = h('div', { class: 'status', text: '' });
    const tabs = h('div', { class: 'tabs' });
    for (const t of ['ascent', 'node', 'land'] as const) {
      tabs.appendChild(
        h('button', {
          class: `btn small${t === this.apTab ? ' active' : ''}`,
          text: t === 'node' ? 'Maneuver' : t,
          onClick: (e) => {
            this.apTab = t;
            for (const b of tabs.children) b.classList.remove('active');
            (e.currentTarget as HTMLElement).classList.add('active');
            this.renderAp();
          },
        }),
      );
    }
    const apCard = h('div', { class: 'card pe' }, h('div', { class: 'card-h' }, h('span', { text: 'Flight Computer' }), h('span', { class: 'accent', text: 'AUTO' })), tgtRow, h('div', { class: 'ap' }, tabs, this.apBody, this.apStatus));
    this.root.appendChild(h('div', { class: 'rightcol' }, resCard, apCard));
    this.renderAp();

    this.mapBtn = h('button', { class: 'btn pe mapbtn', html: `${ICONS.map}&nbsp; Map (M)`, onClick: () => actions.toggleMap() });
    this.root.appendChild(this.mapBtn);

    this.toast = h('div', { class: 'toast' });
    this.root.appendChild(this.toast);
    this.warnBanner = h('div', { class: 'warnbanner' });
    this.root.appendChild(this.warnBanner);

    this.help = h('div', { class: 'help', onClick: () => this.help.classList.remove('show') });
    const touchRows: Array<[string, string]> = [
      ['Left slider', 'Throttle (MAX / CUT buttons at the ends)'],
      ['Right stick', 'Pitch and yaw · ROLL buttons above it'],
      ['STAGE', 'Launch / activate the next stage'],
      ['Drag · pinch', 'Rotate · zoom the camera'],
      ['Map ◎ then tap an orbit', 'Add a maneuver node there'],
      ['Chart / chip icons', 'Telemetry · flight computer (autopilot, burns)'],
      ['Eye', 'Photo mode (hide the HUD)'],
      ['Back button', 'Pause menu'],
    ];
    const rows: Array<[string, string]> = touch ? touchRows : [
      ['W / S', 'Pitch down / up'],
      ['A / D', 'Yaw left / right'],
      ['Q / E', 'Roll left / right'],
      ['Shift / Ctrl', 'Throttle up / down'],
      ['Z / X', 'Full throttle / cut engines'],
      ['Space', 'Activate next stage'],
      ['T', 'Toggle SAS (attitude hold)'],
      ['G', 'Toggle landing legs'],
      [', / .', 'Time warp down / up'],
      ['/', 'Stop warp'],
      ['M', 'Map view'],
      ['V', 'Cycle camera (chase / tower / free)'],
      ['Mouse drag / wheel', 'Rotate / zoom camera'],
      ['N (map)', 'Add maneuver node at cursor'],
      ['Click a label (map)', 'Target that vessel · click again to fly it'],
      ['[ / ]', 'Switch to the previous / next vessel'],
      ['R', 'Toggle RCS thrusters'],
      ['H / N · I / K · J / L', 'RCS translate: forward / back · up / down · left / right'],
      ['P', 'Pause'],
      ['Esc', 'Flight menu'],
      ['F1', 'This help'],
      ];
    const tbl = h('table');
    for (const [k, d] of rows) tbl.appendChild(h('tr', {}, h('td', {}, h('kbd', { text: k })), h('td', { text: d })));
    this.help.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-h', text: touch ? 'Touch controls' : 'Flight controls' }), h('div', { style: 'padding:10px' }, tbl)));
    this.root.appendChild(this.help);

    parent.appendChild(this.root);
  }

  /** Pre-fill the ascent autopilot (e.g. with a launch-window azimuth). */
  setAscentDefaults(altKm: number, heading: number): void {
    this.apAlt.value = String(Math.round(altKm));
    this.apHdg.value = heading.toFixed(1);
  }

  toggleHelp(): void {
    this.help.classList.toggle('show');
  }

  /** Communications status: link (with light-time delay when far out), LOS or blackout. */
  setSignal(state: 'link' | 'los' | 'blackout', lightTime: number): void {
    const delay = lightTime > 60 ? `${Math.floor(lightTime / 60)}m ${Math.round(lightTime % 60)}s` : lightTime > 0.5 ? `${lightTime.toFixed(1)} s` : '';
    const text = state === 'los' ? 'LOS' : state === 'blackout' ? 'BLACKOUT' : delay ? `LINK ${delay}` : 'LINK';
    const key = state + text;
    if (key === this.sigKey) return;
    this.sigKey = key;
    this.sigChip.textContent = text;
    this.sigChip.className = `sig-chip ${state === 'link' ? '' : state}`;
    this.sigChip.parentElement?.classList.toggle('alert', state !== 'link');
  }

  /** Phones: telemetry and the flight computer are pull-out panels. */
  togglePanel(p: 'telemetry' | 'computer'): void {
    const other = p === 'telemetry' ? 'computer' : 'telemetry';
    this.panelState[p] = !this.panelState[p];
    // One panel at a time on small screens
    if (this.panelState[p]) this.panelState[other] = false;
    this.root.classList.toggle('show-telem', this.panelState.telemetry);
    this.root.classList.toggle('show-computer', this.panelState.computer);
  }

  get panels(): { telemetry: boolean; computer: boolean } {
    return this.panelState;
  }

  private renderAp(): void {
    clear(this.apBody);
    if (this.apTab === 'ascent') {
      this.apBody.appendChild(h('label', {}, h('span', { text: 'Target orbit (km)' }), this.apAlt));
      this.apBody.appendChild(h('label', {}, h('span', { text: 'Heading (°)' }), this.apHdg));
      this.apBody.appendChild(
        h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
          h('button', { class: 'btn small primary', style: 'flex:1', text: 'Engage', onClick: () => this.actions.engageAscent(Number(this.apAlt.value) || 200, Number(this.apHdg.value) || 90) }),
          h('button', { class: 'btn small', text: 'Off', onClick: () => this.actions.disengageAutopilot() }),
        ),
      );
    } else if (this.apTab === 'node') {
      const msg = h('div', { class: 'plan-msg', text: 'Plan a burn: pick one below, or place a node in map view (M, then N).' });
      const plan = (kind: PlanKind) => {
        // Transfer searches take up to a second: show feedback first, compute next frame
        msg.textContent = 'Planning…';
        msg.classList.remove('bad', 'good');
        setTimeout(() => {
          const r = this.actions.plan(kind);
          msg.textContent = r.message;
          msg.classList.toggle('bad', !r.ok);
          msg.classList.toggle('good', r.ok);
        }, 40);
      };
      const b = (label: string, kind: PlanKind, title: string) => h('button', { class: 'btn small', text: label, title, onClick: () => plan(kind) });
      this.apBody.appendChild(
        h('div', { class: 'plan-grid' },
          b('Circ. @ Ap', 'circ-ap', 'Circularise at the next apoapsis'),
          b('Circ. @ Pe', 'circ-pe', 'Circularise at the next periapsis'),
          b('Capture', 'capture', 'Brake at periapsis into a loose elliptical orbit (cheapest capture)'),
          b('To the Moon', 'tli', 'Trans-lunar injection from a parking orbit'),
          b('To Mars', 'tmi', 'Trans-Mars injection from a parking orbit (launch in the Mars window)'),
          b('Fine-tune', 'mcc', 'Mid-course correction for the arrival periapsis'),
          b('Return home', 'tei', 'Trans-Earth injection from lunar orbit'),
          b('De-orbit', 'deorbit', 'Lower the periapsis for re-entry / landing'),
          b('Intercept', 'intercept', 'Rendezvous step 1: transfer to meet the target vessel (waits for the right phase)'),
          b('Match velocity', 'match', 'Rendezvous step 2: cancel the relative velocity at closest approach'),
        ),
      );
      this.apBody.appendChild(msg);
      this.apBody.appendChild(
        h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
          h('button', { class: 'btn small primary', style: 'flex:1', text: 'Execute', onClick: () => this.actions.executeNode() }),
          h('button', { class: 'btn small', text: 'Warp to', onClick: () => this.actions.warpToNode() }),
          h('button', { class: 'btn small', text: '✕', title: 'Delete planned nodes', onClick: () => this.actions.deleteNodes() }),
        ),
      );
    } else {
      this.apBody.appendChild(h('div', { style: 'font-size:12px;color:var(--text-dim);line-height:1.4', text: 'Powered descent: kills horizontal speed, flies a suicide-burn profile and touches down on its legs.' }));
      this.apBody.appendChild(
        h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
          h('button', { class: 'btn small primary', style: 'flex:1', text: 'Land', onClick: () => this.actions.engageLanding() }),
          h('button', { class: 'btn small', text: 'Off', onClick: () => this.actions.disengageAutopilot() }),
        ),
      );
    }
  }

  /** Master-alarm banner (empty string hides it). */
  setWarning(text: string): void {
    if (text === this.warnText) return;
    this.warnText = text;
    this.warnBanner.textContent = text;
    this.warnBanner.classList.toggle('show', !!text);
  }

  showToast(text: string, sub = '', seconds = 3): void {
    this.toast.innerHTML = '';
    this.toast.appendChild(document.createTextNode(text));
    if (sub) this.toast.appendChild(h('span', { class: 'small', text: sub }));
    this.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  logEvent(met: number, text: string, kind: 'info' | 'warn' | 'bad' | 'good' = 'info'): void {
    const el = h('div', { class: `ev ${kind === 'info' ? '' : kind}` }, h('span', { class: 't', text: formatDuration(met, true) }), text);
    this.events.appendChild(el);
    while (this.events.children.length > 7) this.events.removeChild(this.events.firstChild!);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 1300);
    }, 9000);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  private setRow(key: string, text: string, cls = ''): void {
    const r = this.rows.get(key);
    if (!r) return;
    setText(r.v, text);
    const want = `v${r.v.classList.contains('big') ? ' big' : ''}${cls ? ' ' + cls : ''}`;
    if (r.v.className !== want) r.v.className = want;
  }

  /** Per-frame update. */
  update(sim: FlightSim, extra: HudExtra, dt: number): void {
    const v = sim.active;
    this.updateNavball(sim, v, extra.navballSize);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }
    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 1 / 15;
    this.updateText(sim, v, extra);
  }

  private updateNavball(sim: FlightSim, v: Vessel, size: number): void {
    const f = this.ballFrame;
    if (size !== this.ballSize) {
      this.ballSize = size;
      f.style.width = f.style.height = `${size}px`;
    }
    _up.copy(v.r).normalize();
    _tmp.set(0, 1, 0).applyQuaternion(v.body.rotation);
    _east.crossVectors(_tmp, _up);
    if (_east.lengthSq() < 1e-10) _east.set(1, 0, 0);
    _east.normalize();
    _north.crossVectors(_up, _east).normalize();
    _right.set(1, 0, 0).applyQuaternion(v.q);
    _dorsal.set(0, 0, 1).applyQuaternion(v.q);
    _nose.set(0, 1, 0).applyQuaternion(v.q);
    this.navball.setAttitude(_right, _dorsal, _nose, _east, _north, _up);
    const mode = v.controls.speedMode;
    const vel = mode === 'surface' ? v.surfaceVelocity : mode === 'target' && sim.targetVelocity(_tgtVel) ? _vel.copy(v.v).add(v.body.velocity).sub(_tgtVel) : v.v;
    // Markers: every frame, without allocating — each direction is projected in
    // place and its element only touched when its state actually changes
    const shown = this.shownMarkers;
    shown.clear();
    const R = size / 2;
    if (vel.lengthSq() > 0.25) {
      this.placeMarker('prograde', vel, false, R, shown);
      this.placeMarker('retrograde', vel, true, R, shown);
    }
    if (!v.pinned) {
      orbitalFrame(v.r, v.v, _p, _n, _r);
      this.placeMarker('normal', _n, false, R, shown);
      this.placeMarker('antinormal', _n, true, R, shown);
      this.placeMarker('radial-out', _r, false, R, shown);
      this.placeMarker('radial-in', _r, true, R, shown);
    }
    if (sim.targetPosition(_tgt)) {
      _tgt.sub(v.absolutePosition(_tmp));
      this.placeMarker('target', _tgt, false, R, shown);
      this.placeMarker('anti-target', _tgt, true, R, shown);
    }
    const node = sim.nodes[0];
    if (node && node.remaining.lengthSq() > 1e-4) this.placeMarker('maneuver', node.remaining, false, R, shown);
    for (const [m, el] of this.markers) {
      if (!shown.has(m) && this.markerShown.get(m) !== false) {
        el.style.display = 'none';
        this.markerShown.set(m, false);
      }
    }
  }

  private placeMarker(m: SASMode, d: Vector3, negate: boolean, R: number, shown: Set<string>): void {
    const el = this.markers.get(m);
    if (!el) return;
    _dir.copy(d);
    if (negate) _dir.negate();
    this.navball.project(_dir, _proj);
    if (!_proj.front) return;
    if (this.markerShown.get(m) !== true) {
      el.style.display = '';
      this.markerShown.set(m, true);
    }
    el.style.left = `${R + _proj.x * R * 0.96}px`;
    el.style.top = `${R - _proj.y * R * 0.96}px`;
    shown.add(m);
  }

  private updateText(sim: FlightSim, v: Vessel, extra: HudExtra): void {
    // Top bar
    const met = sim.missionTime;
    setText(this.met, isNaN(sim.launchTime) ? 'T− HOLD' : `T+ ${formatDuration(met)}`);
    const d = dateFromUt(sim.time);
    setText(this.ut, `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`);
    const w = sim.warp;
    setText(this.warpVal, sim.paused ? 'PAUSED' : `${w.rate.toLocaleString('en-US')}×`);
    this.warpVal.className = `val ${sim.paused ? '' : w.rails ? 'rails' : w.rate > 1 ? 'phys' : ''}`;
    for (let i = 0; i < this.pips.children.length; i++) {
      const pip = this.pips.children[i] as HTMLElement;
      const on = i <= sim.warpIndex && i > 0;
      pip.className = on ? `on${WARP_LEVELS[i]!.rails ? '' : ' phys'}` : '';
    }
    if (this.pauseShown !== sim.paused) {
      // Re-parsing the SVG icon 15× a second is pointless: only on a change
      this.pauseShown = sim.paused;
      this.pauseBtn.innerHTML = sim.paused ? ICONS.play : ICONS.pause;
    }

    // Mission
    setText(this.mTitle, extra.missionTitle);
    setText(this.mSub, extra.missionSub);
    const objKey = extra.objectives.map((o) => o.state + o.text).join('|');
    if (objKey !== this.lastObjKey) {
      this.lastObjKey = objKey;
      clear(this.objList);
      for (const o of extra.objectives) {
        this.objList.appendChild(
          h('div', { class: `obj ${o.state === 'done' ? 'done' : o.state === 'failed' ? 'fail' : o.state === 'active' ? 'active' : ''}` },
            h('span', { class: 'box', text: o.state === 'done' ? '✓' : o.state === 'failed' ? '✕' : '' }),
            h('span', { text: o.text }),
          ),
        );
      }
    }

    // Telemetry
    const body = v.body;
    this.setRow('alt', formatDistance(v.altitude));
    this.setRow('radar', v.radarAltitude < 20_000 ? formatDistance(Math.max(0, v.radarAltitude)) : '—', v.radarAltitude < 50 && v.verticalSpeed < -8 ? 'bad' : '');
    this.setRow('vs', formatSpeed(v.verticalSpeed), v.verticalSpeed < -30 && v.radarAltitude < 2000 ? 'warn' : '');
    this.setRow('hs', formatSpeed(v.horizontalSpeed));
    this.setRow('mach', v.mach > 0.01 ? v.mach.toFixed(2) : '—');
    this.setRow('q', v.dynamicPressure > 1 ? `${(v.dynamicPressure / 1000).toFixed(1)} kPa` : '—', v.aeroLoad > 6000 ? 'bad' : v.dynamicPressure > 30_000 ? 'warn' : '');
    this.setRow('aoa', v.airDensity > 1e-6 ? `${(v.angleOfAttack * RAD).toFixed(1)}°` : '—', v.aeroLoad > 5000 ? 'bad' : '');
    const wind = v.wind.length();
    if (wind > 0.3) {
      // Compass direction the wind blows FROM
      const e = v.wind.dot(_east);
      const nn = v.wind.dot(_north);
      let from = Math.atan2(-e, -nn) * RAD;
      if (from < 0) from += 360;
      this.setRow('wind', `${wind.toFixed(0)} m/s from ${from.toFixed(0).padStart(3, '0')}°`, wind > 40 ? 'warn' : '');
    } else this.setRow('wind', '—');
    const p0 = sim.predictor.count > 0 ? sim.predictor.patches[0]! : null;
    this.setRow('soi', body.name);
    if (p0 && !v.pinned) {
      const o = p0.orbit;
      const R = body.radius;
      const tAp = o.timeToApoapsis(sim.time);
      const tPe = o.timeToPeriapsis(sim.time);
      this.setRow('ap', o.isElliptic ? `${formatDistance(o.apoapsis - R)}  ${isFinite(tAp) ? formatDuration(tAp) : ''}` : 'Escape');
      const peAlt = o.periapsis - R;
      this.setRow('pe', `${formatDistance(peAlt)}  ${isFinite(tPe) && tPe < 1e9 ? formatDuration(tPe) : ''}`, peAlt < 0 ? 'bad' : body.atmosphere && peAlt < body.atmosphere.ceiling ? 'warn' : 'good');
      this.setRow('inc', `${(o.inc * RAD).toFixed(2)}°`);
      this.setRow('ecc', o.e.toFixed(4));
      this.setRow('period', o.isElliptic ? formatDuration(o.period) : '—');
      let next = '—';
      if (p0.endReason === 'impact') next = `Impact in ${formatDuration(p0.endTime - sim.time)}`;
      else if (p0.endReason === 'soi-enter' && p0.nextBody) next = `${p0.nextBody.name} SOI in ${formatDuration(p0.endTime - sim.time)}`;
      else if (p0.endReason === 'soi-exit') next = `Escape in ${formatDuration(p0.endTime - sim.time)}`;
      else if (isFinite(p0.atmosphereEntry)) next = `Atmosphere in ${formatDuration(p0.atmosphereEntry - sim.time)}`;
      else if (sim.target && isFinite(p0.closestApproachDistance) && p0.closestApproachDistance < 5e8) next = `${sim.target.name} CA ${formatDistance(p0.closestApproachDistance)}`;
      this.setRow('next', next, p0.endReason === 'impact' ? 'warn' : '');
    } else {
      for (const k of ['ap', 'pe', 'inc', 'ecc', 'period', 'next']) this.setRow(k, '—');
    }
    this.setRow('mass', formatMass(v.mass));
    const g = body.mu / v.r.lengthSq();
    const twr = v.totalThrust / (v.mass * g);
    const maxTwr = v.maxThrustNow / (v.mass * g);
    this.setRow('twr', v.totalThrust > 0 ? `${twr.toFixed(2)} / ${maxTwr.toFixed(2)}` : maxTwr > 0 ? `0 / ${maxTwr.toFixed(2)}` : '—');
    const si = extra.stageInfo;
    const cur = si.length ? si[0]! : null;
    this.setRow('sdv', cur ? `${cur.dvVac.toFixed(0)} m/s` : '—');
    this.setRow('tdv', `${si.reduce((s, x) => s + x.dvVac, 0).toFixed(0)} m/s`);
    this.setRow('sit', v.destroyed ? 'DESTROYED' : v.situation.toUpperCase(), v.destroyed ? 'bad' : v.situation === 'orbiting' ? 'good' : '');

    // Speed box
    const mode = v.controls.speedMode;
    setText(this.speedMode, mode.toUpperCase());
    let spd = 0;
    if (mode === 'surface') spd = v.surfaceVelocity.length();
    else if (mode === 'orbit') spd = v.v.length();
    else if (sim.targetVelocity(_tgtVel)) spd = _tmp.copy(v.v).add(v.body.velocity).sub(_tgtVel).length();
    setText(this.speedVal, formatSpeed(spd));

    // Heading/pitch/roll
    const nose = _nose.set(0, 1, 0).applyQuaternion(v.q);
    const pitch = Math.asin(Math.max(-1, Math.min(1, nose.dot(_up)))) * RAD;
    let heading = Math.atan2(nose.dot(_east), nose.dot(_north)) * RAD;
    if (heading < 0) heading += 360;
    setText(this.hdg, `HDG ${heading.toFixed(0).padStart(3, '0')}°   PITCH ${pitch.toFixed(1)}°`);

    // SAS
    this.sasMaster.classList.toggle('on', v.controls.sas);
    const apOn = sim.autopilot.mode !== 'off';
    for (const [m, b] of this.sasBtns) {
      b.classList.toggle('on', v.controls.sas && !apOn && v.controls.sasMode === m);
      const disabled = (m === 'maneuver' && !sim.nodes.length) || ((m === 'target' || m === 'anti-target') && !sim.target);
      b.classList.toggle('disabled', disabled);
    }

    // Gauges
    const thr = v.controls.throttle;
    this.thrFill.style.height = `${thr * 100}%`;
    setText(this.thrVal, `${Math.round(thr * 100)}`);
    const gf = v.gForce;
    this.gFill.style.height = `${Math.min(1, gf / 8) * 100}%`;
    setText(this.gVal, gf.toFixed(1));
    let heat = 0;
    // Engines run hot by design; the gauge tracks aerodynamic / re-entry heating of the airframe
    for (const p of v.parts) if (!p.isEngine) heat = Math.max(heat, (p.temperature - 288) / Math.max(1, p.def.maxTemp - 288));
    this.heatFill.style.height = `${Math.max(0, Math.min(1, heat)) * 100}%`;
    setText(this.heatVal, `${Math.round(Math.max(0, heat) * 100)}%`);
    // Compact warning for small screens (gauges hidden): heat first, then G
    let chip = '';
    let chipCls = 'warnchip';
    if (heat > 0.4) {
      chip = `HEAT ${Math.round(heat * 100)}%`;
      chipCls += heat > 0.75 ? ' bad' : ' warn';
    } else if (gf > 3) {
      chip = `${gf.toFixed(1)} G`;
      chipCls += gf > 6 ? ' bad' : ' warn';
    }
    setText(this.warnChip, chip);
    if (this.warnChip.className !== chipCls) this.warnChip.className = chipCls;

    // Staging
    const stageKey = `${v.id}:${v.nextStage}:${v.stages.length}:${si.map((s) => Math.round(s.dvVac / 10)).join(',')}`;
    if (stageKey !== this.lastStageKey) {
      this.lastStageKey = stageKey;
      clear(this.stagesEl);
      for (let i = v.nextStage; i < v.stages.length; i++) {
        const uids = v.stages[i]!;
        const counts = new Map<string, { n: number; cls: string }>();
        for (const u of uids) {
          const p = v.partByUid(u);
          if (!p) continue;
          const cls = p.isEngine ? 'engine' : p.def.decoupler ? 'decoupler' : p.def.parachute ? 'chute' : p.def.fairing ? 'fairing' : '';
          const name = p.isEngine && (p.config.cluster ?? 1) > 1 ? `${p.def.name} ×${p.config.cluster}` : p.def.name;
          const c = counts.get(name);
          if (c) c.n++;
          else counts.set(name, { n: 1, cls });
        }
        if (!counts.size) continue;
        const info = si.find((s) => s.stage === i);
        const chips = h('div', { class: 'chips' });
        for (const [name, c] of counts) chips.appendChild(h('span', { class: `chip ${c.cls}`, text: c.n > 1 ? `${c.n}× ${name}` : name }));
        this.stagesEl.appendChild(
          h('div', { class: `stage${i === v.nextStage ? ' next' : ''}` },
            h('div', { class: 'sh' }, h('span', { text: `Stage ${i + 1}` }), h('span', { class: 'dv', text: info && info.dvVac > 0.5 ? `${info.dvVac.toFixed(0)} m/s` : '' })),
            chips,
          ),
        );
      }
      if (!this.stagesEl.children.length) this.stagesEl.appendChild(h('div', { style: 'color:var(--text-faint);font-size:12px;padding:6px', text: 'No stages remaining' }));
    }

    // Resources
    const totals = new Map<PropellantId, { cur: number; cap: number }>();
    let ablCur = 0;
    let ablCap = 0;
    for (const p of v.parts) {
      if (p.propellant && p.fuelCapacity > 0) {
        const t = totals.get(p.propellant) ?? { cur: 0, cap: 0 };
        t.cur += p.fuel;
        t.cap += p.fuelCapacity;
        totals.set(p.propellant, t);
      }
      if (p.stats.ablator > 0) {
        ablCur += p.ablator;
        ablCap += p.stats.ablator;
      }
    }
    const resKey = [...totals.entries()].map(([k, t]) => `${k}${Math.round((t.cur / t.cap) * 200)}`).join() + Math.round(ablCur);
    if (resKey !== this.lastResKey) {
      this.lastResKey = resKey;
      clear(this.resEl);
      for (const [k, t] of totals) {
        const spec = PROPELLANTS[k];
        const frac = t.cap > 0 ? t.cur / t.cap : 0;
        this.resEl.appendChild(
          h('div', { class: 'bar' },
            h('div', { class: 'bh' }, h('span', { text: spec.short }), h('span', { class: 'mono', text: `${formatMass(t.cur)} · ${(frac * 100).toFixed(0)}%` })),
            h('div', { class: 'bt' }, h('div', { class: 'bf', style: `width:${frac * 100}%;background:${spec.color}` })),
          ),
        );
      }
      if (ablCap > 0) {
        const frac = ablCur / ablCap;
        this.resEl.appendChild(
          h('div', { class: 'bar' },
            h('div', { class: 'bh' }, h('span', { text: 'Ablator' }), h('span', { class: 'mono', text: `${formatMass(ablCur)} · ${(frac * 100).toFixed(0)}%` })),
            h('div', { class: 'bt' }, h('div', { class: 'bf', style: `width:${frac * 100}%;background:#c98a5a` })),
          ),
        );
      }
      if (!totals.size && ablCap <= 0) this.resEl.appendChild(h('div', { style: 'color:var(--text-faint);font-size:12px', text: 'No propellant' }));
    }
    const hasLegs = v.parts.some((p) => !!p.def.legs);
    this.legsBtn.style.display = hasLegs ? '' : 'none';
    this.legsBtn.classList.toggle('active', v.parts.some((p) => p.legsDeployed));
    const hasRcs = v.parts.some((p) => !!p.def.rcs);
    this.rcsBtn.style.display = hasRcs ? '' : 'none';
    this.rcsBtn.classList.toggle('active', extra.rcs);
    this.undockBtn.style.display = extra.docked ? '' : 'none';
    this.switchBtn.style.display = extra.vessels > 1 ? '' : 'none';

    // Target
    const t = extra.target;
    if (!t) {
      setText(this.tgtName, 'No target');
      setText(this.tgtInfo, '');
    } else {
      setText(this.tgtName, t.name);
      let info = '';
      if (t.isVessel && isFinite(t.distance)) {
        info = `${formatDistance(t.distance)} · ${t.relSpeed.toFixed(1)} m/s`;
        if (isFinite(t.caDistance) && isFinite(t.caIn) && t.caIn > 1) info += ` · CA ${formatDistance(t.caDistance)} in ${formatDuration(t.caIn)}`;
      }
      setText(this.tgtInfo, info);
    }

    // Autopilot status
    const ap = sim.autopilot;
    setText(this.apStatus, ap.mode !== 'off' ? `▶ ${ap.phase}` : ap.doneMessage);
    this.mapBtn.classList.toggle('active', extra.mapView);
    this.root.classList.toggle('map-mode', extra.mapView);
  }
}
