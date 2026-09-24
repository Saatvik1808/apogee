/**
 * LEARNING NOTE: Shading a planet
 *
 * EARTH. Colour comes from NASA's Blue Marble mosaic, relief from a normal map
 * derived from real elevation data (stored in a local East-North-Up frame so it
 * can be rotated onto any point of the sphere). Sunlight reaching the ground is
 * filtered by the atmosphere (the same transmittance table the sky uses, so the
 * terminator glows orange) and dimmed by cloud SHADOWS — we look up the cloud
 * texture where the sun ray crosses the cloud layer. Oceans use a microfacet
 * (GGX) specular lobe whose roughness grows with distance: up close you see a
 * sharp sun glint on waves, from orbit a broad sheen. City lights (NASA Black
 * Marble) fade in on the night side.
 *
 * MOON. Regolith doesn't behave like paint: it is a dusty, porous surface that
 * back-scatters light. The Lommel–Seeliger law  f ∝ μ₀/(μ₀+μ)  explains why the
 * full Moon looks like a flat disc with no limb darkening; an "opposition surge"
 * brightens it further when the Sun is directly behind you. Earthshine lights the
 * night side faintly.
 *
 * Close to the ground, tiled detail textures (grass, sand, rock, regolith) are
 * blended in with triplanar mapping so the surface stays crisp at 1 m scale.
 *
 * Key concepts: tangent frames on a sphere, microfacet BRDF (GGX, Schlick
 * Fresnel), Lommel–Seeliger, emissive maps, triplanar mapping, distance fades
 */
import { LAUNCH_SITES } from '../../world/LaunchSites';
import { CelestialBody } from '../../physics/CelestialBody';
import { Matrix3, RepeatWrapping, ShaderMaterial, Texture, Vector3 } from 'three';
import type { AtmosphereLUTs } from '../atmosphere/AtmosphereModel';
import { ATMOSPHERE_FUNCS, ATMOSPHERE_UNIFORMS, EQUIRECT, NOISE, glsl } from '../shaders/chunks';

export type TerrainKind = 'earth' | 'moon' | 'mars';

export interface TerrainTextures {
  day: Texture | null;
  night?: Texture | null;
  normal: Texture | null;
  mask?: Texture | null;
  clouds?: Texture | null;
  water?: Texture | null;
  detailA: Texture | null;
  detailANormal: Texture | null;
  detailB: Texture | null;
  detailC: Texture | null;
}

const vert = glsl`
attribute vec3 aDir;
attribute float aHeight;
attribute vec3 aDetail;
attribute vec2 aMacro;
varying vec3 vDir;
varying float vHeight;
varying vec3 vDetail;
varying vec2 vMacro;
varying vec3 vWorld;
varying vec3 vNormalW;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vDir = aDir;
  vHeight = aHeight;
  vDetail = aDetail;
  vMacro = aMacro;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const frag = glsl`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vDir;
varying float vHeight;
varying vec3 vDetail;
varying vec2 vMacro;
varying vec3 vWorld;
varying vec3 vNormalW;

uniform sampler2D tDay;
uniform sampler2D tNormal;
uniform sampler2D tDetailA;
uniform sampler2D tDetailANormal;
uniform sampler2D tDetailB;
uniform sampler2D tDetailC;
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform mat3 uBodyToWorld;
uniform mat3 uWorldToBody;
uniform vec3 uPlanetCenter;
uniform float uRadius;
uniform float uNormalStrength;
uniform float uTime;
uniform float uEclipse;
uniform float uAlbedoScale;
uniform int uDebug;
#ifdef BODY_EARTH
uniform vec3 uSites[4];
uniform vec3 uSiteEast[4];
uniform vec3 uSiteNorth[4];
uniform sampler2D tNight;
uniform sampler2D tMask;
uniform sampler2D tClouds;
uniform sampler2D tWater;
uniform float uCloudAlt;
uniform float uCloudsEnabled;
#endif
#ifdef BODY_MOON
uniform vec3 uEarthDir;
uniform float uEarthshine;
#endif
#if defined(BODY_EARTH) || defined(BODY_MARS)
${ATMOSPHERE_UNIFORMS}
${ATMOSPHERE_FUNCS}
#endif
${EQUIRECT}
${NOISE}

