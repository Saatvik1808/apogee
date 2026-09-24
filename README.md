# APOGEE

A browser space-program game: design rockets in the vehicle assembly building, then fly them
from a real-scale Earth to orbit, around the Moon and down to a powered landing on its surface.
Everything runs client-side in the browser (Three.js + TypeScript, no server).

- **Rocket builder** — tanks, engines and engine clusters, decouplers, fins, legs and parachutes
  with attach nodes, radial symmetry, drag-and-drop staging, undo/redo and live Δv / TWR per stage.
- **Real orbital mechanics** — true-scale Earth, Moon and Mars, patched-conic trajectories,
  atmospheric drag, fuel flow and staging, maneuver nodes with a burn planner (circularize,
  trans-lunar injection, mid-course correction, return to Earth, de-orbit).
- **Campaign** — ten missions from a first sounding rocket to a crewed Moon landing and
  return, plus quick launches from four real launch sites at any time of day or in the
  computed lunar launch window.
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

## Controls

**Flight**

| Key             | Action                         | Key     | Action                          |
| --------------- | ------------------------------ | ------- | ------------------------------- |
| W / S           | Pitch                          | Space   | Activate next stage             |
| A / D           | Yaw                            | T       | Toggle SAS (attitude hold)      |
| Q / E           | Roll                           | G       | Toggle landing legs             |
| Shift / Ctrl    | Throttle up / down             | M       | Map view                        |
| Z / X           | Full / cut throttle            | N       | Add maneuver node (map view)    |
| , / .           | Time warp down / up            | V       | Cycle camera                    |
| /               | Stop time warp                 | P       | Pause                           |
| H or F1         | Help                           | F2      | Hide the HUD                    |
| Esc             | Pause menu                     |         |                                 |

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
| `?quick=<template>`               | Launch a template directly: `pathfinder`, `sprite`, `heron`, `heron-lander`, `colossus` |
| `&site=<id>`                      | Launch site: `cape`, `kourou`, `baikonur`, `vandenberg`        |
| `&tod=<time>`                     | `dawn`, `morning`, `noon`, `dusk`, `night` or `lunar` (window) |
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
