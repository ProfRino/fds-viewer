# FDS Viewer

[![Listed on FDS Third-Party Tools](https://img.shields.io/badge/Listed%20on-FDS%20Third--Party%20Tools-1f5b96?logo=github&logoColor=white)](https://github.com/firemodels/fds/wiki/Third-Party-Tools)
[![Latest release](https://img.shields.io/github/v/release/ProfRino/fds-viewer?logo=github&label=latest)](https://github.com/ProfRino/fds-viewer/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/ProfRino/fds-viewer/total?logo=github&label=downloads&color=blue)](https://github.com/ProfRino/fds-viewer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A browser-based 3D **viewer** for **Fire Dynamics Simulator (FDS)** input
files and simulation outputs. Drop in any `.fds` file to inspect meshes,
obstructions, vents, holes, devices, slice planes, fire sources and HVAC
networks **before** launching a multi-hour FDS run -- then open the
simulation folder afterwards to play back smoke (`.s3d`), slice (`.sf`)
and boundary (`.bf`) results — or compute exit-sign **visibility maps**
from them — without leaving the browser.

![FDS Viewer demo](assets/demo2_full_2x.gif)

> **Project Lead:** Prof Rino Lovreglio, PhD - Massey University
>
> **Disclaimer:** No responsibility is taken for the use or output of this tool.
> All results must be independently verified by a qualified fire engineer
> before use in any design or regulatory context.

---

## Features

Pure client-side — no installation, no build step, no backend.

### FDS Input

Parses FDS namelist input (`&MESH`, `&OBST`, `&VENT`, `&HOLE`, `&DEVC`, `&INIT`, `&GEOM`, `&HVAC`, `&ZONE`, `&SLCF`, `&SURF`, `&REAC`, `&MATL`, ...) across four pre-run pages:

- **3D Geometry** — interactive Three.js scene with layer toggles, opacity, canonical views and click-to-inspect
- **Mesh** — resolution, cell count, parallel-MPI breakdown
- **Fire & Combustion** — burner HRR, reaction chemistry, materials
- **Code** — full `.fds` source with syntax highlighting and an in-browser linter catching 50+ rule violations

Plus a multi-page **Help / User Guide** with parameter equations and worked examples.

**Navigation.** Standard orbit controls plus first-person **Walk mode** (W A S D, mouse-look, Shift run, Space jump, Esc exit) and an **orthographic / perspective** toggle in each 3D view. Per-axis clipping that doesn't cull edge geometry.


### FDS Output

Point the **Output** page at a simulation folder once — the viewer auto-detects and plays back all post-run data on the same 3D scene:

- **Smoke** (`.s3d`) — WebGL2 volume rendering with Basic and Solid-aware (depth-sampled) modes; user-tunable transfer functions for soot and HRRPUV
- **Slices** (`.sf`) — multi-mesh stitching with shared colormap
- **Boundary patches** (`.bf`) — per-frame auto-range colorbar
- **Visibility maps** — exit-sign visibility computed from extinction-coefficient slices — see [Visibility maps (Vismap)](#visibility-maps-vismap) below

The Output page also accepts a JuPedSim `.sqlite` to overlay evacuation agents on the same scene — see [JuPedSim Output](#jupedsim-output) below.

**Navigation.** Standard orbit controls plus first-person **Walk mode** (W A S D, mouse-look, Shift run, Space jump, Esc exit) and an **orthographic / perspective** toggle in each 3D view. Per-axis clipping that doesn't cull edge geometry.

### Visibility maps (Vismap)

The Output page **Vismap** mode computes the visibility of escape-route
signage over time, following the waypoint-based method of
[Börger, Belt & Arnold (2024)](https://doi.org/10.1016/j.firesaf.2024.104269)
and its Python reference implementation
[fdsvismap](https://github.com/FireDynamics/fdsvismap) — no scripting required:

- **Input** — a `SOOT EXTINCTION COEFFICIENT` (or `SOOT OPTICAL DENSITY`) slice from the simulation folder
- **Waypoints** — exit signs placed via form or by clicking in the 3D view, each with position, orientation angle α and contrast factor C (Jin's visibility model)
- **Sight lines** — each map position is checked against each sign along a straight line of sight: walls from the FDS geometry block the view, the smoke along the line reduces the visible distance (mean extinction coefficient, per Jin), and a sign only counts as visible from the side it faces (view-angle weighting by α). Additional visual obstructions (e.g. curtains) or see-through openings (e.g. windows) can be defined and are shown in the scene
- **Results** — three map views rendered on the evaluation plane: sign visible / not visible at a selected time (with playback, side by side with the smoke), aggregated over all times, and an **ASET map** showing the first time each position loses sight of any sign

> The visibility computation is a port of fdsvismap; results should be
> independently verified before use in any design or regulatory context.

### JuPedSim Output

In the Output page **Soot** section, load a JuPedSim `.sqlite` (Agents panel) to overlay evacuation agents on the smoke:

- **Speed** colouring by default; **FED dose** when the file carries an `agent_scalars` table (written by [pyFDS-Evac](https://github.com/PedestrianDynamics/pyFDS-Evac) with `--output-sqlite` — the table is written when FED is computed)
- Time-synced to the smoke — both always show the same simulation second
- Any JuPedSim trajectory `.sqlite` works unchanged — without `agent_scalars`, agents are coloured by a speed derived from successive positions

## Download

Download the [latest release zip](https://github.com/ProfRino/fds-viewer/releases/latest) - a clean zip with no git history (recommended). All releases with per-version download counts are listed at <https://github.com/ProfRino/fds-viewer/releases>. To follow development: `git clone https://github.com/ProfRino/fds-viewer.git`

> Listed on the official [FDS Third-Party Tools wiki](https://github.com/firemodels/fds/wiki/Third-Party-Tools) - maintained by the FDS development community (firemodels/fds, NIST).

## Quick start

### Option A - Just open the file (no server, any OS)

1. Download the [latest release zip](https://github.com/ProfRino/fds-viewer/releases/latest) and unzip it (or clone the repo).
2. Double-click **`index.html`** - it opens in your default browser.
3. Click **Load Sample**, drop any `.fds` file on the page, or use **Open File**. Done.

The bundled sample is embedded directly in the page, so it works offline
straight from `file://`. The only network call is to the Three.js CDN
(first load only - caches afterwards).

### Option B - Online (GitHub Pages)

Use the live URL - no download needed, handy for sharing with colleagues:
**[https://profrino.github.io/fds-viewer/](https://profrino.github.io/fds-viewer/)**

You can also auto-load a bundled example via the `?file=` parameter:
**[https://profrino.github.io/fds-viewer/?file=examples/sample_room_fire.fds](https://profrino.github.io/fds-viewer/?file=examples/sample_room_fire.fds)**

### Option C - Local server (only needed for `?file=` URL params)

The `?file=` URL parameter uses `fetch()`, which browsers block on `file://` URLs.
If you want to use that feature locally, run the included server:
on **Windows** double-click `serve.bat` (requires Python 3 on `PATH`), or on any OS run
`python -m http.server 8765` from the repo root and open <http://localhost:8765/>.

For normal use (drag-drop, Open File, Load Sample) you do **not** need this - Option A is enough.

## URL parameters

| Parameter | Effect |
|-----------|--------|
| `?file=<path>` | Auto-load a `.fds` file at server-relative `<path>`. Requires GitHub Pages or a local server (Option B or C). Example: `?file=examples/sample_room_fire.fds` |

## Bundled examples

`examples/` contains nine `.fds` files demonstrating different FDS feature
sets (geometry primitives, terrain, extruded polygons, HVAC, fans, sphere
intersections, and a sample room-fire scenario). They are convenient sanity
inputs for the viewer - they are **not** intended as validated design fires.

## Repository layout

```
.
├── index.html          Application shell
├── css/style.css       Styles (light & dark themes)
├── js/                 Parser, linter, 3D viewer, Output overlays
│   ├── app.js              Wiring, event handling, theme, URL params
│   ├── fds-parser.js       Namelist parser
│   ├── fds-linter.js       50+ rule static validator
│   ├── viewer.js           Three.js scene, walk mode, clipping
│   ├── mesh-panel.js       Mesh / parallel panel
│   ├── fire-panel.js       Fire & combustion panel
│   ├── output-page.js      Output page wiring (smoke / slice / BNDF)
│   ├── smoke3d-*.js        .s3d reader + WebGL2 volume overlay
│   ├── slice-*.js          .sf reader + multi-mesh slice overlay
│   ├── boundary-*.js       .bf reader + boundary patch overlay
│   ├── vismap.js           Visibility map engine + overlay (fdsvismap port)
│   └── sample-data.js      Embedded sample (for offline Load Sample)
├── examples/*.fds      Sample inputs (also editable on disk)
├── assets/             Demo GIFs used by this README
├── serve.bat           Optional local server (only for ?file= URL params)
└── README.md
```

## Dependencies

Three.js r128 is loaded from a public CDN - there is no package manager and
no node_modules. To work fully offline, download `three.min.js` and
`OrbitControls.js` and replace the two `<script src="https://...">` lines near
the bottom of `index.html` with local paths.

## License

MIT - see [LICENSE](LICENSE).

## Recognition

Listed on the official [FDS Third-Party Tools wiki](https://github.com/firemodels/fds/wiki/Third-Party-Tools) maintained by the FDS development community (firemodels/fds, NIST).

## Citation

If you use this tool in published work, please cite:

> Lovreglio, R. *FDS Viewer*. Massey University.
> https://github.com/ProfRino/fds-viewer

If you use the visibility maps, please also cite the underlying method:

> Börger, K., Belt, A., Arnold, L. (2024). *A waypoint based approach to
> visibility in performance based fire safety design*. Fire Safety Journal.
> https://doi.org/10.1016/j.firesaf.2024.104269
