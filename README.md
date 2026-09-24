# APOGEE

A browser space-program game: design rockets in the vehicle assembly building, then fly them
from a real-scale Earth to orbit, around the Moon and down to a powered landing on its surface.
Everything runs client-side in the browser (Three.js + TypeScript, no server).

- **Rocket builder** — tanks, engines and engine clusters, decouplers, fins, legs and parachutes
  with attach nodes, radial symmetry, drag-and-drop staging, undo/redo and live Δv / TWR per stage.
- **Real orbital mechanics** — true-scale Earth, Moon and Mars, patched-conic trajectories,
  atmospheric drag, fuel flow and staging, maneuver nodes with a burn planner (circularize,
  trans-lunar injection, mid-course correction, return to Earth, de-orbit).
- **Campaign** — four story chapters and fourteen missions, from a first sounding rocket to
  a crewed Moon landing and a Mars lander, with a mission-control cast, briefings, live radio
  chatter (loss of signal behind the Moon, re-entry blackout) and three-star ratings; plus
  quick launches from four real launch sites at any time of day or in the computed lunar and
  Mars launch windows (Lambert-solver porkchop search).
- **Graphics options** — Battery saver / Balanced / High / Ultra presets tuned separately for
  phones and desktops, dynamic resolution, frame-rate cap and per-effect controls.
- **Rendering** — physically based atmospheric scattering and clouds, quadtree terrain streamed
  from real elevation data in web workers, night-side city lights, ocean, engine plumes with
  shock diamonds, smoke, bloom, eye adaptation and a reversed-Z depth buffer that covers
  everything from the launch pad to lunar distance.

## Getting started

Requires Node.js **20.19+ or 22.12+** (see `.nvmrc`) and a desktop browser with WebGL 2.

```bash
npm install
npm run dev        # http://localhost:5190
```

| Script              | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Vite dev server with hot reload on port 5190          |
| `npm run build`     | Type-check, then production build into `dist/`       |
| `npm run preview`   | Serve the production build on port 5191              |
| `npm test`          | Unit tests (orbits, trajectories, craft budgets, …)  |
| `npm run typecheck` | TypeScript only                                      |

`APOGEE_LONG=1 npm test` additionally flies a complete Moon landing mission headless (~60 s).

## Deploying

`npm run build` produces a fully static site in `dist/` (about 46 MB, mostly planet textures).
Asset paths are relative (`base: './'`), so it works from a domain root or any sub-path.

| Host                  | Build command   | Output directory | Notes                                  |
| --------------------- | --------------- | ---------------- | -------------------------------------- |
| Vercel                | `npm run build` | `dist`           | Framework preset: Vite                 |
| Netlify               | `npm run build` | `dist`           | Node version is read from `.nvmrc`     |
| Cloudflare Pages      | `npm run build` | `dist`           | Node version is read from `.nvmrc`     |
| GitHub Pages          | `npm run build` | `dist`           | Publish `dist/` with a Pages workflow  |

No environment variables or server are needed. Progress and saved rockets are stored in the
player's browser (`localStorage`).

## Android app

