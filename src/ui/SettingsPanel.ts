/**
 * LEARNING NOTE: Settings that respect how people actually play
 *
 * One player is on a gaming PC and wants every effect; another is on a phone on
 * a train and wants the battery to last. Presets give each a one-tap answer
 * ("Battery saver", "Balanced", "High", "Ultra"); every individual option stays
 * adjustable underneath, and changing one flips the preset to "Custom".
 *
 * Most options apply instantly because they are just uniforms or render-target
 * sizes. Texture resolution is different: the planet maps are uploaded once at
 * start-up (swapping hundreds of megabytes mid-flight would stall the game), so
 * that change asks for a restart.
 *
 * The same panel is used from the main menu and from the in-flight pause menu.
 *
 * Key concepts: presets vs. fine-grained options, live-applied settings,
 * restart-required settings, persistence
 */
import type { GameContext } from '../game/GameContext';
import { applyQuality, PRESET_LABELS, resolution, textureTier } from '../game/Quality';
import { writeSave, type QualityPreset, type Settings } from '../game/Save';
import { clear, h } from './dom';

type Tab = 'graphics' | 'controls' | 'audio';

let lastTab: Tab = 'graphics';

export function buildSettingsPanel(ctx: GameContext): HTMLDivElement {
  const s = ctx.save.settings;
  const root = h('div', { class: 'settings' });
  const tabs = h('div', { class: 'set-tabs' });
  const body = h('div', { class: 'set-body' });
  root.append(tabs, body);

  const commit = () => {
    writeSave(ctx.save);
    applyQuality(ctx);
  };
  /** A graphics field changed by hand: keep the mix as a custom preset. */
  const custom = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    s[k] = v;
    s.quality = 'custom';
    commit();
    render();
  };

  const seg = <T extends string | number>(opts: Array<[T, string]>, get: () => T, set: (v: T) => void) => {
    const wrap = h('div', { class: 'seg-ctl' });
    for (const [v, label] of opts) {
      wrap.appendChild(h('button', { class: `btn small${get() === v ? ' active' : ''}`, text: label, onClick: () => (ctx.audio.click(), set(v)) }));
    }
    return wrap;
  };
  const row = (label: string, sub: string | null, control: HTMLElement) =>
    h('div', { class: 'set-row' }, h('div', { class: 'set-l' }, h('span', { text: label }), sub ? h('small', { text: sub }) : null), control);
  const check = (get: () => boolean, set: (v: boolean) => void) => {
    const inp = h('input', { type: 'checkbox', onChange: (e) => set((e.target as HTMLInputElement).checked) });
    inp.checked = get();
    return inp;
  };
  const range = (min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
    const out = h('span', { class: 'set-val mono', text: fmt(get()) });
    const inp = h('input', {
      type: 'range',
      attrs: { min: String(min), max: String(max), step: String(step) },
      value: String(get()),
      onInput: (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        out.textContent = fmt(v);
        set(v);
      },
    });
    return h('div', { class: 'set-range' }, inp, out);
  };

  const renderGraphics = () => {
    const presets = h('div', { class: 'set-presets' });
    for (const q of ['low', 'medium', 'high', 'ultra', 'custom'] as const) {
      const lab = PRESET_LABELS[q];
      const active = s.quality === q;
      presets.appendChild(
        h('button', {
          class: `set-preset${active ? ' active' : ''}${q === 'custom' ? ' custom' : ''}`,
          disabled: q === 'custom' && !active,
          onClick: () => {
            if (q === 'custom') return;
            ctx.audio.click();
            s.quality = q as QualityPreset;
            commit();
            render();
          },
        },
          h('span', { class: 'sp-n', text: lab.name }),
          h('span', { class: 'sp-s', text: lab.sub }),
        ),
      );
    }
    body.appendChild(presets);

    const dims = () => {
      const r = ctx.renderer;
      return `${Math.round(r.width * r.pixelRatio)} × ${Math.round(r.height * r.pixelRatio)}`;
    };
    const resOut = h('small', { text: `Renders ${dims()}` });
    body.appendChild(
      h('div', { class: 'set-row' },
        h('div', { class: 'set-l' }, h('span', { text: 'Resolution' }), resOut),
        range(0.5, 2, 0.05, () => s.renderScale, (v) => {
          s.renderScale = v;
          s.quality = 'custom';
          writeSave(ctx.save);
          applyQuality(ctx);
          resOut.textContent = `Renders ${dims()}`;
          for (const b of presets.children) b.classList.toggle('active', b.classList.contains('custom'));
        }, (v) => `${Math.round(v * 100)}%`),
      ),
    );
    body.appendChild(row('Dynamic resolution', 'Lowers resolution automatically when the frame rate drops', check(() => s.dynamicResolution, (v) => custom('dynamicResolution', v))));
    body.appendChild(row('Frame rate', 'A 30 FPS cap roughly halves GPU power draw', seg<0 | 30 | 60>([[30, '30'], [60, '60'], [0, 'Max']], () => s.frameCap, (v) => custom('frameCap', v))));
    const loaded = ctx.textureTierLoaded;
    const wantTier = textureTier(s, ctx.renderer.maxTextureSize, ctx.platform.native);
    const texNote = wantTier !== loaded ? h('button', { class: 'btn small primary', text: 'Restart to apply', onClick: () => location.reload() }) : null;
    // The 8k Earth maps are web-only (not packaged in the Android app)
    const tiers: Array<[Settings['textures'], string]> = ctx.platform.native ? [['low', '2k'], ['standard', '4k']] : [['low', '2k'], ['standard', '4k'], ['high', '8k']];
    body.appendChild(
      row('Textures', loaded === 'low' ? 'Planet maps 2k (phone tier)' : loaded === 'standard' ? 'Planet maps 4k' : 'Earth 8k, others 4k',
        h('div', { class: 'set-inline' }, seg<Settings['textures']>(tiers, () => wantTier, (v) => custom('textures', v)), texNote),
      ),
    );
    body.appendChild(row('Shadows', null, seg<Settings['shadows']>([['off', 'Off'], ['low', 'Low'], ['high', 'High']], () => s.shadows, (v) => custom('shadows', v))));
    body.appendChild(row('Atmosphere', 'Ray-marched scattering samples', seg<Settings['atmosphere']>([['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']], () => s.atmosphere, (v) => custom('atmosphere', v))));
    body.appendChild(row('Terrain detail', 'How finely planets are tessellated', seg<Settings['terrain']>([['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']], () => s.terrain, (v) => custom('terrain', v))));
    body.appendChild(row('Effects', 'Smoke, sparks and dust density', seg<Settings['effects']>([['low', 'Low'], ['medium', 'Med'], ['high', 'High']], () => s.effects, (v) => custom('effects', v))));
    body.appendChild(row('Clouds', null, check(() => s.clouds, (v) => custom('clouds', v))));
    body.appendChild(row('Bloom & lens flare', null, check(() => s.bloom, (v) => custom('bloom', v))));
    body.appendChild(row('Film grain', null, check(() => s.grain, (v) => custom('grain', v))));
    body.appendChild(row('Show FPS', null, check(() => s.showFps, (v) => ((s.showFps = v), commit()))));
    if (s.dynamicResolution && resolution.factor < 1) {
      body.appendChild(h('div', { class: 'set-note', text: `Dynamic resolution is currently rendering at ${Math.round(resolution.factor * 100)}% of your setting to hold the frame rate.` }));
    }
  };

  const renderControls = () => {
    body.appendChild(row('Touch controls', ctx.platform.touchDevice ? 'On-screen throttle, stick and buttons' : 'Show on-screen controls with a mouse too', seg<Settings['touchControls']>([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], () => s.touchControls, (v) => ((s.touchControls = v), commit(), render()))));
    body.appendChild(row('Stick sensitivity', null, range(0.4, 2, 0.05, () => s.stickSensitivity, (v) => ((s.stickSensitivity = v), writeSave(ctx.save)), (v) => `${v.toFixed(2)}×`)));
    body.appendChild(row('Haptic feedback', 'Vibration on staging, touchdown and impacts', check(() => s.haptics, (v) => ((s.haptics = v), commit()))));
    if (!ctx.platform.touchDevice) {
      const keys: Array<[string, string]> = [
        ['W / S · A / D · Q / E', 'Pitch · yaw · roll'],
        ['Shift / Ctrl · Z / X', 'Throttle up / down · full / cut'],
        ['Space', 'Next stage'],
        ['T · G', 'SAS · landing legs'],
        [', / . · /', 'Time warp down / up · stop'],
        ['M · V · P', 'Map · camera · pause'],
        ['H / F1 · F2', 'Help · hide HUD'],
      ];
      const tbl = h('div', { class: 'set-keys' });
      for (const [k, d] of keys) tbl.appendChild(h('div', {}, h('kbd', { text: k }), h('span', { text: d })));
      body.appendChild(h('div', { class: 'ql-label', text: 'Keyboard' }));
      body.appendChild(tbl);
    }
  };

  const renderAudio = () => {
    const vol = (label: string, get: () => number, set: (v: number) => void) =>
      row(label, null, range(0, 1, 0.05, get, (v) => (set(v), writeSave(ctx.save), applyQuality(ctx)), (v) => `${Math.round(v * 100)}%`));
    body.appendChild(vol('Master', () => s.master, (v) => (s.master = v)));
    body.appendChild(vol('Effects', () => s.sfx, (v) => (s.sfx = v)));
    body.appendChild(vol('Music', () => s.music, (v) => (s.music = v)));
    body.appendChild(row('Mission control voice', 'Spoken call-outs where the device supports speech', check(() => s.voice, (v) => ((s.voice = v), commit()))));
  };

  const render = () => {
    clear(tabs);
    clear(body);
    for (const [t, label] of [['graphics', 'Graphics'], ['controls', 'Controls'], ['audio', 'Audio']] as Array<[Tab, string]>) {
      tabs.appendChild(h('button', { class: `btn small${lastTab === t ? ' active' : ''}`, text: label, onClick: () => ((lastTab = t), render()) }));
    }
    if (lastTab === 'graphics') renderGraphics();
    else if (lastTab === 'controls') renderControls();
    else renderAudio();
  };
  render();
  return root;
}
