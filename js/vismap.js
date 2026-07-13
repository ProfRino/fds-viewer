/**
 * Visibility maps (Vismap) for the Output page.
 *
 * Pure-JS port of FireDynamics/fdsvismap: computes from which floor positions
 * an escape-route sign (waypoint) is visible, based on FDS soot extinction
 * coefficient slices and Jin's visibility model V = C / K̄ along sight lines.
 *
 * Exposes (on window):
 *   VisMapEngine   — grid math, no THREE/DOM (unit-testable in node)
 *   VisMapOverlay  — THREE objects: map plane, evacuation signs, route line
 *
 * FDS-to-Three coordinate convention matches slice-renderer.js:
 *   FDS X -> Three X,  FDS Z -> Three Y (up),  FDS Y -> Three Z
 */

(function (global) {
    'use strict';

    const LN10 = Math.log(10);

    function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

    function closestIndex(coords, value) {
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < coords.length; i++) {
            const d = Math.abs(coords[i] - value);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        return best;
    }

    /** Integer Bresenham line, endpoints inclusive (skimage.draw.line semantics).
     *  Returns flat cell indices (i + nx*j) in traversal order from p0 to p1. */
    function bresenhamIndices(i0, j0, i1, j1, nx) {
        const di = Math.abs(i1 - i0), dj = Math.abs(j1 - j0);
        const si = i0 < i1 ? 1 : -1, sj = j0 < j1 ? 1 : -1;
        const out = new Int32Array(Math.max(di, dj) + 1);
        let err = di - dj, i = i0, j = j0;
        for (let n = 0; n < out.length; n++) {
            out[n] = i + nx * j;
            const e2 = 2 * err;
            if (e2 > -dj) { err -= dj; i += si; }
            if (e2 < di) { err += di; j += sj; }
        }
        return out;
    }

    // ── Engine ────────────────────────────────────────────────────────────
    class VisMapEngine {
        /**
         * @param {object} opts
         * @param {object} opts.dataset  slice dataset (frames + getFrameData), stitched or single mesh
         * @param {Float64Array|number[]} opts.xCoords  cell x coordinates, length dims[0]
         * @param {Float64Array|number[]} opts.yCoords  cell y coordinates, length dims[1]
         * @param {number} [opts.height=2] evaluation height z (m), used for obstruction filtering
         */
        constructor(opts) {
            this.dataset = opts.dataset;
            this.xCoords = Array.from(opts.xCoords);
            this.yCoords = Array.from(opts.yCoords);
            this.nx = this.xCoords.length;
            this.ny = this.yCoords.length;
            this.height = Number.isFinite(opts.height) ? opts.height : 2.0;
            this.cellSize = [
                this.nx > 1 ? (this.xCoords[this.nx - 1] - this.xCoords[0]) / (this.nx - 1) : 1,
                this.ny > 1 ? (this.yCoords[this.ny - 1] - this.yCoords[0]) / (this.ny - 1) : 1,
            ];
            // OD slices are converted to extinction coefficient with K = OD·ln10
            const q = String(this.dataset.quantity || '').toUpperCase();
            this.isOpticalDensity = q.includes('OPTICAL DENSITY') || q.startsWith('OD');

            this.obstructions = new Uint8Array(this.nx * this.ny); // 1 = blocked
            this.waypoints = new Map();  // id -> {x, y, c, alpha (deg or null)}
            this.startPoint = null;      // {x, y} — drawn only, not computed
            this.timePoints = [];
            this.minVis = 0;
            this.maxVis = 30;

            this._wpCache = new Map();   // id -> {nonConcealed, viewAngle, distance, rays}
            this._wpAggByTime = [];      // Uint8Array per computed time point
            this._computedTimes = [];
        }

        setWaypoint(id, x, y, c, alpha) {
            this.waypoints.set(id, {
                x, y,
                c: Number.isFinite(c) ? c : 3,
                alpha: Number.isFinite(alpha) ? alpha : null,
            });
            this._invalidate();
        }

        removeWaypoint(id) { this.waypoints.delete(id); this._invalidate(); }
        setStartPoint(x, y) { this.startPoint = { x, y }; }
        setTimePoints(times) { this.timePoints = Array.from(times); this._invalidate(); }
        setVisibilityBounds(minVis, maxVis) { this.minVis = minVis; this.maxVis = maxVis; this._invalidate(); }

        _invalidate() { this._wpCache.clear(); this._wpAggByTime = []; this._computedTimes = []; }

        /** Mark cells blocked by parsed-FDS obstructions whose z-range spans the
         *  evaluation height. `obsts` = parsedData.obsts ({xb: [x1,x2,y1,y2,z1,z2]}). */
        setObstructionsFromFds(obsts) {
            this.obstructions.fill(0);
            for (const obst of obsts || []) {
                const xb = obst.xb;
                if (!xb || xb.length < 6) continue;
                if (xb[4] <= this.height && this.height <= xb[5]) {
                    this._paintRect(xb[0], xb[1], xb[2], xb[3], 1);
                }
            }
        }

        addVisualObstruction(x1, x2, y1, y2) { this._paintRect(x1, x2, y1, y2, 1); }
        addVisualHole(x1, x2, y1, y2) { this._paintRect(x1, x2, y1, y2, 0); }

        // fdsvismap's _add_visual_object: half-cell inset so touching-but-not-
        // covering obstructions don't claim an extra cell row.
        _paintRect(x1, x2, y1, y2, value) {
            const i1 = closestIndex(this.xCoords, x1 + this.cellSize[0] / 2);
            const i2 = closestIndex(this.xCoords, x2 - this.cellSize[0] / 2) + 1;
            const j1 = closestIndex(this.yCoords, y1 + this.cellSize[1] / 2);
            const j2 = closestIndex(this.yCoords, y2 - this.cellSize[1] / 2) + 1;
            for (let j = j1; j < j2; j++)
                for (let i = i1; i < i2; i++)
                    this.obstructions[i + this.nx * j] = value;
        }

        /** Extinction coefficient field at the slice frame nearest to `time`. */
        getExtcoAtTime(time) {
            const frames = this.dataset.frames;
            let best = 0, bestDist = Infinity;
            for (let f = 0; f < frames.length; f++) {
                const d = Math.abs(frames[f].time - time);
                if (d < bestDist) { bestDist = d; best = f; }
            }
            const values = this.dataset.getFrameData(best);
            if (!this.isOpticalDensity) return values;
            const out = new Float32Array(values.length);
            for (let i = 0; i < values.length; i++) out[i] = values[i] * LN10;
            return out;
        }

        /** Cells with a line of sight to the waypoint (not blocked by obstructions):
         *  Bresenham rays from the waypoint cell to every domain edge cell; cells
         *  along a ray before the first obstruction are visible. */
        _nonConcealedCells(wp) {
            const { nx, ny } = this;
            const out = new Uint8Array(nx * ny);
            const wi = closestIndex(this.xCoords, wp.x);
            const wj = closestIndex(this.yCoords, wp.y);
            const castTo = (ei, ej) => {
                const path = bresenhamIndices(wi, wj, ei, ej, nx);
                for (let n = 0; n < path.length; n++) {
                    if (this.obstructions[path[n]]) break;
                    out[path[n]] = 1;
                }
            };
            for (let i = 0; i < nx; i++) { castTo(i, 0); castTo(i, ny - 1); }
            for (let j = 1; j < ny - 1; j++) { castTo(0, j); castTo(nx - 1, j); }
            return out;
        }

        /** Per-waypoint invariants: concealment, distances, view-angle factor and
         *  cached sight-line paths for every visible cell. */
        _buildWaypointCache(id, options) {
            const wp = this.waypoints.get(id);
            const { nx, ny } = this;
            const cellCount = nx * ny;

            const nonConcealed = options.obstructions
                ? this._nonConcealedCells(wp)
                : new Uint8Array(cellCount).fill(1);

            const distance = new Float32Array(cellCount);
            const viewAngle = new Float32Array(cellCount);
            const useAngle = options.viewAngle && wp.alpha !== null;
            const sinA = useAngle ? Math.sin(wp.alpha * Math.PI / 180) : 0;
            const cosA = useAngle ? Math.cos(wp.alpha * Math.PI / 180) : 0;
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const dx = this.xCoords[i] - wp.x;
                    const dy = this.yCoords[j] - wp.y;
                    const dist = Math.hypot(dx, dy);
                    const idx = i + nx * j;
                    distance[idx] = dist;
                    viewAngle[idx] = useAngle
                        ? (dist > 0 ? clamp((sinA * dx + cosA * dy) / dist, 0, 1) : 0)
                        : 1;
                }
            }

            const wi = closestIndex(this.xCoords, wp.x);
            const wj = closestIndex(this.yCoords, wp.y);
            const rays = [];       // Int32Array path per visible cell
            const rayTargets = []; // flat index of the cell each ray belongs to
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const idx = i + nx * j;
                    if (!nonConcealed[idx]) continue;
                    rays.push(bresenhamIndices(wi, wj, i, j, nx));
                    rayTargets.push(idx);
                }
            }

            const cache = { wp, nonConcealed, distance, viewAngle, rays, rayTargets };
            this._wpCache.set(id, cache);
            return cache;
        }

        /** Boolean vismap for one waypoint at one time. */
        _vismapForWaypoint(cache, extco) {
            const out = new Uint8Array(this.nx * this.ny);
            const { wp, distance, viewAngle, rays, rayTargets } = cache;
            for (let r = 0; r < rays.length; r++) {
                const path = rays[r];
                let sum = 0;
                for (let n = 0; n < path.length; n++) sum += extco[path[n]];
                const meanExtco = sum / path.length;
                const vis = meanExtco > 0 ? Math.min(wp.c / meanExtco, this.maxVis) : this.maxVis;
                const idx = rayTargets[r];
                const total = viewAngle[idx] * vis;
                out[idx] = (total >= distance[idx] && total >= this.minVis) ? 1 : 0;
            }
            return out;
        }

        /**
         * Compute waypoint-aggregated vismaps for every configured time point.
         * @param {object} [options] {viewAngle=true, obstructions=true, onProgress}
         * `onProgress(done, total)` is called after each time point.
         */
        async computeAll(options) {
            const opts = Object.assign({ viewAngle: true, obstructions: true }, options);
            if (this.waypoints.size === 0) throw new Error('Add at least one waypoint before computing.');
            if (this.timePoints.length === 0) throw new Error('Set time points before computing.');

            this._wpCache.clear();
            for (const id of this.waypoints.keys()) this._buildWaypointCache(id, opts);

            this._wpAggByTime = [];
            this._computedTimes = [];
            for (let t = 0; t < this.timePoints.length; t++) {
                const time = this.timePoints[t];
                const extco = this.getExtcoAtTime(time);
                let agg = null;
                for (const cache of this._wpCache.values()) {
                    const map = this._vismapForWaypoint(cache, extco);
                    if (!agg) { agg = map; continue; }
                    for (let i = 0; i < agg.length; i++) agg[i] |= map[i];
                }
                this._wpAggByTime.push(agg);
                this._computedTimes.push(time);
                if (typeof opts.onProgress === 'function') opts.onProgress(t + 1, this.timePoints.length);
                // Keep the UI responsive during longer computations.
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        get computedTimes() { return this._computedTimes.slice(); }

        _timeIndex(time) {
            if (this._computedTimes.length === 0) throw new Error('Run computeAll() first.');
            let best = 0, bestDist = Infinity;
            for (let t = 0; t < this._computedTimes.length; t++) {
                const d = Math.abs(this._computedTimes[t] - time);
                if (d < bestDist) { bestDist = d; best = t; }
            }
            return best;
        }

        /** OR over waypoints at the computed time nearest to `time` (Uint8Array). */
        getWpAggVismap(time) { return this._wpAggByTime[this._timeIndex(time)]; }

        /** AND over all computed times up to tMax (Uint8Array). */
        getTimeAggVismap(tMax) {
            if (this._wpAggByTime.length === 0) throw new Error('Run computeAll() first.');
            const out = new Uint8Array(this.nx * this.ny).fill(1);
            for (let t = 0; t < this._computedTimes.length; t++) {
                if (Number.isFinite(tMax) && this._computedTimes[t] > tMax) break;
                const map = this._wpAggByTime[t];
                for (let i = 0; i < out.length; i++) out[i] &= map[i];
            }
            return out;
        }

        /** First computed time at which each cell loses sight of every waypoint;
         *  cells that never lose visibility hold maxTime (Float32Array). */
        getAsetMap(maxTime) {
            if (this._wpAggByTime.length === 0) throw new Error('Run computeAll() first.');
            const tEnd = Number.isFinite(maxTime) ? maxTime : this._computedTimes[this._computedTimes.length - 1];
            const out = new Float32Array(this.nx * this.ny).fill(tEnd);
            const settled = new Uint8Array(out.length); // explicit — an ASET value may equal tEnd
            for (let t = 0; t < this._computedTimes.length; t++) {
                const time = this._computedTimes[t];
                if (time > tEnd) break;
                const map = this._wpAggByTime[t];
                for (let i = 0; i < out.length; i++) {
                    if (!settled[i] && !map[i]) { out[i] = time; settled[i] = 1; }
                }
            }
            return out;
        }

        /** Is waypoint `id` visible from the cell nearest (x, y) at `time`? */
        wpIsVisible(time, x, y, id) {
            const cache = this._wpCache.get(id);
            if (!cache) throw new Error('Run computeAll() first.');
            const extco = this.getExtcoAtTime(this._computedTimes[this._timeIndex(time)]);
            const map = this._vismapForWaypoint(cache, extco);
            return !!map[closestIndex(this.xCoords, x) + this.nx * closestIndex(this.yCoords, y)];
        }

        /** Local visibility C/K at the cell nearest (x, y). */
        getLocalVisibility(time, x, y, c) {
            const extco = this.getExtcoAtTime(time);
            const k = extco[closestIndex(this.xCoords, x) + this.nx * closestIndex(this.yCoords, y)];
            return k > 0 ? Math.min(c / k, this.maxVis) : this.maxVis;
        }
    }

    // ── Overlay ───────────────────────────────────────────────────────────
    function fdsToScene(x, y, z) { return new THREE.Vector3(x, z, y); }

    // jet-reversed color map for the ASET plane (t=0 → red … t=max → blue)
    function jetReversed(t) {
        const u = 1 - clamp(t, 0, 1);
        const r = clamp(1.5 - Math.abs(4 * u - 3), 0, 1);
        const g = clamp(1.5 - Math.abs(4 * u - 2), 0, 1);
        const b = clamp(1.5 - Math.abs(4 * u - 1), 0, 1);
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }

    // ISO 7010 E002 "Emergency exit (right)" pictogram — running man and door.
    // Path taken verbatim from the public-domain Wikimedia Commons file
    // ISO_7010_E002.svg (viewBox 0…105.833 after the group offset below).
    const ISO_E002_PATH = 'm 88.897663,80.709657 v 60.715533 c -6.316373,0.48241 -10.5308,5.63536 -10.5308,10.31517 v 2.4687 l 2.468698,-0.006 8.062102,-0.0182 v 12.73893 l -6.082136,5.9854 h 40.129013 l 7.43227,-7.11934 h 9.2387 l -7.43284,7.11934 h 11.45592 l 6.08214,-5.98542 V 125.1738 h -10.66451 c -0.0833,5.9e-4 -0.16247,0.004 -0.24579,0.004 -0.0556,0 -0.0832,-0.007 -0.13598,-0.008 -0.0349,-5.8e-4 -0.0686,-0.002 -0.10294,-0.004 -1.43847,-0.0274 -1.75019,-0.28172 -2.77878,-1.31031 l -6.24145,-7.37766 c -1.73064,3.78552 -3.36138,7.00437 -5.08475,10.65995 -0.19459,0.37374 -0.65441,1.21334 -0.30951,1.86731 l 17.15286,34.63575 -6.29263,-0.021 c -3.29001,0.0726 -4.66137,-2.19803 -5.81814,-4.23075 -4.63991,-9.35178 -9.30161,-18.69659 -13.94909,-28.04895 l -0.87733,16.64253 c -0.22955,2.88042 -2.17565,3.61243 -4.72575,3.69137 l -28.817027,0.0659 c 0,-3.31243 3.281927,-7.68712 8.626505,-7.89482 0,0 10.292026,0.11556 15.673012,0.13711 0.68225,0 0.86922,-0.38098 0.94846,-0.94845 0.24993,-4.28189 0.48763,-8.59103 0.7533,-12.87205 0.16632,-2.12536 0.3528,-3.59821 0.96949,-5.20708 2.0106,-4.31016 4.02228,-8.59953 6.03491,-12.89424 l -7.36399,-0.0859 c -0.19342,-0.007 -0.34356,0.0358 -0.44435,0.20823 l -5.32998,9.33771 c -2.198192,4.00865 -8.138332,1.08508 -6.148138,-3.16681 l 6.536168,-10.93249 c 1.14949,-1.70937 1.6747,-2.29896 4.66145,-2.39188 0,0 13.95626,-0.0222 20.94497,-0.0222 v -5.8e-4 c 2.27014,-0.0504 2.52919,0.66163 3.61401,1.81782 2.91625,3.5982 6.10478,7.43502 8.94966,10.7891 0.3953,0.47396 0.61745,0.67583 1.55836,0.66796 1.74231,-0.0292 3.27034,0.002 4.6188,0.0808 h 4.28821 V 80.709277 Z m 38.649157,8.33748 c 4.00109,0 7.06757,3.07482 7.06757,7.09658 0,4.029633 -3.06678,7.103983 -7.06757,7.103983 -4.00049,0 -7.07496,-3.07435 -7.07496,-7.103983 0,-4.02205 3.07447,-7.09658 7.07496,-7.09658 z';
    const ISO_E002_OFFSET = [-65.616667, -71.966666];
    const ISO_E002_SIZE = 105.833333;
    const ISO_GREEN = '#237f52';

    /**
     * Canvas texture of a rectangular evacuation sign (2:1): the genuine
     * ISO 7010 E002 pictogram (running man + door) in the left square and an
     * equally sized direction arrow in the right square, so the arrow always
     * leads the way the sign faces. Small waypoint id badge top-left.
     */
    function drawEvacuationSign(id) {
        const panel = 256;
        const canvas = document.createElement('canvas');
        canvas.width = panel * 2;
        canvas.height = panel;
        const ctx = canvas.getContext('2d');

        // White rim + green face, proportions like the ISO sign (rim = 2.5 %)
        const rim = panel * 0.025;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = ISO_GREEN;
        ctx.fillRect(rim, rim, canvas.width - 2 * rim, canvas.height - 2 * rim);

        // Left square: E002 pictogram at its authentic position in the panel
        ctx.save();
        ctx.scale(panel / ISO_E002_SIZE, panel / ISO_E002_SIZE);
        ctx.translate(ISO_E002_OFFSET[0], ISO_E002_OFFSET[1]);
        ctx.fillStyle = '#ffffff';
        ctx.fill(new Path2D(ISO_E002_PATH));
        ctx.restore();

        // Right square: block arrow pointing up (12 o'clock), sized like the
        // pictogram square.
        ctx.save();
        ctx.translate(panel, 0);
        const u = panel / 100;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(38 * u, 86 * u);
        ctx.lineTo(38 * u, 46 * u);
        ctx.lineTo(20 * u, 46 * u);
        ctx.lineTo(50 * u, 12 * u);
        ctx.lineTo(80 * u, 46 * u);
        ctx.lineTo(62 * u, 46 * u);
        ctx.lineTo(62 * u, 86 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Waypoint id badge (top-left corner)
        const b = panel / 100;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(rim, rim, 15 * b, 13 * b);
        ctx.fillStyle = ISO_GREEN;
        ctx.font = 'bold ' + 10 * b + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(id), rim + 7.5 * b, rim + 6.5 * b);

        return canvas;
    }

    class VisMapOverlay {
        constructor(scene) {
            this.scene = scene;
            this.engine = null;
            this.mapMesh = null;
            this.signMeshes = [];
            this.routeLine = null;
            this.startMarker = null;
            this.regionMeshes = [];
            this.opacity = 0.7;
            this.visible = true;
            // Signs lie flat on the map plane for the top-down/orbit view;
            // in walk mode they stand upright like real exit signs.
            this.signsUpright = false;
        }

        setEngine(engine) { this.engine = engine; }

        /** Upright signs (walk mode) vs flat floor markers (orbit view). */
        setSignsUpright(upright) {
            if (this.signsUpright === !!upright) return;
            this.signsUpright = !!upright;
            this.updateMarkers();
        }

        _regionLayerOn() {
            return !this.scene.userData || this.scene.userData.vismapRegionsVisible !== false;
        }

        setVisible(visible) {
            this.visible = visible;
            if (this.mapMesh) this.mapMesh.visible = visible;
            for (const m of this.signMeshes) m.visible = visible;
            for (const m of this.regionMeshes) {
                m._vismapModeVisible = visible;
                m.visible = visible && this._regionLayerOn();
            }
            if (this.routeLine) this.routeLine.visible = visible;
            if (this.startMarker) this.startMarker.visible = visible;
        }

        dispose() {
            this._disposeMap();
            this._disposeMarkers();
            this._disposeRegions();
            this.engine = null;
        }

        _disposeMap() {
            if (!this.mapMesh) return;
            if (this.mapMesh.material.map) this.mapMesh.material.map.dispose();
            this.mapMesh.geometry.dispose();
            this.mapMesh.material.dispose();
            this.scene.remove(this.mapMesh);
            this.mapMesh = null;
        }

        _disposeMarkers() {
            for (const m of this.signMeshes) {
                if (m.material.map) m.material.map.dispose();
                m.geometry && m.geometry.dispose();
                m.material.dispose();
                this.scene.remove(m);
            }
            this.signMeshes = [];
            if (this.routeLine) {
                this.routeLine.geometry.dispose();
                this.routeLine.material.dispose();
                this.scene.remove(this.routeLine);
                this.routeLine = null;
            }
            if (this.startMarker) {
                this.startMarker.geometry.dispose();
                this.startMarker.material.dispose();
                this.scene.remove(this.startMarker);
                this.startMarker = null;
            }
        }

        /**
         * Render a map onto the plane at the engine's evaluation height.
         * @param {'time'|'aggregated'|'aset'} mode
         * @param {number} [time]  time for 'time' mode / tMax otherwise
         * @returns {object|null} legend info for the caller's colorbar
         */
        showMap(mode, time) {
            if (!this.engine) return null;
            const e = this.engine;
            let legend;
            const canvas = document.createElement('canvas');
            canvas.width = e.nx;
            canvas.height = e.ny;
            const ctx = canvas.getContext('2d');
            const image = ctx.createImageData(e.nx, e.ny);

            const paint = (idx, rgb, a) => {
                const dst = 4 * idx;
                image.data[dst] = rgb[0];
                image.data[dst + 1] = rgb[1];
                image.data[dst + 2] = rgb[2];
                image.data[dst + 3] = a;
            };

            if (mode === 'aset') {
                const aset = e.getAsetMap(time);
                const times = e.computedTimes;
                const t0 = times[0];
                const tEnd = Number.isFinite(time) ? time : times[times.length - 1];
                const span = (tEnd - t0) || 1; // colors span the evaluated range
                for (let j = 0; j < e.ny; j++) {
                    const srcJ = e.ny - 1 - j; // canvas rows top-down, grid rows bottom-up
                    for (let i = 0; i < e.nx; i++) {
                        paint(i + e.nx * j, jetReversed((aset[i + e.nx * srcJ] - t0) / span), 235);
                    }
                }
                legend = { mode, min: t0, max: tEnd, label: 'first time not visible / s' };
            } else {
                const map = mode === 'aggregated' ? e.getTimeAggVismap(time) : e.getWpAggVismap(time);
                const green = [46, 204, 64], red = [220, 53, 47];
                for (let j = 0; j < e.ny; j++) {
                    const srcJ = e.ny - 1 - j;
                    for (let i = 0; i < e.nx; i++) {
                        paint(i + e.nx * j, map[i + e.nx * srcJ] ? green : red, 235);
                    }
                }
                legend = { mode, label: mode === 'aggregated' ? 'visible at all times' : 'visible' };
            }

            // Obstructed cells shown neutral gray so walls read as walls.
            for (let j = 0; j < e.ny; j++) {
                const srcJ = e.ny - 1 - j;
                for (let i = 0; i < e.nx; i++) {
                    if (e.obstructions[i + e.nx * srcJ]) paint(i + e.nx * j, [90, 95, 102], 235);
                }
            }
            ctx.putImageData(image, 0, 0);

            if (!this.mapMesh) this._buildMapMesh();
            const tex = new THREE.CanvasTexture(canvas);
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.NearestFilter;
            tex.flipY = false;
            const prev = this.mapMesh.material.map;
            this.mapMesh.material.map = tex;
            this.mapMesh.material.needsUpdate = true;
            if (prev) prev.dispose();
            this.mapMesh.visible = this.visible;
            return legend;
        }

        _buildMapMesh() {
            const e = this.engine;
            // The map values live on the grid points, but a texture spreads
            // its nx texels evenly across the plane — so the plane must extend
            // half a cell beyond the outermost grid points for texel centers
            // to land exactly on them. Without this, everything painted on the
            // map (e.g. gray obstructed cells) shifts by up to half a cell
            // against the 3D geometry and walls look thicker than they are.
            const hx = e.cellSize[0] / 2, hy = e.cellSize[1] / 2;
            const x0 = e.xCoords[0] - hx, x1 = e.xCoords[e.nx - 1] + hx;
            const y0 = e.yCoords[0] - hy, y1 = e.yCoords[e.ny - 1] + hy;
            const z = e.height;
            const corners = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
            const positions = [];
            for (const c of corners) {
                const v = fdsToScene(c[0], c[1], c[2]);
                positions.push(v.x, v.y, v.z);
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
            geometry.setIndex([0, 1, 2, 0, 2, 3]);
            geometry.computeVertexNormals();
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: this.opacity,
                side: THREE.DoubleSide, depthWrite: false, depthTest: false,
            });
            this.mapMesh = new THREE.Mesh(geometry, material);
            this.mapMesh.renderOrder = 90;
            this.mapMesh._isSliceOverlay = true; // viewer.setGrayscale skips it
            this.scene.add(this.mapMesh);
        }

        /** (Re)build waypoint signs, start marker and dashed route line. */
        updateMarkers() {
            this._disposeMarkers();
            if (!this.engine) return;
            const e = this.engine;
            // Rectangular sign, 2:1 like the drawn texture (pictogram + arrow)
            const signW = 0.9, signH = 0.45;

            const ordered = Array.from(e.waypoints.entries()).sort((a, b) => a[0] - b[0]);
            for (const [id, wp] of ordered) {
                const texture = new THREE.CanvasTexture(drawEvacuationSign(id));
                let mesh;
                if (this.signsUpright && wp.alpha === null) {
                    // Upright without orientation: camera-facing billboard.
                    mesh = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
                    mesh.scale.set(signW, signH, 1);
                    mesh.position.copy(fdsToScene(wp.x, wp.y, e.height));
                } else {
                    const material = new THREE.MeshBasicMaterial({
                        map: texture, side: THREE.DoubleSide, transparent: true, depthTest: false,
                    });
                    mesh = new THREE.Mesh(new THREE.PlaneGeometry(signW, signH), material);
                    if (this.signsUpright) {
                        // Plane's default normal is scene +Z (= FDS +Y = alpha 0);
                        // rotating around the vertical axis by alpha makes the
                        // face normal point along (sin α, cos α) in FDS
                        // coordinates — the direction the view-angle factor
                        // favours.
                        mesh.rotation.y = wp.alpha * Math.PI / 180;
                        mesh.position.copy(fdsToScene(wp.x, wp.y, e.height));
                    } else {
                        // Flat floor marker, readable from above, centered on
                        // the waypoint. The arrow shows the escape direction:
                        // opposite the sign's facing normal (sin α, cos α), so
                        // the visibility lobe lies on the approach side behind
                        // the arrow — you see the sign while walking towards
                        // it, then continue in the arrow's direction.
                        mesh.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
                        if (wp.alpha !== null) {
                            mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), wp.alpha * Math.PI / 180);
                        }
                        const pos = fdsToScene(wp.x, wp.y, e.height);
                        pos.y += 0.02; // float just above the map plane
                        mesh.position.copy(pos);
                    }
                }
                mesh.renderOrder = 120;
                mesh._isSliceOverlay = true;
                mesh.visible = this.visible;
                this.scene.add(mesh);
                this.signMeshes.push(mesh);
            }

            // Route: start point → waypoints in id order (dashed, like fdsvismap's plot)
            const routePoints = [];
            if (e.startPoint) routePoints.push(fdsToScene(e.startPoint.x, e.startPoint.y, e.height));
            for (const [, wp] of ordered) routePoints.push(fdsToScene(wp.x, wp.y, e.height));
            if (routePoints.length >= 2) {
                const geometry = new THREE.BufferGeometry().setFromPoints(routePoints);
                const material = new THREE.LineDashedMaterial({
                    color: 0x0a7a2f, dashSize: 0.25, gapSize: 0.15, depthTest: false,
                });
                this.routeLine = new THREE.Line(geometry, material);
                this.routeLine.computeLineDistances();
                this.routeLine.renderOrder = 110;
                this.routeLine._isSliceOverlay = true;
                this.routeLine.visible = this.visible;
                this.scene.add(this.routeLine);
            }
            if (e.startPoint) {
                const geometry = new THREE.SphereGeometry(0.12, 12, 12);
                const material = new THREE.MeshBasicMaterial({ color: 0x0a7a2f, depthTest: false });
                this.startMarker = new THREE.Mesh(geometry, material);
                this.startMarker.position.copy(fdsToScene(e.startPoint.x, e.startPoint.y, e.height));
                this.startMarker.renderOrder = 110;
                this.startMarker._isSliceOverlay = true;
                this.startMarker.visible = this.visible;
                this.scene.add(this.startMarker);
            }
        }

        _disposeRegions() {
            for (const m of this.regionMeshes) {
                m.geometry.dispose();
                m.material.dispose();
                this.scene.remove(m);
            }
            this.regionMeshes = [];
        }

        /** Show manual visual obstruction / hole rectangles as 3D markers:
         *  obstructions as gray boxes rising from the floor to the evaluation
         *  height, holes as cyan outline slabs around it. Toggleable via the
         *  "Visual obst." layer checkbox (viewer layer 'vismapRegions').
         *  `regions` is [{type: 'obstruction'|'hole', x1, x2, y1, y2}] in FDS
         *  coordinates. */
        updateRegions(regions) {
            this._disposeRegions();
            const height = this.engine ? this.engine.height : 2;
            for (const r of regions || []) {
                const w = Math.abs(r.x2 - r.x1);
                const d = Math.abs(r.y2 - r.y1);
                if (!(w > 0) || !(d > 0)) continue;
                // Scene axes: x = FDS x, y = up (FDS z), z = FDS y
                let mesh;
                if (r.type === 'hole') {
                    const box = new THREE.BoxGeometry(w, 0.5, d);
                    mesh = new THREE.LineSegments(
                        new THREE.EdgesGeometry(box),
                        new THREE.LineBasicMaterial({ color: 0x27c3ff, depthTest: false })
                    );
                    box.dispose();
                    mesh.position.y = height;
                } else {
                    // Amber, so manual visual obstructions stand apart from
                    // the gray FDS OBST geometry.
                    const boxHeight = height + 0.05;
                    mesh = new THREE.Mesh(
                        new THREE.BoxGeometry(w, boxHeight, d),
                        new THREE.MeshBasicMaterial({ color: 0xd98e2b, transparent: true, opacity: 0.6 })
                    );
                    mesh.position.y = boxHeight / 2;
                }
                mesh.position.x = (Math.min(r.x1, r.x2) + Math.max(r.x1, r.x2)) / 2;
                mesh.position.z = (Math.min(r.y1, r.y2) + Math.max(r.y1, r.y2)) / 2;
                mesh.renderOrder = 95;
                mesh._isVisualRegion = true;
                mesh._vismapModeVisible = this.visible;
                mesh.visible = this.visible && this._regionLayerOn();
                this.scene.add(mesh);
                this.regionMeshes.push(mesh);
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────
    global.VisMapEngine = VisMapEngine;
    global.VisMapOverlay = VisMapOverlay;
    global.VisMapUtil = { bresenhamIndices, closestIndex, jetReversed, drawEvacuationSign };
})(window);
