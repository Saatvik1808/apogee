/**
 * LEARNING NOTE: The map view — seeing orbits
 *
 * An orbit is a conic, so we draw it by sampling its TRUE ANOMALY ν (the angle
 * from periapsis): r(ν) = p / (1 + e·cos ν). Each patched-conic segment is drawn in
 * its own body's frame — a lunar flyby hyperbola is drawn around the Moon's current
 * position — and coloured differently so you can read the whole journey at a glance.
 *
 * Maneuver nodes are edited here: pick a point on the orbit (N), then add prograde,
 * normal or radial Δv and watch the dashed "after the burn" trajectory update
 * instantly. That is exactly how mission designers plan transfers.
 *
 * Markers (Ap, Pe, encounters, nodes) are HTML elements placed by projecting 3-D
 * points to the screen each frame.
 *
 * Key concepts: conic sampling, per-patch reference frames, screen projection,
 * interactive trajectory planning
 */
import { LAYER_TRANSPARENT } from '../render/post/SharedUniforms';
import { DynamicDrawUsage, Vector2, Vector3, type InstancedInterleavedBuffer, type InterleavedBufferAttribute } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { formatDistance, formatDuration } from '../core/math';
import type { CelestialBody } from '../physics/CelestialBody';
import type { TrajectoryPatch } from '../physics/Trajectory';
import type { FlightSim } from '../sim/FlightSim';
import { burnLeadTime, estimateBurnTime, type ManeuverNode } from '../sim/Maneuver';
import { h, setText, clear } from '../ui/dom';
import type { GameContext } from './GameContext';
import type { MapCamera } from './FlightCamera';

const PATCH_COLORS = [0x5ad8ff, 0xffb13b, 0xd46bff, 0x6ff2a4, 0xff6b6b];
const NODE_COLORS = [0xfff1a8, 0xffd27a, 0xffa3e0, 0xa3ffd0, 0xffb3b3];
const N_SAMPLES = 360;
const _p = new Vector3();
const _v = new Vector3();
const _v2 = new Vector3();
const _scr = new Vector3();

interface LineSlot {
  line: Line2;
  geo: LineGeometry;
  mat: LineMaterial;
  /** GPU segment buffer (start xyz, end xyz per segment), sized for N_SAMPLES once. */
  seg: InstancedInterleavedBuffer;
  /** Cumulative distances for dashed lines (null when not dashed). */
  dist: InstancedInterleavedBuffer | null;
  body: CelestialBody | null;
  /** Sampled positions relative to the body (float64 source for picking). */
  pts: Float64Array;
  times: Float64Array;
  count: number;
  /** Predictor version the samples were taken from (−1: none). */
  stamp: number;
}

export class MapView {
  private readonly ctx: GameContext;
  private readonly sim: FlightSim;
  private readonly slots: LineSlot[] = [];
  private readonly nodeSlots: LineSlot[] = [];
  private readonly moonOrbit: LineSlot;
  private readonly overlay: HTMLDivElement;
  private readonly labels = new Map<string, HTMLDivElement>();
  private readonly nodePanel: HTMLDivElement;
  private readonly nodeInfo: HTMLDivElement;
  private selected: ManeuverNode | null = null;
  private visible = false;
  focus: 'vessel' | 'soi' | CelestialBody = 'soi';
  warpTarget: number | null = null;
  private lastFocusBody: CelestialBody | null = null;
  private rebuildTimer = 0;
  private readonly resolution = new Vector2(1, 1);