The same code ships as a native Android app via [Capacitor](https://capacitorjs.com): a
full-screen, landscape, offline APK/AAB that runs the game in the system WebView (WebGL 2),
with touch controls, haptics, the Back button and phone-tuned graphics presets.

Requirements: **Node 22** (Capacitor CLI), **JDK 21**, Android SDK platform 36 + build-tools 36.

```bash
npm run android:sync      # web build for phones (drops the 8k maps and full-size detail textures) + copy into android/
npm run android:apk       # signed release APK  → android/app/build/outputs/apk/release/
npm run android:aab       # Play Store bundle   → android/app/build/outputs/bundle/release/
```

Release signing reads `android/keystore.properties` (git-ignored):

```properties
storeFile=keystore/apogee-upload.jks
storePassword=…
keyAlias=apogee
keyPassword=…
```

Keep the keystore and its passwords backed up: Play Store updates must be signed with the
same upload key. Without `keystore.properties` the release build is produced unsigned.
Store listing art (512 px icon, 1024×500 feature graphic) is in `android/store/`; the icon and
splash generator is `tools/android/make_icons.py`.

## Controls

**Touch (phones and tablets)** — left slider: throttle (MAX/CUT at the ends) · right stick:
pitch/yaw, ROLL buttons above it · STAGE button · drag to rotate the camera, pinch to zoom ·
icon bar: map, camera, telemetry, flight computer, photo mode, pause · in the map, tap an
orbit to add a maneuver node · Back button opens the pause menu.

Docking on a phone: the column above STAGE shows **RCS**, **TARGET**, **ALIGN**, **PORT CAM**,
**UNDOCK** and **SWITCH** whenever they apply. RCS turns the left thumb into a translation
stick (left/right, up/down) with **FWD / AFT** buttons along the nose, like Apollo's
translation controller; ALIGN makes SAS hold your docking port facing the target's; PORT CAM
looks out of the port, with a floodlight for the night side. The docking scope shows the
target port's offset, range, closing speed and alignment — centre the dot, keep closing
under 1 m/s, and the ports latch.

**Flight (keyboard)**

| Key             | Action                         | Key     | Action                          |
| --------------- | ------------------------------ | ------- | ------------------------------- |
| W / S           | Pitch                          | Space   | Activate next stage             |
| A / D           | Yaw                            | T       | Toggle SAS (attitude hold)      |
| Q / E           | Roll                           | G       | Toggle landing legs             |
| Shift / Ctrl    | Throttle up / down             | M       | Map view                        |
| Z / X           | Full / cut throttle            | N       | Add maneuver node (map view)    |
| , / .           | Time warp down / up            | V       | Cycle camera (incl. port view)  |
| /               | Stop time warp                 | P       | Pause                           |
| F1              | Help                           | F2      | Hide the HUD                    |
| Esc             | Pause menu                     | R       | Toggle RCS thrusters            |
| H / N           | RCS translate forward / back   | I / K   | RCS translate up / down         |
| J / L           | RCS translate left / right     | [ / ]   | Switch to previous / next vessel |

**Orbital operations** — the flight computer's **Target ▸** button cycles the navigation target
(Moon, Mars, then every other vessel in the flight); in the map view, click a vessel's label
to target it and click again to fly it. With a target vessel selected, **Intercept** plans a
phasing transfer that meets it and **Match velocity** cancels the relative speed at closest
approach. Bring two docking ports face to face below about 1 m/s and the vessels latch into
one; **Undock** (or staging the port) separates them again. Everything you leave in orbit —
or on the Moon or Mars — is kept in the **Tracking station** on the main menu and can be
flown again later; the campaign clock moves forward between flights.

**Assembly building**

| Key                   | Action               |
| --------------------- | -------------------- |
| Click                 | Pick up / place part |
| G                     | Grab selected part   |
| X / Shift+X           | Cycle symmetry       |
| Delete                | Delete selected      |
| Ctrl/Cmd+Z, +Shift+Z  | Undo / redo          |
| Ctrl/Cmd+D            | Duplicate selected   |
| Ctrl/Cmd+S            | Save craft           |
| F                     | Frame the rocket     |

## URL parameters

| Parameter                         | Effect                                                        |
| --------------------------------- | ------------------------------------------------------------- |
| `?quick=<template>`               | Launch a template directly: `pathfinder`, `sprite`, `heron`, `heron-lander`, `nimbus`, `nimbus-relay`, `keystone`, `keystone-core`, `kestrel-dock`, `ares`, `colossus` |
| `&site=<id>`                      | Launch site: `cape`, `kourou`, `baikonur`, `vandenberg`        |
| `&tod=<time>`                     | `dawn`, `morning`, `noon`, `dusk`, `night`, `lunar` or `mars` (windows) |
| `&orbit=<start>`                  | Skip the ascent: `leo` (250 km), `geo`, `moon` (100 km lunar orbit), `mars` (300 km) |
| `?vab`                            | Open the assembly building                                     |
| `?unlock`                         | Unlock every campaign mission                                  |
| `?depth=log`                      | Force the logarithmic depth fallback                           |

## Project layout

```
src/
  core/      constants and math helpers
  physics/   bodies, ephemeris, orbits, atmosphere, trajectory prediction
  parts/     part catalogue, craft layout, staging, Δv analysis, templates
  sim/       flight simulation, vessel physics, autopilot, maneuver planner
  render/    renderer, planet terrain, atmosphere and post-processing, vessels, effects
  game/      app states (menu, assembly building, flight), missions, launch windows, saves
  ui/        HUD, navball, menus and styles
  audio/     procedural audio
public/assets/   planet maps, PBR textures, star catalogue, fonts (see CREDITS.md)
tools/assets/    Python pipeline that downloads source data and builds public/assets
tests/           Vitest suites
```

## Assets and credits

Planet imagery and elevation data come from NASA, NOAA, USGS and Natural Earth (public domain);
ground textures and the hangar HDRI from Poly Haven (CC0); the star catalogue from the HYG
Database (CC BY-SA 4.0); fonts are Inter, JetBrains Mono and Rajdhani (SIL OFL 1.1). Full sources
and licenses are listed in [`public/assets/CREDITS.md`](public/assets/CREDITS.md).

`tools/assets/build_assets.py` regenerates `public/assets` from the original downloads
(`--download` fetches them into the git-ignored `raw-assets/` folder, about 1.8 GB).