// Triplanar sample with explicit gradients (so it is legal inside branches);
// projection planes whose weight is zero are skipped entirely.
vec3 triplanar(sampler2D t, vec3 p, vec3 gx, vec3 gy, vec3 w) {
  vec3 c = vec3(0.0);
  if (w.x > 0.0) c += textureGrad(t, p.yz, gx.yz, gy.yz).rgb * w.x;
  if (w.y > 0.0) c += textureGrad(t, p.zx, gx.zx, gy.zx).rgb * w.y;
  if (w.z > 0.0) c += textureGrad(t, p.xy, gx.xy, gy.xy).rgb * w.z;
  return c;
}
#define TRI(t, s) triplanar(t, p / (s), gx / (s), gy / (s), tri)

float D_GGX(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}
// Height-correlated Smith visibility V = G / (4·NdotL·NdotV)
float V_Smith(float NdotV, float NdotL, float a) {
  float a2 = a * a;
  float gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  vec2 uv = dirToEquirect(dir);
  float dist = length(vWorld);
  vec3 V = -vWorld / max(dist, 1e-3);
  vec3 up = normalize(vWorld - uPlanetCenter);
  vec3 L = uSunDir;
  float muS = dot(up, L);

  // Local ENU frame (body-fixed) → world
  vec3 eastB = vec3(dir.z, 0.0, -dir.x);
  float el = length(eastB);
  eastB = el > 1e-5 ? eastB / el : vec3(1.0, 0.0, 0.0);
  vec3 northB = cross(dir, eastB);
  vec3 e = uBodyToWorld * eastB;
  vec3 n = uBodyToWorld * northB;

  // Relief normal: map (far) + mesh (near)
  vec3 nm = texture2D(tNormal, uv).xyz * 2.0 - 1.0;
  float farN = smoothstep(2000.0, 60000.0, dist);
  vec3 N = normalize(vNormalW + (e * nm.x + n * nm.y) * uNormalStrength * mix(0.35, 1.0, farN));

  vec3 albedo = texture2D(tDay, uv).rgb * uAlbedoScale;
  vec3 dbgRaw = albedo;
  vec3 dbgDet = vec3(0.0);
#ifdef BODY_EARTH
  // Texture/geometry coherence on coasts: the 5 km/px mosaic can paint water on
  // land cells (and vice versa). Geometry wins up close.
  float lumA = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  float watery = smoothstep(1.3, 2.2, albedo.b / max(albedo.r, 1e-3)) * (1.0 - smoothstep(0.05, 0.12, lumA));
  float geoLand = smoothstep(0.5, 4.0, vHeight) * (1.0 - smoothstep(20000.0, 60000.0, length(vWorld)));
  // Plausible coastal scrub/grass albedo (linear), sandier right at the shoreline
  vec3 coastLand = mix(vec3(0.22, 0.2, 0.15), vec3(0.075, 0.1, 0.045), smoothstep(1.0, 4.0, vHeight));
  albedo = mix(albedo, coastLand, watery * geoLand);
  // Macro variation (fields, forests, soil) — direction-based noise is seam-free
  float macroFade = 1.0 - smoothstep(20000.0, 150000.0, dist);
  if (macroFade > 0.001 && vHeight > 0.5) {
    // Noise fields computed per vertex by the terrain workers (see macroAt)
    float m1 = vMacro.x;
    float m2 = vMacro.y;
    vec3 greener = albedo * vec3(0.8, 1.12, 0.75);
    vec3 browner = albedo * vec3(1.18, 1.0, 0.82);
    vec3 v = mix(greener, browner, smoothstep(-0.25, 0.25, m1));
    v *= 1.0 + 0.4 * clamp(m2, -1.0, 1.0);
    albedo = mix(albedo, v, macroFade * 0.85);
  }
#endif

  // Close-range detail (triplanar in body-fixed metres)
  float detailFade = 1.0 - smoothstep(900.0, 7000.0, dist);
  vec3 tri = pow(abs(dir), vec3(4.0));
  tri /= (tri.x + tri.y + tri.z);
  // Drop planes that contribute < 3 % and renormalise (saves 1 of 3 fetches almost everywhere)
  tri = max(tri - 0.03, 0.0);
  tri /= (tri.x + tri.y + tri.z);
  if (detailFade > 0.001) {
    vec3 p = vDetail;
    vec3 gx = dFdx(p);
    vec3 gy = dFdy(p);
    float slope = 1.0 - clamp(dot(vNormalW, up), 0.0, 1.0);
#ifdef BODY_EARTH
    float green = clamp((albedo.g - albedo.r) * 6.0 + 0.3, 0.0, 1.0);
    float sandy = clamp((albedo.r - albedo.b) * 5.0 * (1.0 - green) + (vHeight < 12.0 ? 0.4 : 0.0), 0.0, 1.0);
    float rocky = smoothstep(0.18, 0.45, slope);
    vec3 dA = TRI(tDetailA, 64.0) * 0.55 + TRI(tDetailA, 256.0) * 0.45; // aerial meadow/rock (~90 m source tile)
    // Only sample the layers that are actually visible here
    vec3 dB = sandy > 0.0 ? TRI(tDetailB, 32.0) : dA; // beach sand (~30 m tile)
    vec3 dC = rocky > 0.0 ? TRI(tDetailC, 4.0) * 0.5 + TRI(tDetailC, 64.0) * 0.5 : dA; // rock (~3 m tile)
    vec3 det = mix(mix(dA, dB, sandy), dC, rocky);
    dbgDet = det;
    // Normalise by each texture's mean colour (its 1×1 mip) so detail adds
    // pattern without changing the large-scale albedo from the satellite mosaic.
    vec3 avg = mix(mix(textureLod(tDetailA, vec2(0.5), 12.0).rgb, textureLod(tDetailB, vec2(0.5), 12.0).rgb, sandy), textureLod(tDetailC, vec2(0.5), 12.0).rgb, rocky);
    const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
    float ratio = dot(det, LW) / max(dot(avg, LW), 1e-4);
    vec3 tint = (det / max(dot(det, LW), 1e-4)) / max(avg / max(dot(avg, LW), 1e-4), vec3(1e-3));
    vec3 target = albedo * clamp(ratio, 0.0, 3.0) * mix(vec3(1.0), tint, 0.35);
    albedo = mix(albedo, target, detailFade * 0.9);
    vec3 dn = TRI(tDetailANormal, 64.0) * 2.0 - 1.0;
    N = normalize(N + (e * dn.x + n * dn.y) * 0.35 * detailFade);
#else
    float rocky = smoothstep(0.2, 0.5, slope);
    vec3 dA = TRI(tDetailA, 4.0) * 0.5 + TRI(tDetailA, 64.0) * 0.5;
    vec3 dC = rocky > 0.0 ? TRI(tDetailC, 32.0) : dA;
    vec3 det = mix(dA, dC, rocky);
    dbgDet = det;
    vec3 avg = mix(textureLod(tDetailA, vec2(0.5), 12.0).rgb, textureLod(tDetailC, vec2(0.5), 12.0).rgb, rocky);
    const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
    float ratio = dot(det, LW) / max(dot(avg, LW), 1e-4);
    albedo = mix(albedo, albedo * clamp(ratio, 0.0, 3.0), detailFade * 0.9);
    vec3 dn = TRI(tDetailANormal, 4.0) * 2.0 - 1.0;
    N = normalize(N + (e * dn.x + n * dn.y) * 0.5 * detailFade);
#endif
  }

#ifdef BODY_EARTH
  // Launch-complex ground works: a gravel apron round the pad, a perimeter road,
  // the twin-lane crawlerway heading inland and an access road. Positions are
  // metres east/north of each pad, from the direction difference × radius.
  if (dist < 25000.0) {
    float apron = 0.0;
    float road = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 dd = dir - uSites[i];
      vec2 q = vec2(dot(dd, uSiteEast[i]), dot(dd, uSiteNorth[i])) * uRadius;
      float rr = length(q);
      if (rr > 3500.0) continue;
      apron = max(apron, 1.0 - smoothstep(115.0, 200.0, rr));
      float ring = 1.0 - smoothstep(5.0, 8.0, abs(rr - 430.0));
      float lanes = (1.0 - smoothstep(5.5, 7.5, abs(abs(q.y) - 11.0))) * step(q.x, -140.0) * (1.0 - smoothstep(3000.0, 3100.0, -q.x));
      float access = (1.0 - smoothstep(3.5, 5.5, abs(q.x + 0.35 * q.y + 260.0))) * step(q.y, -180.0) * step(-2600.0, q.y);
      road = max(road, max(ring, max(lanes, access)));
    }
    albedo = mix(albedo, vec3(0.33, 0.31, 0.27), apron * 0.85);
    albedo = mix(albedo, vec3(0.075, 0.075, 0.08), road * 0.9);
  }