  constructor(ctx: GameContext, sim: FlightSim) {
    this.ctx = ctx;
    this.sim = sim;
    for (let i = 0; i < 5; i++) this.slots.push(this.makeSlot(PATCH_COLORS[i]!, false, 2.2));
    for (let i = 0; i < 5; i++) this.nodeSlots.push(this.makeSlot(NODE_COLORS[i]!, true, 1.8));
    this.moonOrbit = this.makeSlot(0x8899aa, false, 1.1);
    this.overlay = h('div', { class: 'ui-layer mapoverlay', style: 'display:none' });
    this.nodeInfo = h('div', { style: 'font-family:var(--font-mono);font-size:12px;line-height:1.6;margin-bottom:6px' });
    const row = (label: string, key: 'prograde' | 'normal' | 'radial', color: string) =>
      h('div', { style: 'display:flex;align-items:center;gap:4px;margin:3px 0' },
        h('span', { style: `width:74px;font-family:var(--font-display);letter-spacing:.1em;font-size:11px;color:${color}`, text: label }),
        ...[-100, -10, -1, 1, 10, 100].map((d) =>
          h('button', {
            class: 'btn small',
            style: 'padding:3px 6px;min-width:34px',
            text: d > 0 ? `+${d}` : String(d),
            onClick: () => this.adjustNode(key, d),
          }),
        ),
      );
    this.nodePanel = h(
      'div',
      { class: 'card pe map-node-panel', style: 'position:absolute;left:50%;transform:translateX(-50%);bottom:calc(20vh + 90px);padding:10px 12px;display:none;pointer-events:auto;min-width:420px' },
      h('div', { class: 'card-h', style: 'margin:-10px -12px 8px' }, h('span', { text: 'Maneuver node' }), h('span', { class: 'accent', text: 'PLAN' })),
      this.nodeInfo,
      row('Prograde', 'prograde', '#d8f53a'),
      row('Normal', 'normal', '#d46bff'),
      row('Radial', 'radial', '#40e3ff'),
      h('div', { style: 'display:flex;align-items:center;gap:4px;margin-top:6px' },
        h('span', { style: 'width:74px;font-family:var(--font-display);letter-spacing:.1em;font-size:11px;color:var(--text-dim)', text: 'Time' }),
        ...[
          ['−orbit', -1e9],
          ['−10m', -600],
          ['−1m', -60],
          ['+1m', 60],
          ['+10m', 600],
          ['+orbit', 1e9],
        ].map(([label, dt]) => h('button', { class: 'btn small', style: 'padding:3px 6px', text: String(label), onClick: () => this.shiftNode(Number(dt)) })),
      ),
      h('div', { style: 'display:flex;gap:6px;margin-top:10px' },
        h('button', { class: 'btn small primary', style: 'flex:1', text: 'Execute (autopilot)', onClick: () => this.sim.autopilot.engage('node', this.sim) }),
        h('button', { class: 'btn small', text: 'Warp to', onClick: () => this.selected && (this.warpTarget = this.selected.time - burnLeadTime(this.sim.active, this.selected.remaining.length())) }),
        h('button', { class: 'btn small', text: 'Delete', onClick: () => this.deleteSelectedNode() }),
      ),
    );
    this.overlay.appendChild(this.nodePanel);
    this.overlay.appendChild(
      h('div', { class: 'card map-hint', style: 'position:absolute;left:50%;transform:translateX(-50%);top:84px;padding:6px 12px;font-size:12px;color:var(--text-dim);pointer-events:none' },
        ctx.platform.touch
          ? 'Tap an orbit to plan a burn · drag to rotate · pinch to zoom'
          : 'MAP  ·  drag to orbit, wheel to zoom  ·  N: add maneuver node at cursor  ·  Tab: change focus  ·  M: back to flight'),
    );
    ctx.ui.appendChild(this.overlay);
    this.unbindKey = ctx.input.onKey((code) => {
      if (!this.visible) return;
      if (code === 'Tab') this.cycleFocus();
    });
  }

  /** Key listener removal — without it every flight's MapView (and its whole FlightSim) stayed reachable from the global input. */
  private readonly unbindKey: () => void;

