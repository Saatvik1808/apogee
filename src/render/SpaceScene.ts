/**
 * LEARNING NOTE: Orchestrating a solar-system scene every frame
 *
 * Each frame the simulation tells us where everything is in absolute
 * (heliocentric, 64-bit) coordinates. This class converts that into a GPU-friendly
 * scene: every planet group is placed at (planet − camera), rotated by the
 * planet's spin, and its quadtree refined around the camera. It also computes the
 * lighting environment — Sun direction, sunlight colour after passing through the
 * atmosphere to the camera, eclipses — and which atmosphere the post-process
 * should draw.
 *
 * Key concepts: floating origin, per-frame uniform updates, scene orchestration,
 * CPU-side lighting queries
 */
import {
  DirectionalLight,
  HemisphereLight,
  Matrix3,
  Matrix4,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { AU } from '../core/constants';
import type { CelestialBody, BodyId } from '../physics/CelestialBody';
import type { SolarSystem } from '../physics/SolarSystem';
import { AtmosphereLUTs, EARTH_ATMOSPHERE, MARS_ATMOSPHERE } from './atmosphere/AtmosphereModel';
import type { GameAssets } from './Assets';
import { PlanetTerrain, type TerrainWorkerPool } from './planet/PlanetTerrain';
import { createTerrainMaterial } from './planet/TerrainMaterial';
import type { AtmosphereFrame } from './post/AtmospherePass';
import type { CompositeFrame } from './post/PostFX';
import { Sky } from './sky/Sky';

/** Solar radiance scale at 1 AU in the renderer's HDR units. */
export const SUN_RADIANCE = 20;

interface PlanetView {
  body: CelestialBody;
  terrain: PlanetTerrain;
  material: ShaderMaterial;
}

export interface SceneQuality {
  lodBias: number;
  clouds: boolean;
  /** Particle density multiplier (smoke, sparks, dust). */
  effects: number;
  maxLevel: { earth: number; moon: number; mars: number };
}

const _v = new Vector3();
const _v2 = new Vector3();
const _m4 = new Matrix4();
const _rgb: [number, number, number] = [0, 0, 0];

export class SpaceScene {
  readonly scene = new Scene();
  readonly sky = new Sky();
  readonly sunLight: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly earthLUTs: AtmosphereLUTs;
  readonly marsLUTs: AtmosphereLUTs;
  private readonly planets: PlanetView[] = [];
  readonly system: SolarSystem;
  /** Absolute camera position (heliocentric metres). */
  readonly cameraAbs = new Vector3();
  /** Unit direction from camera to Sun (world). */
  readonly sunDir = new Vector3(1, 0, 0);
  /** Sunlight colour × intensity reaching the camera location (after atmosphere, eclipse). */
  readonly sunColorAtCamera = new Vector3(1, 1, 1);
  readonly atmFrame: AtmosphereFrame;
  readonly compFrame: CompositeFrame;
  atmosphereBody: CelestialBody | null = null;
  exposure = 0.42;
  private currentLUTs: AtmosphereLUTs | null = null;
  quality: SceneQuality = { lodBias: 1, clouds: true, effects: 1, maxLevel: { earth: 17, moon: 16, mars: 16 } };
  /** Altitude of the camera above the nearest body's surface (m). */
  cameraAltitude = 0;
  nearestBody: CelestialBody | null = null;

  constructor(system: SolarSystem, assets: GameAssets, pool: TerrainWorkerPool) {
    this.system = system;
    this.scene.matrixWorldAutoUpdate = true;
    this.earthLUTs = new AtmosphereLUTs(EARTH_ATMOSPHERE);
    this.marsLUTs = new AtmosphereLUTs(MARS_ATMOSPHERE);
    this.scene.add(this.sky.group);
    this.sky.setMilkyWay(assets.milkyWay);
    this.sky.setStars(assets.stars);

    this.sunLight = new DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = false;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.hemi = new HemisphereLight(0x88aaff, 0x223344, 0.2);
    this.scene.add(this.hemi);

    const P = assets.pbr;
    const earthMat = createTerrainMaterial(
      'earth',
      {
        day: assets.earthDay,
        night: assets.earthNight,
        normal: assets.earthNormal,
        mask: assets.earthMask,
        clouds: assets.earthClouds,
        water: assets.water,
        detailA: P.grass.diff,
        detailANormal: P.grass.nor,
        detailB: P.sand.diff,
        detailC: P.rock.diff,
      },
      this.earthLUTs,
      system.earth.radius,
    );
    const moonMat = createTerrainMaterial(
      'moon',
      { day: assets.moonColor, normal: assets.moonNormal, detailA: P.regolith.diff, detailANormal: P.regolith.nor, detailB: P.regolith.diff, detailC: P.rock.diff },
      null,
      system.moon.radius,
    );
    const marsMat = createTerrainMaterial(
      'mars',
      { day: assets.marsColor, normal: assets.marsNormal, detailA: P.sand.diff, detailANormal: P.sand.nor, detailB: P.sand.diff, detailC: P.rock.diff },
      this.marsLUTs,
      system.mars.radius,
    );
    const mk = (body: CelestialBody, material: ShaderMaterial, key: BodyId, maxLevel: number, maxCached: number) => {
      const terrain = new PlanetTerrain(body, material, pool, { maxLevel, splitFactor: 2.6, maxCached, bodyKey: key });
      terrain.prime();
      this.scene.add(terrain.group);
      this.planets.push({ body, terrain, material });
    };
    mk(system.earth, earthMat, 'earth', 17, 900);
    mk(system.moon, moonMat, 'moon', 16, 600);
    mk(system.mars, marsMat, 'mars', 16, 400);

    this.atmFrame = {
      enabled: true,
      luts: this.earthLUTs,
      planetCenter: new Vector3(),
      cameraAltitude: 0,
      sunDir: new Vector3(1, 0, 0),
      sunRadiance: new Vector3(SUN_RADIANCE, SUN_RADIANCE, SUN_RADIANCE),
      worldToBody: new Matrix3(),
      cloudsEnabled: true,
      cloudAltitude: 6500,
      cloudOpacity: 0.95,
      time: 0,
    };
    this.compFrame = {
      exposure: 0.6,
      sunUV: new Vector2(0.5, 0.5),
      sunOnScreen: false,
      flare: 0,
      flareTint: new Vector3(1, 0.95, 0.85),
      time: 0,
      fade: 1,
    };
  }

  get terrainsReady(): boolean {
    return this.planets.every((p) => p.terrain.baseReady);
  }

  terrainFor(id: BodyId): PlanetTerrain | undefined {
    return this.planets.find((p) => p.body.id === id)?.terrain;
  }

  /** Current atmosphere LUTs (for other systems, e.g. environment probes). */
  get activeLUTs(): AtmosphereLUTs | null {
    return this.currentLUTs;
  }

  /**
   * Per-frame update. The solar system must already be at the render time.
   * @param camAbs absolute camera position
   */
  update(camAbs: Vector3, camera: PerspectiveCamera, realTime: number, pixelRatio: number): void {
    this.cameraAbs.copy(camAbs);
    const sys = this.system;
    const sun = sys.sun;
    this.sunDir.copy(sun.position).sub(camAbs).normalize();

    // Nearest body (by altitude relative to radius)
    let nearest: CelestialBody = sys.earth;
    let best = Infinity;
    for (const b of sys.ordered) {
      if (b.id === 'sun') continue;
      const d = b.position.distanceTo(camAbs);
      const score = (d - b.radius) / b.radius;
      if (score < best) {
        best = score;
        nearest = b;
      }
    }
    this.nearestBody = nearest;
    this.cameraAltitude = nearest.position.distanceTo(camAbs) - nearest.radius;

    // Planets
    for (const p of this.planets) {
      const b = p.body;
      p.terrain.group.position.copy(b.position).sub(camAbs);
      p.terrain.group.quaternion.copy(b.rotation);
      _v.copy(camAbs).sub(b.position).applyQuaternion(b.rotationInverse);
      p.terrain.update(_v, this.quality.lodBias);
      const u = p.material.uniforms;
      (u.uSunDir!.value as Vector3).copy(sun.position).sub(b.position).normalize();
      const dist = sun.position.distanceTo(b.position);
      const rad = SUN_RADIANCE * (AU / dist) ** 2;
      (u.uSunRadiance!.value as Vector3).set(rad, rad * 0.985, rad * 0.955);
      _m4.makeRotationFromQuaternion(b.rotation);
      (u.uBodyToWorld!.value as Matrix3).setFromMatrix4(_m4);
      (u.uWorldToBody!.value as Matrix3).setFromMatrix4(_m4).transpose();
      (u.uPlanetCenter!.value as Vector3).copy(b.position).sub(camAbs);
      u.uTime!.value = realTime;
      if (b.id === 'moon') {
        u.uEclipse!.value = sys.sunVisibility(b.position);
        (u.uEarthDir!.value as Vector3).copy(sys.earth.position).sub(b.position).normalize();
        // Earthshine ∝ Earth's illuminated fraction seen from the Moon
        const toSunFromEarth = _v2.copy(sun.position).sub(sys.earth.position).normalize();
        const toMoon = _v.copy(b.position).sub(sys.earth.position).normalize();
        const phase = 0.5 * (1 + toSunFromEarth.dot(toMoon));
        u.uEarthshine!.value = 0.0035 * phase * rad;
      }
      if (b.id === 'earth') {
        u.uCloudsEnabled!.value = this.quality.clouds ? 1 : 0;
      }
    }

    // Atmosphere selection: Earth unless we're closer to Mars
    const earth = sys.earth;
    const mars = sys.mars;
    const dEarth = earth.position.distanceTo(camAbs) / earth.radius;
    const dMars = mars.position.distanceTo(camAbs) / mars.radius;
    const atmBody = dMars < dEarth ? mars : earth;
    const luts = atmBody === mars ? this.marsLUTs : this.earthLUTs;
    this.atmosphereBody = atmBody;
    const f = this.atmFrame;
    f.planetCenter.copy(atmBody.position).sub(camAbs);
    const camR = atmBody.position.distanceTo(camAbs);
    f.cameraAltitude = camR - luts.params.bottomRadius;
    f.enabled = camR / atmBody.radius < 400;
    f.sunDir.copy(this.sunDir);
    const sd = sun.position.distanceTo(atmBody.position);
    const sr = SUN_RADIANCE * (AU / sd) ** 2;
    f.sunRadiance.set(sr, sr * 0.985, sr * 0.955);
    _m4.makeRotationFromQuaternion(atmBody.rotation);
    f.worldToBody.setFromMatrix4(_m4).transpose();
    f.cloudsEnabled = atmBody === earth && this.quality.clouds;
    f.time = realTime;
    f.luts = luts;
    this.currentLUTs = luts;

    // Sunlight reaching the camera (for vessels/pad lighting)
    const vis = sys.sunVisibility(camAbs);
    const camSunDist = sun.position.distanceTo(camAbs);
    const baseRad = SUN_RADIANCE * (AU / camSunDist) ** 2;
    const tr: [number, number, number] = [1, 1, 1];
    if (f.cameraAltitude < luts.params.topRadius - luts.params.bottomRadius) {
      const up = _v.copy(camAbs).sub(atmBody.position).normalize();
      luts.sunTransmittance(Math.max(camR, luts.params.bottomRadius + 1), up.dot(this.sunDir), tr);
    }
    this.sunColorAtCamera.set(baseRad * tr[0] * vis, baseRad * 0.985 * tr[1] * vis, baseRad * 0.955 * tr[2] * vis);

    // Scene lights (for PBR vessel/pad materials). three's physically-correct lights
    // use irradiance ≈ intensity × colour; our HDR scale matches the terrain.
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);
    this.sunLight.target.position.set(0, 0, 0);
    const lum = Math.max(this.sunColorAtCamera.x, this.sunColorAtCamera.y, this.sunColorAtCamera.z, 1e-6);
    this.sunLight.color.setRGB(this.sunColorAtCamera.x / lum, this.sunColorAtCamera.y / lum, this.sunColorAtCamera.z / lum);
    this.sunLight.intensity = lum;
    // Hemisphere: sky ambient when in atmosphere, planet-shine otherwise
    if (f.cameraAltitude < 100_000) {
      const up = _v.copy(camAbs).sub(atmBody.position).normalize();
      const muS = up.dot(this.sunDir);
      luts.sampleAmbient(muS, _rgb);
      const s = sr;
      this.hemi.color.setRGB(_rgb[0] * s, _rgb[1] * s, _rgb[2] * s);
      this.hemi.groundColor.setRGB(_rgb[0] * s * 0.5, _rgb[1] * s * 0.45, _rgb[2] * s * 0.35);
      this.hemi.intensity = 1;
      this.hemi.position.copy(up);
    } else {
      this.hemi.color.setRGB(0.002, 0.002, 0.003);
      const shine = nearest === earth ? 4 : 1;
      this.hemi.groundColor.setRGB(0.01 * shine, 0.015 * shine, 0.02 * shine);
      this.hemi.intensity = 1;
      this.hemi.position.copy(camAbs).sub(nearest.position).normalize();
    }

    // Stars: twinkle only when looking up through air
    const inAir = f.enabled && f.cameraAltitude < 60_000 ? 1 - f.cameraAltitude / 60_000 : 0;
    this.sky.update(realTime, pixelRatio, 0.25 * inAir, 1);

    // Lens flare / glare
    const c = this.compFrame;
    c.time = realTime;
    _v.copy(this.sunDir).applyMatrix4(camera.matrixWorldInverse);
    const sunVisible = this.sunVisibleFrom(camAbs);
    if (_v.z < 0 && sunVisible) {
      _v.applyMatrix4(camera.projectionMatrix);
      c.sunUV.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
      const onScreen = c.sunUV.x > -0.2 && c.sunUV.x < 1.2 && c.sunUV.y > -0.2 && c.sunUV.y < 1.2;
      c.sunOnScreen = onScreen;
      const bright = Math.min(1, (this.sunColorAtCamera.x / SUN_RADIANCE) * 1.2);
      c.flare = onScreen ? bright * 0.9 : 0;
      c.flareTint.set(tr[0], tr[1] * 0.97, tr[2] * 0.92);
    } else {
      c.sunOnScreen = false;
      c.flare = 0;
    }
    // Eye adaptation: in eclipse/shadow the "camera" opens up so earthshine,
    // starlight and lit hardware stay readable (bright things then saturate — as
    // in any real photograph taken in the dark). Adapts over ~1.5 s.
    const key = Math.max(this.sunColorAtCamera.x, this.sunColorAtCamera.y) / SUN_RADIANCE;
    // Under an atmosphere at night artificial lights dominate: adapt less
    const lowInAir = f.enabled && f.cameraAltitude < 80_000;
    const target = Math.min(lowInAir ? 1.6 : 4, this.exposure / Math.max(0.1, Math.min(1, key)));
    const dtAdapt = this.lastRealTime > 0 ? Math.min(0.5, Math.max(0, realTime - this.lastRealTime)) : 10;
    this.lastRealTime = realTime;
    this.adaptedExposure += (target - this.adaptedExposure) * (1 - Math.exp(-dtAdapt / 1.5));
    c.exposure = this.adaptedExposure;
  }

  private lastRealTime = 0;
  private adaptedExposure = 0.42;

  /** Is the Sun's centre visible from p (not behind any planet/moon)? */
  sunVisibleFrom(p: Vector3): boolean {
    const d = this.sunDir;
    for (const b of this.system.ordered) {
      if (b.id === 'sun') continue;
      _v2.copy(b.position).sub(p);
      const t = _v2.dot(d);
      if (t < 0) continue;
      const d2 = _v2.lengthSq() - t * t;
      if (d2 < b.radius * b.radius) return false;
    }
    return true;
  }
}