#endif
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-3);
  vec3 color = vec3(0.0);

#ifdef BODY_EARTH
  // Water mask: vertex heights up close, texture mask far away
  // Coast SDF (sqrt-encoded): decode signed distance in metres
  float sv = (texture2D(tMask, uv).r * 255.0 - 128.0) / 127.0;
  float coastD = sign(sv) * sv * sv * 60000.0;
  float wHeight = 1.0 - smoothstep(-3.0, 0.8, vHeight);
  float wTex = 1.0 - smoothstep(-600.0, 600.0, coastD);
  float water = mix(wHeight, wTex, smoothstep(80000.0, 400000.0, dist));

  // Cloud shadow where the sun ray crosses the cloud layer
  float cloudShadow = 1.0;
  float coverHere = 0.0;
  if (uCloudsEnabled > 0.5) {
    vec3 sunB = uWorldToBody * L;
    float k = (uCloudAlt / uRadius) / max(muS, 0.12);
    vec3 cd = normalize(dir + (sunB - dir * dot(sunB, dir)) * k);
    float cov = texture2D(tClouds, dirToEquirect(cd)).r;
    cloudShadow = 1.0 - 0.72 * smoothstep(0.12, 0.8, cov);
    coverHere = texture2D(tClouds, uv).r;
  }
  vec3 sunT = atmSunTransmittance(uAtmBottom + max(vHeight, 0.0) + 2.0, muS);
  vec3 sunLight = uSunRadiance * sunT * cloudShadow * uEclipse;
  vec3 skyE = atmAmbient(muS) * uSunRadiance * uEclipse;

  // Land
  vec3 land = albedo / 3.14159265 * (sunLight * NdotL + skyE);

  // Ocean
  vec3 wn = up;
  float nearW = 1.0 - smoothstep(200.0, 8000.0, dist);
  if (nearW > 0.001) {
    vec2 wuv1 = vDetail.xz / 90.0 + vec2(uTime * 0.012, uTime * 0.007);
    vec2 wuv2 = vDetail.zy / 37.0 - vec2(uTime * 0.009, -uTime * 0.013);
    vec3 w1 = texture2D(tWater, wuv1).xyz * 2.0 - 1.0;
    vec3 w2 = texture2D(tWater, wuv2).xyz * 2.0 - 1.0;
    vec2 wp = (w1.xy + w2.xy) * 0.5;
    wn = normalize(up + (e * wp.x + n * wp.y) * 0.35 * nearW);
  }
  float rough = mix(0.06, 0.2, smoothstep(300.0, 400000.0, dist));
  vec3 H = normalize(L + V);
  float NdotHw = max(dot(wn, H), 0.0);
  float NdotLw = max(dot(wn, L), 0.0);
  float NdotVw = max(dot(wn, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float spec = D_GGX(NdotHw, rough) * V_Smith(NdotVw, NdotLw, rough) * F * NdotLw;
  float Fv = 0.02 + 0.98 * pow(1.0 - NdotVw, 5.0);
  vec3 skyRefl = skyE / 3.14159265 * 1.3;
  // Where the mosaic shows land but geometry says sea, use a clean ocean colour
  vec3 oceanTex = mix(vec3(0.004, 0.018, 0.045), albedo, watery);
  vec3 deep = oceanTex * 0.55 + vec3(0.002, 0.008, 0.016);
  vec3 ocean = deep / 3.14159265 * (sunLight * NdotLw * 0.6 + skyE) * (1.0 - Fv) + skyRefl * Fv + sunLight * spec;

  color = mix(land, ocean, water);

  // City lights on the night side (dimmed by cloud cover)
  vec3 night = texture2D(tNight, uv).rgb;
  float dark = smoothstep(0.08, -0.12, muS);
  color += night * vec3(1.0, 0.72, 0.42) * 0.9 * dark * (1.0 - 0.75 * smoothstep(0.2, 0.8, coverHere)) * (1.0 - water * 0.9);
#endif

#ifdef BODY_MARS
  vec3 sunT = atmSunTransmittance(uAtmBottom + max(vHeight, 0.0) + 2.0, muS);
  vec3 sunLight = uSunRadiance * sunT * uEclipse;
  vec3 skyE = atmAmbient(muS) * uSunRadiance * uEclipse;
  color = albedo / 3.14159265 * (sunLight * NdotL + skyE);
#endif

#ifdef BODY_MOON
  float mu0 = max(dot(N, L), 0.0);
  float ls = 2.0 * mu0 / (mu0 + NdotV);
  float g = acos(clamp(dot(L, V), -1.0, 1.0));
  float surge = 1.0 + 0.45 * exp(-g / 0.1);
  color = albedo / 3.14159265 * uSunRadiance * uEclipse * ls * surge;
  // Earthshine: faint bluish fill from the Earth's lit side
  float eN = max(dot(N, uEarthDir), 0.0);
  color += albedo * vec3(0.55, 0.7, 1.0) * uEarthshine * eN;
#endif

  if (uDebug == 1) color = albedo;
  else if (uDebug == 2) color = N * 0.5 + 0.5;
  else if (uDebug == 3) color = vec3(detailFade);
  else if (uDebug == 4) color = vec3(NdotL);
  else if (uDebug == 5) color = dbgDet;
  else if (uDebug == 6) color = dbgRaw;
  else if (uDebug == 7) color = fract(vDetail / 64.0);
#ifdef BODY_EARTH
  else if (uDebug == 8) color = vec3(water, fract(vHeight), clamp(vHeight / 10.0, 0.0, 1.0));
#endif
  gl_FragColor = vec4(color, 1.0);
}
`;

function setupTex(t: Texture | null | undefined, repeat = false): Texture | null {
  if (!t) return null;
  if (repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  } else {
    t.wrapS = RepeatWrapping;
  }
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function createTerrainMaterial(kind: TerrainKind, tex: TerrainTextures, luts: AtmosphereLUTs | null, radius: number): ShaderMaterial {
  const defines: Record<string, string> = {};
  defines[kind === 'earth' ? 'BODY_EARTH' : kind === 'moon' ? 'BODY_MOON' : 'BODY_MARS'] = '';
  const uniforms: Record<string, { value: unknown }> = {
    tDay: { value: setupTex(tex.day) },
    tNormal: { value: setupTex(tex.normal) },
    tDetailA: { value: setupTex(tex.detailA, true) },
    tDetailANormal: { value: setupTex(tex.detailANormal, true) },
    tDetailB: { value: setupTex(tex.detailB, true) },
    tDetailC: { value: setupTex(tex.detailC, true) },
    uSunDir: { value: new Vector3(1, 0, 0) },
    uSunRadiance: { value: new Vector3(20, 20, 20) },
    uBodyToWorld: { value: new Matrix3() },
    uWorldToBody: { value: new Matrix3() },
    uPlanetCenter: { value: new Vector3() },
    uRadius: { value: radius },
    uNormalStrength: { value: kind === 'moon' ? 1.0 : 0.8 },
    uTime: { value: 0 },
    uEclipse: { value: 1 },
    // The LROC mosaic is display-stretched; real lunar albedo is ~0.12
    uAlbedoScale: { value: kind === 'earth' ? 0.85 : kind === 'moon' ? 0.45 : 0.9 },
    uDebug: { value: 0 },
  };
  if (kind === 'earth') {
    const sites: Vector3[] = [];
    const easts: Vector3[] = [];
    const norths: Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const site = LAUNCH_SITES[i];
      const d = site ? CelestialBody.dirFromLatLon((site.lat * Math.PI) / 180, (site.lon * Math.PI) / 180, new Vector3()) : new Vector3(0, -1, 0);
      const e = new Vector3(d.z, 0, -d.x).normalize();
      sites.push(d);
      easts.push(e);
      norths.push(new Vector3().crossVectors(d, e).normalize());
    }
    uniforms.uSites = { value: sites };
    uniforms.uSiteEast = { value: easts };
    uniforms.uSiteNorth = { value: norths };
    uniforms.tNight = { value: setupTex(tex.night) };
    uniforms.tMask = { value: setupTex(tex.mask) };
    uniforms.tClouds = { value: setupTex(tex.clouds) };
    uniforms.tWater = { value: setupTex(tex.water, true) };
    uniforms.uCloudAlt = { value: 6500 };
    uniforms.uCloudsEnabled = { value: tex.clouds ? 1 : 0 };
  }
  if (kind === 'moon') {
    uniforms.uEarthDir = { value: new Vector3(1, 0, 0) };
    uniforms.uEarthshine = { value: 0.02 };
  }
  if (luts) {
    const p = luts.params;
    Object.assign(uniforms, {
      uAtmBottom: { value: p.bottomRadius },
      uAtmTop: { value: p.topRadius },
      uRayleigh: { value: new Vector3(...p.rayleighScattering) },
      uRayleighScale: { value: p.rayleighScale },
      uMieScat: { value: new Vector3(...p.mieScattering) },
      uMieExt: { value: new Vector3(...p.mieExtinction) },
      uMieScale: { value: p.mieScale },
      uMieG: { value: p.mieG },
      uAbsorption: { value: new Vector3(...p.absorption) },
      uAbsCenter: { value: p.absorptionCenter },
      uAbsWidth: { value: p.absorptionWidth },
      tTransmittance: { value: luts.transmittanceTexture },
      tMultiScatter: { value: luts.multiScatteringTexture },
      tAmbient: { value: luts.ambientTexture },
    });
  }
  return new ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    defines,
    uniforms,
  });
}