  private makeSlot(color: number, dashed: boolean, width: number): LineSlot {
    const geo = new LineGeometry();
    // Allocate the GPU buffers once at full capacity; every frame only rewrites
    // their contents (creating new geometry per frame would re-upload 11 line
    // buffers to the GPU 60 times a second)
    geo.setPositions(new Float32Array(N_SAMPLES * 3));
    const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 0.95, dashed, dashSize: 0.02, gapSize: 0.015, depthWrite: false, worldUnits: false });
    const line = new Line2(geo, mat);
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 20;
    line.layers.set(LAYER_TRANSPARENT);
    this.ctx.space.scene.add(line);
    const seg = (geo.attributes.instanceStart as InterleavedBufferAttribute).data as InstancedInterleavedBuffer;
    seg.setUsage(DynamicDrawUsage);
    let dist: InstancedInterleavedBuffer | null = null;
    if (dashed) {
      line.computeLineDistances();
      dist = (geo.attributes.instanceDistanceStart as InterleavedBufferAttribute).data as InstancedInterleavedBuffer;
      dist.setUsage(DynamicDrawUsage);
    }
    return { line, geo, mat, seg, dist, body: null, pts: new Float64Array(N_SAMPLES * 3), times: new Float64Array(N_SAMPLES), count: 0, stamp: -1 };
  }

  private allSlots: LineSlot[] | null = null;

  private get slotList(): LineSlot[] {
    if (!this.allSlots) this.allSlots = [...this.slots, ...this.nodeSlots, this.moonOrbit];
    return this.allSlots;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.overlay.style.display = v ? '' : 'none';
    for (const s of this.slotList) s.line.visible = v && s.count > 1;
    if (!v) this.selected = null;
  }

  private cycleFocus(): void {
    const sys = this.ctx.system;
    const order: Array<'vessel' | CelestialBody> = ['vessel', this.sim.active.body, sys.earth, sys.moon, sys.mars, sys.sun];
    const idx = order.findIndex((o) => o === (this.focus === 'soi' ? this.sim.active.body : this.focus));
    this.focus = order[(idx + 1) % order.length]!;
  }

  focusBody(): CelestialBody {
    if (this.focus === 'vessel' || this.focus === 'soi') return this.sim.active.body;
    return this.focus;
  }

  updateCamera(cam: MapCamera, dt: number, dx: number, dy: number, wheel: number): void {
    const b = this.focusBody();
    const focusAbs = this.focus === 'vessel' ? this.sim.active.absolutePosition(_v2) : _v2.copy(b.position);
    if (b !== this.lastFocusBody && this.focus !== 'vessel') {
      cam.targetDistance = Math.max(cam.targetDistance, b.radius * 3.2);
      if (b.id === 'sun') cam.targetDistance = 4e11;
      this.lastFocusBody = b;
    }
    const minD = this.focus === 'vessel' ? 50 : b.radius * 1.05;
    cam.update(focusAbs, dt, dx, dy, wheel, minD);
  }

  private samplePatch(p: TrajectoryPatch, slot: LineSlot): void {
    const o = p.orbit;
    slot.body = p.body;
    let n = 0;
    const tStart = p.startTime;
    let tEnd = p.endTime;
    if (!isFinite(tEnd)) tEnd = tStart + (o.isElliptic ? o.period : 30 * 86400);
    if (o.degenerate || o.e > 0.999999 && o.e < 1.000001) {
      for (let i = 0; i < N_SAMPLES; i++) {
        const t = tStart + ((tEnd - tStart) * i) / (N_SAMPLES - 1);
        o.getStateAt(t, _p);
        slot.pts[n * 3] = _p.x;
        slot.pts[n * 3 + 1] = _p.y;
        slot.pts[n * 3 + 2] = _p.z;
        slot.times[n] = t;
        n++;
      }
    } else {
      let nu0 = o.trueAnomalyAt(tStart);
      let nu1: number;
      if (o.isElliptic && tEnd - tStart >= o.period - 1e-3) nu1 = nu0 + Math.PI * 2;
      else {
        nu1 = o.trueAnomalyAt(tEnd);
        if (o.isElliptic) {
          while (nu1 <= nu0) nu1 += Math.PI * 2;
        } else {
          const lim = o.maxTrueAnomaly * 0.999;
          nu0 = Math.max(-lim, nu0);
          nu1 = Math.min(lim, nu1);
        }
      }
      for (let i = 0; i < N_SAMPLES; i++) {
        const nu = nu0 + ((nu1 - nu0) * i) / (N_SAMPLES - 1);
        o.positionAtTrueAnomaly(nu, _p);
        if (!isFinite(_p.x)) continue;
        slot.pts[n * 3] = _p.x;
        slot.pts[n * 3 + 1] = _p.y;
        slot.pts[n * 3 + 2] = _p.z;
        const tsp = o.timeSincePeriapsis(nu);
        let t = o.tPeriapsis + tsp;
        if (o.isElliptic) {
          while (t < tStart - 1) t += o.period;
          while (t > tStart + o.period + 1) t -= o.period;
        }
        slot.times[n] = t;
        n++;
      }
    }
    slot.count = n;
  }

  private uploadSlot(slot: LineSlot, camAbs: Vector3): void {
    if (!slot.body || slot.count < 2) {
      slot.line.visible = false;
      return;
    }
    // Positions relative to the body; the line object sits at body − camera.
    // Segment i runs from point i to point i+1: rewrite the interleaved buffer in
    // place (start xyz, end xyz) and draw only the segments in use.
    const n = Math.min(slot.count, N_SAMPLES);
    const pts = slot.pts;
    const arr = slot.seg.array as Float32Array;
    for (let i = 0; i < n - 1; i++) {
      const o = i * 6;
      const s = i * 3;
      arr[o] = pts[s]!;
      arr[o + 1] = pts[s + 1]!;
      arr[o + 2] = pts[s + 2]!;
      arr[o + 3] = pts[s + 3]!;
      arr[o + 4] = pts[s + 4]!;
      arr[o + 5] = pts[s + 5]!;
    }
    slot.seg.clearUpdateRanges();
    slot.seg.addUpdateRange(0, (n - 1) * 6);
    slot.seg.needsUpdate = true;
    if (slot.dist) {
      // Dashes need the cumulative length along the line (same maths as Line2.computeLineDistances)
      const d = slot.dist.array as Float32Array;
      let acc = 0;
      for (let i = 0; i < n - 1; i++) {
        const s = i * 3;
        const dx = pts[s + 3]! - pts[s]!;
        const dy = pts[s + 4]! - pts[s + 1]!;
        const dz = pts[s + 5]! - pts[s + 2]!;
        d[i * 2] = acc;
        acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
        d[i * 2 + 1] = acc;
      }
      slot.dist.clearUpdateRanges();
      slot.dist.addUpdateRange(0, (n - 1) * 2);
      slot.dist.needsUpdate = true;
    }
    slot.geo.instanceCount = n - 1;
    this.placeSlot(slot, camAbs);
  }

  /** Per-frame: the line object sits at body − camera (floating origin). */
  private placeSlot(slot: LineSlot, camAbs: Vector3): void {
    if (!slot.body || slot.count < 2) {
      slot.line.visible = false;
      return;
    }
    slot.line.position.copy(slot.body.position).sub(camAbs);
    slot.line.visible = this.visible;
  }

  /** Called every frame. */
  update(dt: number, visible: boolean): void {
    if (!visible) return;
    this.rebuildTimer -= dt;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    if (w !== this.resolution.x || hgt !== this.resolution.y) {
      this.resolution.set(w, hgt);
      for (const s of this.slotList) s.mat.resolution.copy(this.resolution);
    }
    if (!this.selected && this.sim.nodes.length) this.selected = this.sim.nodes[0]!;
    if (this.selected && !this.sim.nodes.includes(this.selected)) this.selected = this.sim.nodes[0] ?? null;
    this.nodePanel.style.display = this.selected ? '' : 'none';
    if (this.selected) {
      const n = this.selected;
      const dv = Math.hypot(n.prograde, n.normal, n.radial);
      const rem = n.remaining.length();
      const bt = estimateBurnTime(this.sim.active, rem);
      setText(
        this.nodeInfo,
        `Δv ${dv.toFixed(1)} m/s  (remaining ${rem.toFixed(1)})   ·   burn ${isFinite(bt) ? formatDuration(bt) : 'no engines'}   ·   in ${formatDuration(n.time - this.sim.time)}\n` +
          `prograde ${n.prograde.toFixed(1)}   normal ${n.normal.toFixed(1)}   radial ${n.radial.toFixed(1)}`,
      );
      this.nodeInfo.style.whiteSpace = 'pre';
    }
  }

  /**
   * Rebuild line geometry and place markers; call before rendering. Orbit lines
   * are only re-sampled when the predictor produced a new prediction (its
   * `version` changes) — every frame they are merely re-positioned relative to
   * the camera.
   */
  render(camAbs: Vector3): void {
    if (!this.visible) return;
    const sim = this.sim;
    const pred = sim.predictor;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (i < pred.count && !sim.active.pinned) {
        if (slot.stamp !== pred.version) {
          this.samplePatch(pred.patches[i]!, slot);
          this.uploadSlot(slot, camAbs);
          slot.stamp = pred.version;
        } else this.placeSlot(slot, camAbs);
      } else {
        slot.count = 0;
        slot.stamp = -1;
        slot.line.visible = false;
      }
    }
    const np = sim.nodePredictor;
    for (let i = 0; i < this.nodeSlots.length; i++) {
      const slot = this.nodeSlots[i]!;
      if (i < np.count && sim.nodes.length) {
        if (slot.stamp !== np.version) {
          this.samplePatch(np.patches[i]!, slot);
          this.uploadSlot(slot, camAbs);
          slot.stamp = np.version;
        } else this.placeSlot(slot, camAbs);
      } else {
        slot.count = 0;
        slot.stamp = -1;
        slot.line.visible = false;
      }
    }
    // Moon's orbit: fixed elements, sampled once
    const moon = this.ctx.system.moon;
    if (moon.orbit) {
      const o = moon.orbit;
      const slot = this.moonOrbit;
      if (slot.count === 0 || slot.body !== this.ctx.system.earth) {
        slot.body = this.ctx.system.earth;
        for (let i = 0; i < N_SAMPLES; i++) {
          o.positionAtTrueAnomaly((i / (N_SAMPLES - 1)) * Math.PI * 2, _p);
          slot.pts[i * 3] = _p.x;
          slot.pts[i * 3 + 1] = _p.y;
          slot.pts[i * 3 + 2] = _p.z;
        }
        slot.count = N_SAMPLES;
        this.uploadSlot(slot, camAbs);
      } else this.placeSlot(slot, camAbs);
    }
    this.placeMarkers(camAbs);
  }

  private label(key: string, text: string, cls: string, world: Vector3 | null, camAbs: Vector3, onClick?: () => void): void {
    let el = this.labels.get(key);
    if (!el) {
      el = h('div', { class: `maplabel ${cls}`, onClick: onClick ? () => onClick() : undefined });
      el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);font-family:var(--font-display);font-weight:700;font-size:11px;letter-spacing:.12em;white-space:nowrap;text-shadow:0 1px 3px #000;';
      if (onClick) el.style.pointerEvents = 'auto';
      else el.style.pointerEvents = 'none';
      this.overlay.appendChild(el);
      this.labels.set(key, el);
    }
    el.dataset.alive = '1';
    if (!world) {
      el.style.display = 'none';
      return;
    }
    const cam = this.ctx.renderer.camera;
    _scr.copy(world).sub(camAbs);
    _scr.applyMatrix4(cam.matrixWorldInverse);
    if (_scr.z > 0) {
      el.style.display = 'none';
      return;
    }
    _scr.applyMatrix4(cam.projectionMatrix);
    el.style.display = '';
    el.style.left = `${(_scr.x * 0.5 + 0.5) * window.innerWidth}px`;
    el.style.top = `${(-_scr.y * 0.5 + 0.5) * window.innerHeight}px`;
    setText(el, text);
  }

  private placeMarkers(camAbs: Vector3): void {
    for (const el of this.labels.values()) el.dataset.alive = '';
    const sim = this.sim;
    const sys = this.ctx.system;
    for (const b of sys.ordered) {
      _v.copy(b.position);
      _v.y += b.radius * 1.15;
      this.label(`body-${b.id}`, b.name.toUpperCase(), 'body', _v, camAbs);
    }
    const v = sim.active;
    this.label('vessel', `▲ ${v.name}`, 'vessel', v.absolutePosition(_v), camAbs);
    const pred = sim.predictor;
    const patchLabels = (pp: TrajectoryPatch, prefix: string, idx: number, color: string) => {
      const o = pp.orbit;
      const b = pp.body;
      const R = b.radius;
      const inPatch = (t: number) => t >= pp.startTime - 1 && t <= pp.endTime + 1;
      const tPe = o.nextTimeAtTrueAnomaly(0, pp.startTime);
      if (!o.degenerate && isFinite(tPe) && inPatch(tPe)) {
        o.positionAtTrueAnomaly(0, _p);
        this.label(`${prefix}pe${idx}`, `Pe ${formatDistance(o.periapsis - R)}`, 'pe', _p.clone().add(b.position), camAbs);
      }
      if (o.isElliptic) {
        const tAp = o.nextTimeAtTrueAnomaly(Math.PI, pp.startTime);
        if (inPatch(tAp)) {
          o.positionAtTrueAnomaly(Math.PI, _p);
          this.label(`${prefix}ap${idx}`, `Ap ${formatDistance(o.apoapsis - R)}`, 'ap', _p.clone().add(b.position), camAbs);
        }
      }
      if (pp.endReason === 'soi-enter' && pp.nextBody) {
        o.getStateAt(pp.endTime, _p);
        this.label(`${prefix}enc${idx}`, `${pp.nextBody.name} encounter`, 'enc', _p.clone().add(b.position), camAbs);
      } else if (pp.endReason === 'impact') {
        o.getStateAt(pp.endTime, _p);
        this.label(`${prefix}imp${idx}`, '✕ Impact', 'imp', _p.clone().add(b.position), camAbs);
      } else if (pp.endReason === 'soi-exit') {
        o.getStateAt(pp.endTime, _p);
        this.label(`${prefix}exit${idx}`, 'SOI exit', 'exit', _p.clone().add(b.position), camAbs);
      }
      void color;
    };
    if (!v.pinned) {
      for (let i = 0; i < pred.count; i++) patchLabels(pred.patches[i]!, 'p', i, '#5ad8ff');
      for (let i = 0; i < sim.nodePredictor.count && sim.nodes.length; i++) patchLabels(sim.nodePredictor.patches[i]!, 'n', i, '#fff1a8');
    }
    // Node markers
    sim.nodes.forEach((n, i) => {
      const idx = sim.patchAt(n.time);
      if (idx < 0) return;
      const pp = pred.patches[idx]!;
      pp.orbit.getStateAt(n.time, _p);
      this.label(`node${n.id}`, `◆ Node ${i + 1}`, 'node', _p.clone().add(pp.body.position), camAbs, () => (this.selected = n));
    });
    for (const [k, el] of this.labels) {
      if (!el.dataset.alive) {
        el.remove();
        this.labels.delete(k);
      } else {
        el.style.color = k.startsWith('body') ? '#e8eef7' : k.includes('pe') ? '#6ff2a4' : k.includes('ap') ? '#5ad8ff' : k.startsWith('node') ? '#fff1a8' : k.includes('imp') ? '#ff6b6b' : k === 'vessel' ? '#ffb13b' : '#ffd27a';
      }
    }
  }

  /** Add a node at the trajectory point closest to the mouse cursor. */
  addNodeAtCursor(): void {
    const inp = this.ctx.input;
    this.addNodeAt(inp.pointerX, inp.pointerY, 80, true);
  }

  /**
   * Add a node where the screen point (x, y) touches a drawn trajectory.
   * Without `fallback`, a tap further than `maxPx` from every orbit does nothing.
   */
  addNodeAt(x: number, y: number, maxPx: number, fallback = false): void {
    if (!this.visible) return;
    const cam = this.ctx.renderer.camera;
    let best = Infinity;
    let bestT = NaN;
    const camAbs = this.ctx.space.cameraAbs;
    for (const slot of this.slots) {
      if (!slot.body || slot.count < 2 || !slot.line.visible) continue;
      for (let i = 0; i < slot.count; i++) {
        _scr.set(slot.pts[i * 3]!, slot.pts[i * 3 + 1]!, slot.pts[i * 3 + 2]!).add(slot.body.position).sub(camAbs);
        _scr.applyMatrix4(cam.matrixWorldInverse);
        if (_scr.z > 0) continue;
        _scr.applyMatrix4(cam.projectionMatrix);
        const sx = (_scr.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-_scr.y * 0.5 + 0.5) * window.innerHeight;
        const d = Math.hypot(sx - x, sy - y);
        if (d < best) {
          best = d;
          bestT = slot.times[i]!;
        }
      }
    }
    if (!fallback && (isNaN(bestT) || best > maxPx)) return;
    if (isNaN(bestT) || best > maxPx) {
      // Fallback: at the next apoapsis/periapsis
      const p0 = this.sim.predictor.patches[0];
      if (!p0) return;
      const o = p0.orbit;
      bestT = o.isElliptic ? o.nextTimeAtTrueAnomaly(Math.PI, this.sim.time + 60) : this.sim.time + 600;
    }
    if (bestT < this.sim.time + 5) bestT = this.sim.time + 5;
    const n = this.sim.addNode(bestT);
    if (n) this.selected = n;
  }

  deleteSelectedNode(): void {
    if (this.selected) this.sim.removeNode(this.selected);
    this.selected = null;
  }

  private adjustNode(key: 'prograde' | 'normal' | 'radial', d: number): void {
    const n = this.selected;
    if (!n) return;
    const mult = this.ctx.input.shift ? 0.1 : 1;
    n[key] += d * mult;
    this.sim.editNode(n);
  }

  private shiftNode(dt: number): void {
    const n = this.selected;
    if (!n) return;
    const idx = this.sim.patchAt(n.time);
    const o = idx >= 0 ? this.sim.predictor.patches[idx]!.orbit : null;
    if (Math.abs(dt) >= 1e9) dt = o && o.isElliptic ? Math.sign(dt) * o.period : Math.sign(dt) * 3600;
    n.time = Math.max(this.sim.time + 5, n.time + dt);
    this.sim.editNode(n);
  }

  /** Drive time warp toward `warpTarget` (warp-to-node). */
  driveWarp(): void {
    const target = this.warpTarget;
    if (target === null) return;
    const sim = this.sim;
    const left = target - sim.time;
    if (left <= 1) {
      sim.stopWarp();
      this.warpTarget = null;
      return;
    }
    // Choose the fastest level that won't overshoot within ~2 s of real time
    let want = 0;
    const levels = [1, 5, 10, 50, 100, 1_000, 10_000, 100_000, 1_000_000];
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i]! * 2 < left) {
        want = i;
        break;
      }
    }
    const idx = want === 0 ? 0 : want + 3;
    if (sim.warpIndex !== idx) sim.setWarpIndex(idx);
    if (!sim.warp.rails && want > 0) this.warpTarget = null;
  }

  dispose(): void {
    this.unbindKey();
    this.visible = false;
    for (const s of this.slotList) {
      s.line.removeFromParent();
      s.geo.dispose();
      s.mat.dispose();
    }
    this.overlay.remove();
    clear(this.overlay);
  }
}
