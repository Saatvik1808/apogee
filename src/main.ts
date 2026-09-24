/**
 * LEARNING NOTE: Bootstrapping the game
 *
 * Start-up order matters: create the WebGL renderer, stream the textures (with a
 * progress bar), build the solar system for the chosen date, load terrain height
 * data for physics while Web Workers load their own copy for meshing, precompute
 * the atmosphere lookup tables, and finally hand everything to the game's state
 * machine.
 *
 * Key concepts: async initialisation, progressive loading, dependency order
 */
import './ui/styles.css';
import './ui/menu.css';
import { Renderer } from './render/Renderer';
import { assetUrl, loadAssets } from './render/Assets';
import { SolarSystem } from './physics/SolarSystem';
import { utFromDate } from './physics/Ephemeris';
import { WorkerPool } from './render/planet/WorkerPool';
import { loadTerrains, type FlatSiteSpec, type TerrainUrls } from './world/Terrain';
import { LAUNCH_SITES } from './world/LaunchSites';
import { SpaceScene } from './render/SpaceScene';
import { PostFX } from './render/post/PostFX';
import { EnvironmentProbe } from './render/EnvironmentProbe';
import { Input } from './game/Input';
import { AudioEngine } from './audio/AudioEngine';
import { loadSave } from './game/Save';
import { App } from './game/App';
import type { GameContext } from './game/GameContext';
import { applyQuality } from './game/Quality';

function loadingScreen(root: HTMLElement) {
  const el = document.createElement('div');
  el.className = 'loading';
  el.innerHTML = `<div class="logo">APOGEE</div><div class="sub">Real-scale space program</div><div class="bar"><div></div></div><div class="status"></div>`;
  root.appendChild(el);
  const bar = el.querySelector('.bar > div') as HTMLDivElement;
  const status = el.querySelector('.status') as HTMLDivElement;
  return {
    progress(f: number, label: string) {
      bar.style.width = `${Math.round(f * 100)}%`;
      status.textContent = label;
    },
    error(msg: string) {
      const e = document.createElement('div');
      e.className = 'error';
      e.textContent = msg;
      el.appendChild(e);
    },
    hide() {
      el.classList.add('hidden');
      setTimeout(() => el.remove(), 1200);
    },
  };
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const loading = loadingScreen(root);
  let renderer: Renderer;
  try {
    renderer = new Renderer(root);
  } catch (e) {
    loading.error('APOGEE needs WebGL 2. Please use a recent Chrome, Edge, Firefox or Safari.');
    throw e;
  }
  const save = loadSave();
  const texQuality = save.settings.quality === 'low' || save.settings.quality === 'medium' ? 'standard' : 'high';
  const assets = await loadAssets(texQuality, renderer.maxTextureSize, (f, l) => loading.progress(f * 0.75, `Loading ${l}`));
  const epoch = utFromDate(new Date(Date.UTC(2026, 8, 24, 13, 30, 0)));
  const system = new SolarSystem(epoch);
  const urls: TerrainUrls = {
    earthHeight: assetUrl('earth/height_2k.png'),
    earthMask: assetUrl('earth/coast_sdf_4k.png'),
    moonHeight: assetUrl('moon/height_2k.png'),
    marsHeight: assetUrl('mars/height_2k.png'),
  };
  const radii = { earth: system.earth.radius, moon: system.moon.radius, mars: system.mars.radius };
  const sites: FlatSiteSpec[] = LAUNCH_SITES.map((s) => ({
    body: 'earth',
    lat: s.lat,
    lon: s.lon,
    radius: s.flattenRadius,
    blend: 1500,
    seaBearing: s.seaBearing,
    coastDistance: s.coastDistance,
  }));
  loading.progress(0.8, 'Loading terrain data');
  const pool = new WorkerPool(2, urls, radii, sites);
  const terrains = await loadTerrains(urls, radii, sites);
  system.earth.terrain = terrains.earth;
  system.moon.terrain = terrains.moon;
  system.mars.terrain = terrains.mars;
  loading.progress(0.88, 'Computing atmospheric scattering');
  await new Promise((r) => setTimeout(r, 30));
  const space = new SpaceScene(system, assets, pool);
  const post = new PostFX(renderer.gl, space.earthLUTs, assets.earthClouds);
  renderer.onResize((w, h) => post.setSize(w, h));
  const ui = document.createElement('div');
  ui.className = 'ui-root';
  root.appendChild(ui);
  const ctx: GameContext = {
    renderer,
    assets,
    system,
    space,
    post,
    env: new EnvironmentProbe(renderer.gl),
    input: new Input(renderer.canvas),
    audio: new AudioEngine(),
    save,
    ui,
  };
  applyQuality(ctx);
  loading.progress(0.95, 'Streaming planet surfaces');
  await pool.ready;
  // Give the workers a moment to deliver the root patches
  const t0 = performance.now();
  while (!space.terrainsReady && performance.now() - t0 < 4000) {
    space.update(system.earth.position.clone().add(system.earth.position.clone().normalize().multiplyScalar(-2e7)), renderer.camera, 0, 1);
    await new Promise((r) => setTimeout(r, 50));
  }
  loading.progress(1, 'Ready');
  const app = new App(ctx);
  (window as unknown as { __apg: unknown }).__apg = { app, ctx };
  app.start();
  loading.hide();
}

boot().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;left:16px;bottom:16px;color:#ff6b6b;font:12px monospace;z-index:999;white-space:pre-wrap;max-width:90vw';
  el.textContent = `Startup failed: ${msg}`;
  document.body.appendChild(el);
});
