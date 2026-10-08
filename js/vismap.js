/**
 * Visibility maps (Vismap) for the Output page — engine.
 *
 * Pure-JS port of FireDynamics/fdsvismap v0.3.2 (FDSVisMap.py, Sign.py,
 * Route.py, MapStyle.py, helper_functions.py): the assessment of the
 * visibility of safety signs along routes of egress, based on FDS soot
 * extinction coefficient slices and Jin's visibility model V = C / K̄ along
 * sight lines.
 *
 * Class, method and attribute names follow fdsvismap in camelCase, so a
 * Python script translates line by line:
 *
 *   vis = VisMap()                          const vis = new VisMap();
 *   vis.read_fds_data(sim_dir, 2)           vis.readFdsData(sim, { fdsSlcHeight: 2 });
 *   vis.add_sign(1, 8.4, 4.8, 3, 0)         vis.addSign(1, 8.4, 4.8, 3, 0);
 *   vis.add_route("exit", [(1, 9), ...])    vis.addRoute('exit', [[1, 9], ...]);
 *   vis.set_time_points(range(0, 500, 50))  vis.setTimePoints([0, 50, ...]);
 *   vis.compute_all()                       vis.computeAll();
 *   vis.get_aset_map(route_id="exit")       vis.getAsetMap(null, 'exit');
 *
 * The results are meant to equal those of fdsvismap cell by cell, so the port
 * keeps its numerics: scikit-image's line rasterisers, numpy's pairwise
 * summation and nearest-index rules, and the float32 coordinates fdsreader
 * hands over (float64 for a grid set with setGrid). Where numpy 1 and numpy 2
 * promote differently, numpy 2 is followed, which fdsvismap 0.3.2 requires.
 *
 * Maps are flat arrays over the grid, index = i + nx * j with i along x and
 * j along y — fdsvismap's (ny, nx) arrays read row by row. Boolean maps are
 * Uint8Array (0/1), the ASET map is a Float64Array.
 *
 * Not ported: everything matplotlib (the plot_* methods, the background
 * image). The 3D counterparts live in vismap-overlay.js.
 *
 * Exposes (on window):
 *   VisMap        — the port of fdsvismap.VisMap, no THREE/DOM (node-testable)
 *   VisMapStyle   — fdsvismap.MapStyle
 *   VisMapRoute   — fdsvismap.Route
 *   VisMapFds     — what fdsvismap gets from fdsreader: slices, meshes and
 *                   obstructions of a simulation, read from its .smv
 *   VisMapUtil    — line rasterisers, colormap and the two error classes
 */

(function (global) {
    'use strict';

    /** fdsvismap release this file is a port of. */
    const FDSVISMAP_VERSION = '0.3.2';

    // fdsvismap raises ValueError for input it cannot use and RuntimeError
    // when data or a computation is missing; the two classes keep that apart.
    class VisMapValueError extends Error {
        constructor(message) { super(message); this.name = 'VisMapValueError'; }
    }
    class VisMapStateError extends Error {
        constructor(message) { super(message); this.name = 'VisMapStateError'; }
    }

    const EXTCO_QUANTITIES = ['ext_coef_C', 'ext_coef_C0.9H0.1', 'SOOT EXTINCTION COEFFICIENT', 'EXTINCTION COEFFICIENT'];
    const OD_QUANTITIES = ['OD_C', 'OD_C0.9H0.1', 'SOOT OPTICAL DENSITY', 'OPTICAL DENSITY'];

    // ── scikit-image line rasterisers ─────────────────────────────────────
    /** skimage.draw.line: Bresenham from (r0, c0) to (r1, c1), both ends
     *  included. Writes the cells into rr/cc and returns their number. */
    function line(r0, c0, r1, c1, rr, cc) {
        let r = r0, c = c0;
        let dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
        let sc = (c1 - c) > 0 ? 1 : -1;
        let sr = (r1 - r) > 0 ? 1 : -1;
        let steep = false, tmp;
        if (dr > dc) {
            steep = true;
            tmp = c; c = r; r = tmp;
            tmp = dc; dc = dr; dr = tmp;
            tmp = sc; sc = sr; sr = tmp;
        }
        let d = 2 * dr - dc;
        for (let i = 0; i < dc; i++) {
            if (steep) { rr[i] = c; cc[i] = r; } else { rr[i] = r; cc[i] = c; }
            while (d >= 0) { r += sr; d -= 2 * dc; }
            c += sc;
            d += 2 * dr;
        }
        rr[dc] = r1;
        cc[dc] = c1;
        return dc + 1;
    }

    /** skimage.draw.line_aa without its intensities: the anti-aliased line
     *  with the cells beside it, in the order scikit-image emits them. Writes
     *  at most 3 * (dr + dc + 1) cells into rr/cc and returns their number. */
    function lineAA(r0, c0, r1, c1, rr, cc) {
        const dc = Math.abs(c0 - c1), dr = Math.abs(r0 - r1);
        const signC = c0 < c1 ? 1 : -1, signR = r0 < r1 ? 1 : -1;
        // scikit-image keeps err and ed in C floats
        const ed = (dc + dr === 0) ? 1 : Math.fround(Math.sqrt(dc * dc + dr * dr));
        let err = dc - dr, c = c0, r = r0, n = 0;
        for (;;) {
            cc[n] = c; rr[n] = r; n++;
            const errPrime = err, cPrime = c;
            if (2 * errPrime >= -dc) {
                if (c === c1) break;
                if (errPrime + dr < ed) { cc[n] = c; rr[n] = r + signR; n++; }
                err -= dr;
                c += signC;
            }
            if (2 * errPrime <= dr) {
                if (r === r1) break;
                if (dc - errPrime < ed) { cc[n] = cPrime + signC; rr[n] = r; n++; }
                err += dc;
                r += signR;
            }
        }
        return n;
    }

    /** The sight line from grid cell (x0, y0) to (x1, y1) as flat indices
     *  x + nx * y — fdsvismap's line(ref_x_id, ref_y_id, x_id, y_id). */
    function rayCells(x0, y0, x1, y1, nx, out, offset) {
        let r = x0, c = y0;
        let dr = Math.abs(x1 - x0), dc = Math.abs(y1 - y0);
        let sc = (y1 - c) > 0 ? 1 : -1;
        let sr = (x1 - r) > 0 ? 1 : -1;
        let steep = false, tmp;
        if (dr > dc) {
            steep = true;
            tmp = c; c = r; r = tmp;
            tmp = dc; dc = dr; dr = tmp;
            tmp = sc; sc = sr; sr = tmp;
        }
        let d = 2 * dr - dc;
        for (let i = 0; i < dc; i++) {
            out[offset + i] = steep ? c + nx * r : r + nx * c;
            while (d >= 0) { r += sr; d -= 2 * dc; }
            c += sc;
            d += 2 * dr;
        }
        out[offset + dc] = x1 + nx * y1;
        return dc + 1;
    }

    // ── numpy helpers ─────────────────────────────────────────────────────
    /** np.add.reduce of a[from .. from+n): numpy sums in blocks of eight and
     *  pairwise above 128 values. Summing left to right would differ in the
     *  last bits, which decides cells exactly on the visibility threshold. */
    function pairwiseSum(a, from, n) {
        if (n < 8) {
            let res = 0;
            for (let i = 0; i < n; i++) res += a[from + i];
            return res;
        }
        if (n <= 128) {
            let r0 = a[from], r1 = a[from + 1], r2 = a[from + 2], r3 = a[from + 3];
            let r4 = a[from + 4], r5 = a[from + 5], r6 = a[from + 6], r7 = a[from + 7];
            let i = 8;
            for (; i < n - (n % 8); i += 8) {
                r0 += a[from + i]; r1 += a[from + i + 1]; r2 += a[from + i + 2]; r3 += a[from + i + 3];
                r4 += a[from + i + 4]; r5 += a[from + i + 5]; r6 += a[from + i + 6]; r7 += a[from + i + 7];
            }
            let res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
            for (; i < n; i++) res += a[from + i];
            return res;
        }
        let n2 = n >> 1;
        n2 -= n2 % 8;
        return pairwiseSum(a, from, n2) + pairwiseSum(a, from + n2, n - n2);
    }

    /** One segment of np.add.reduceat: the first value starts the reduction,
     *  the rest is added as one pairwise sum. */
    function reduceSegment(a, n) {
        return n > 1 ? a[0] + pairwiseSum(a, 1, n - 1) : a[0];
    }

    /** helper_functions.get_id_of_closest_value: index of the coordinate
     *  closest to the value, the first one of several. numpy subtracts in
     *  the precision of the coordinates, which settles the frequent ties of
     *  a value on a cell face. */
    function closestIndex(coords, value) {
        let best = 0, bestDiff = Infinity;
        if (coords instanceof Float32Array) {
            const v = Math.fround(value);
            for (let i = 0; i < coords.length; i++) {
                const d = Math.abs(Math.fround(coords[i] - v));
                if (d < bestDiff) { bestDiff = d; best = i; }
            }
        } else {
            for (let i = 0; i < coords.length; i++) {
                const d = Math.abs(coords[i] - value);
                if (d < bestDiff) { bestDiff = d; best = i; }
            }
        }
        return best;
    }

    /** helper_functions.get_ids_of_closest_values: np.searchsorted on the
     *  midpoints between neighbouring coordinates (ascending). */
    function closestIndices(coords, values) {
        const n = coords.length;
        const midpoints = new coords.constructor(Math.max(n - 1, 0));
        for (let i = 0; i < n - 1; i++) midpoints[i] = (coords[i] + coords[i + 1]) / 2;
        const out = new Int32Array(values.length);
        for (let k = 0; k < values.length; k++) {
            let lo = 0, hi = midpoints.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (midpoints[mid] < values[k]) lo = mid + 1; else hi = mid;
            }
            out[k] = lo;
        }
        return out;
    }

    /** np.unique of the values as float64: ascending, without duplicates. */
    function uniqueSorted(values) {
        const sorted = Float64Array.from(values).sort();
        let n = 0;
        for (let i = 0; i < sorted.length; i++) {
            if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[n++] = sorted[i];
        }
        return sorted.slice(0, n);
    }

    /** np.interp for ascending xp, x within [xp[0], xp[last]]. */
    function interp(x, xp, fp) {
        const out = new Float64Array(x.length);
        const last = xp.length - 1;
        for (let k = 0; k < x.length; k++) {
            const v = x[k];
            let lo = 0, hi = xp.length;
            while (lo < hi) {
                const mid = lo + ((hi - lo) >> 1);
                if (v >= xp[mid]) lo = mid + 1; else hi = mid;
            }
            const j = lo - 1;
            if (j < 0) out[k] = fp[0];
            else if (j >= last) out[k] = fp[last];
            else if (xp[j] === v) out[k] = fp[j];
            else out[k] = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]) * (v - xp[j]) + fp[j];
        }
        return out;
    }

    /** np.allclose(steps, steps[0], rtol) for the spacing of a coordinate axis. */
    function uniformSteps(coords, rtol) {
        const s0 = coords[1] - coords[0];
        let min = Infinity, max = -Infinity, uniform = true;
        for (let i = 1; i < coords.length; i++) {
            const s = coords[i] - coords[i - 1];
            if (s < min) min = s;
            if (s > max) max = s;
            if (!(Math.abs(s - s0) <= 1e-8 + rtol * Math.abs(s0))) uniform = false;
        }
        return { first: s0, min, max, uniform };
    }

    // ── MapStyle ──────────────────────────────────────────────────────────
    /**
     * Colors and opacities of the maps of a VisMap (fdsvismap.MapStyle).
     * The defaults tell cells from which a sign is visible (green) from the
     * others (light, neutral gray) by lightness and saturation, so they stay
     * apart with red-green color vision deficiency.
     */
    class VisMapStyle {
        constructor(overrides) {
            this.notVisible = '#dcd9d2';
            this.visible = '#3f9e5a';
            this.sign = '#0a5f28';
            this.startPointFace = '#ffffff';
            this.startPointEdge = '#000000';
            this.routeCovered = '#1b7a3c';
            this.routeUncovered = '#8f8a83';
            this.asetCmap = 'viridis';
            this.neverVisible = '#c6c9de';
            this.obstruction = '#5a5a5a';
            this.obstructionAlpha = 0.5;
            this.mapAlpha = 0.7;
            Object.assign(this, overrides);
        }
    }

    // matplotlib's viridis at 33 evenly spaced points; linear in between it
    // stays within 1 % of the 256 entries of the original.
    const VIRIDIS = [
        [68, 1, 84], [71, 13, 96], [72, 24, 106], [72, 35, 116], [71, 45, 123], [69, 55, 129], [66, 64, 134],
        [62, 73, 137], [59, 82, 139], [55, 91, 141], [51, 99, 141], [47, 107, 142], [44, 114, 142], [41, 122, 142],
        [38, 130, 142], [35, 137, 142], [33, 145, 140], [31, 152, 139], [31, 160, 136], [34, 167, 133],
        [40, 174, 128], [50, 182, 122], [63, 188, 115], [78, 195, 107], [94, 201, 98], [112, 207, 87],
        [132, 212, 75], [152, 216, 62], [173, 220, 48], [194, 223, 35], [216, 226, 25], [236, 229, 27], [253, 231, 37],
    ];

    /** Color [r, g, b] of the viridis colormap for t in [0, 1]. */
    function viridis(t) {
        const u = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
        const i = Math.min(Math.floor(u), VIRIDIS.length - 2);
        const f = u - i, a = VIRIDIS[i], b = VIRIDIS[i + 1];
        return [
            Math.round(a[0] + (b[0] - a[0]) * f),
            Math.round(a[1] + (b[1] - a[1]) * f),
            Math.round(a[2] + (b[2] - a[2]) * f),
        ];
    }

    // ── Route ─────────────────────────────────────────────────────────────
    /**
     * A route of egress as a polyline of waypoints, together with the signs
     * that guide along it (fdsvismap.Route). The route does not have to pass
     * the signs, it is enough to see them.
     */
    class VisMapRoute {
        /**
         * @param {number[][]} waypoints (x, y) pairs in FDS coordinates, the first one is the starting point
         * @param {Array<number|string>} [signs] IDs of the signs that belong to the route
         */
        constructor(waypoints, signs) {
            const pairs = Array.isArray(waypoints) && waypoints.every(p =>
                p && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
            if (!pairs) throw new VisMapValueError('The waypoints of a route have to be (x, y) pairs.');
            if (waypoints.length < 2) {
                throw new VisMapValueError('A route needs at least two waypoints, ' + waypoints.length + ' were given.');
            }
            this.waypoints = waypoints.map(p => [Number(p[0]), Number(p[1])]);
            this.signs = Array.from(signs || []);
        }

        /** Length of the route along its polyline in meters. */
        get length() {
            let sum = 0;
            for (let i = 1; i < this.waypoints.length; i++) {
                const dx = this.waypoints[i][0] - this.waypoints[i - 1][0];
                const dy = this.waypoints[i][1] - this.waypoints[i - 1][1];
                sum += Math.sqrt(dx * dx + dy * dy);
            }
            return sum;
        }

        /**
         * Sample the polyline at equidistant points, at most `step` apart.
         * The first point is the starting point, the last one the end.
         * @returns {number[][]} (x, y) pairs
         */
        sample(step) {
            if (!(step > 0)) throw new VisMapValueError('The step has to be positive, not ' + step + '.');
            // Waypoints repeated at the same position would make the interpolation ambiguous
            const xs = [this.waypoints[0][0]], ys = [this.waypoints[0][1]], positions = [0];
            for (let i = 1; i < this.waypoints.length; i++) {
                const dx = this.waypoints[i][0] - this.waypoints[i - 1][0];
                const dy = this.waypoints[i][1] - this.waypoints[i - 1][1];
                const length = Math.sqrt(dx * dx + dy * dy);
                if (!(length > 0)) continue;
                xs.push(this.waypoints[i][0]);
                ys.push(this.waypoints[i][1]);
                positions.push(positions[positions.length - 1] + length);
            }
            if (positions.length === 1) return [[xs[0], ys[0]]];
            const total = positions[positions.length - 1];
            const numPoints = Math.ceil(total / step) + 1;
            // np.linspace(0, total, numPoints)
            const samples = new Float64Array(numPoints);
            const delta = total / (numPoints - 1);
            for (let i = 0; i < numPoints; i++) samples[i] = i * delta;
            samples[numPoints - 1] = total;
            const px = interp(samples, positions, xs), py = interp(samples, positions, ys);
            return Array.from(px, (x, i) => [x, py[i]]);
        }
    }

    // ── FDS output (the part of fdsreader that fdsvismap uses) ────────────
    function numbersOf(text) {
        return String(text || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
    }

    function baseName(fileName) {
        return String(fileName).split(/[\\/]/).pop().trim();
    }

    /**
     * Slices, meshes and obstructions of an FDS simulation as its .smv file
     * describes them — what fdsvismap reads through fdsreader.Simulation.
     *
     *   const sim = VisMapFds.fromSmv(smvText, 'model.smv');
     *   const slc = VisMap.selectSlice(sim, vis.quantity, { fdsSlcHeight: 2 });
     *   for (const name of sim.filesOf(slc)) sim.addSliceFile(name, FdsSliceReader.parse(buffer));
     *   vis.readFdsData(sim, { fdsSlcHeight: 2 });
     */
    class VisMapFds {
        constructor(name) {
            this.name = name || 'the simulation';
            /** [{ id, ijk, xb, coordinates: [Float32Array x, y, z] }] in the order of the .smv */
            this.meshes = [];
            /** [{ meshIndex, xb: [x1, x2, y1, y2, z1, z2] }], one entry per obstruction and mesh */
            this.obstructions = [];
            /** Slices in the order fdsreader lists them, see _finishSlices */
            this.slices = [];
            /** Parsed slice files by file name: { dims, frames: [{ time }], getFrameData(i) } */
            this.sliceFiles = new Map();
        }

        static fromSmv(text, name) {
            const sim = new VisMapFds(name);
            const lines = String(text).split(/\r?\n/);
            const records = [];
            let mesh = null;
            for (let i = 0; i < lines.length; i++) {
                const row = lines[i];
                if (/^GRID\b/.test(row)) {
                    // A mesh is kept even if it cannot be read: the slices and
                    // obstructions refer to the meshes by their position.
                    const ijk = numbersOf(lines[i + 1]).slice(0, 3);
                    mesh = {
                        id: row.slice(4).trim() || 'mesh_' + (sim.meshes.length + 1),
                        ijk: ijk.length === 3 ? ijk : null, xb: null, coordinates: [null, null, null],
                    };
                    sim.meshes.push(mesh);
                } else if (mesh && mesh.ijk && /^PDIM\s*$/.test(row)) {
                    const values = numbersOf(lines[i + 1]);
                    if (values.length >= 6) mesh.xb = values.slice(0, 6);
                } else if (mesh && mesh.ijk && /^TRN[XYZ]\s*$/.test(row)) {
                    // A count of stretching lines, those lines, then one
                    // "index coordinate" line per grid node.
                    const axis = 'XYZ'.indexOf(row[3]);
                    const stretch = parseInt(lines[i + 1], 10);
                    const start = i + 2 + (stretch > 0 ? stretch : 0);
                    const coordinates = new Float32Array(mesh.ijk[axis] + 1);
                    let complete = true;
                    for (let k = 0; k < coordinates.length; k++) {
                        const parts = String(lines[start + k] || '').trim().split(/\s+/);
                        const value = Number(parts[1]);
                        if (parts.length < 2 || !Number.isFinite(value)) { complete = false; break; }
                        coordinates[k] = value;
                    }
                    if (complete) {
                        mesh.coordinates[axis] = coordinates;
                        i = start + coordinates.length - 1;
                    }
                } else if (mesh && /^OBST\s*$/.test(row)) {
                    // The number of obstructions, their extents, then their cell indices
                    const count = parseInt(lines[i + 1], 10) || 0;
                    for (let k = 0; k < count; k++) {
                        const values = numbersOf(String(lines[i + 2 + k] || '').split('!')[0]);
                        if (values.length >= 6) {
                            sim.obstructions.push({ meshIndex: sim.meshes.length - 1, xb: values.slice(0, 6) });
                        }
                    }
                    i += 1 + 2 * count;
                } else {
                    //   SLCF  M # STRUCTURED [%ID] & i1 i2 j1 j2 k1 k2 ! index cell orient
                    // followed by the file name, quantity, short name and unit.
                    const m = /^(SLCF|SLCC|SLCT)\s+(\d+)\b(.*)$/.exec(row);
                    if (!m) continue;
                    // The bounds and the index are read from the end of the
                    // line: an ID may itself contain '&' or '!'.
                    const tail = /&((?:\s+-?\d+){6})\s*(?:!\s*(\d+)(?:\s+-?\d+)*)?\s*$/.exec(m[3]);
                    const fileName = String(lines[i + 1] || '').trim();
                    if (!tail || !/\.sf$/i.test(fileName)) continue;
                    const head = m[3].slice(0, tail.index);
                    const fromName = /_(\d+)\.sf$/i.exec(fileName);
                    records.push({
                        cellCentered: m[1] === 'SLCC',
                        meshIndex: Number(m[2]) - 1,
                        id: head.includes('%') ? head.slice(head.indexOf('%') + 1).trim() : '',
                        indices: tail[1].trim().split(/\s+/).map(Number),
                        // Older FDS versions do not write the index; the number
                        // in the file name is the nearest thing to it.
                        sliceIndex: tail[2] !== undefined ? Number(tail[2]) : (fromName ? Number(fromName[1]) : records.length),
                        fileName: baseName(fileName),
                        quantity: String(lines[i + 2] || '').trim(),
                        shortName: String(lines[i + 3] || '').trim(),
                        unit: String(lines[i + 4] || '').trim(),
                    });
                    i += 4;
                }
            }
            for (const m of sim.meshes) {
                if (!m.ijk) continue;
                for (let axis = 0; axis < 3; axis++) {
                    if (m.coordinates[axis] || !m.xb) continue;
                    // No TRN block: the nodes are evenly spaced over the mesh
                    const n = m.ijk[axis];
                    m.coordinates[axis] = Float32Array.from({ length: n + 1 },
                        (_, k) => m.xb[axis * 2] + (m.xb[axis * 2 + 1] - m.xb[axis * 2]) * k / n);
                }
            }
            sim._finishSlices(records);
            return sim;
        }

        // One slice per &SLCF line: the records of all meshes with the same
        // index, in the order in which the indices first appear.
        _finishSlices(records) {
            const byIndex = new Map();
            for (const record of records) {
                const mesh = this.meshes[record.meshIndex];
                if (!mesh || !mesh.coordinates.every(Boolean)) continue;
                const [i1, i2, j1, j2, k1, k2] = record.indices;
                const co = mesh.coordinates;
                if (!(i1 >= 0 && i2 < co[0].length && j1 >= 0 && j2 < co[1].length && k1 >= 0 && k2 < co[2].length)) continue;
                if (!byIndex.has(record.sliceIndex)) {
                    byIndex.set(record.sliceIndex, {
                        sliceIndex: record.sliceIndex, id: record.id, cellCentered: record.cellCentered,
                        quantity: record.quantity, shortName: record.shortName, unit: record.unit,
                        subslices: [],
                    });
                }
                const slc = byIndex.get(record.sliceIndex);
                // Vector slices repeat the index for the velocity components;
                // the first record of a mesh holds the quantity itself.
                if (slc.subslices.some(s => s.meshIndex === record.meshIndex)) continue;
                const extent = [[co[0][i1], co[0][i2]], [co[1][j1], co[1][j2]], [co[2][k1], co[2][k2]]];
                slc.subslices.push({
                    meshIndex: record.meshIndex, fileName: record.fileName, indices: record.indices, extent,
                    orientation: extent[0][0] === extent[0][1] ? 1 : extent[1][0] === extent[1][1] ? 2
                        : extent[2][0] === extent[2][1] ? 3 : 0,
                });
            }
            this.slices = Array.from(byIndex.values());
            this.slices.forEach((slc, index) => {
                const subs = slc.subslices;
                slc.index = index;
                slc.orientation = subs.every(s => s.orientation === subs[0].orientation) ? subs[0].orientation : 0;
                slc.extent = [0, 1, 2].map(axis => {
                    const start = Math.min(...subs.map(s => s.extent[axis][0]));
                    return [start, slc.orientation === axis + 1 ? start : Math.max(...subs.map(s => s.extent[axis][1]))];
                });
            });
        }

        /** File names of the slice files a slice consists of, one per mesh. */
        filesOf(slc) { return slc.subslices.map(s => s.fileName); }

        /** Hand over a parsed slice file (FdsSliceReader.parse). */
        addSliceFile(fileName, dataset) { this.sliceFiles.set(baseName(fileName), dataset); }

        /** One line of VisMap._describeSlices for a slice. */
        static describeSlice(slc) {
            const position = slc.orientation === 0 ? '3D'
                : 'xyz'[slc.orientation - 1] + ' = ' + slc.extent[slc.orientation - 1][0].toFixed(2) + ' m';
            return '[' + slc.index + '] ' + (slc.id || '(no ID)') + ': ' + slc.quantity + ', ' + position;
        }

        /**
         * Put the slice files of a horizontal slice together to one grid over
         * all meshes, as fdsreader's Slice.to_global and get_coordinates do.
         * The meshes need one cell size; cells that no mesh covers are NaN.
         * A cell-centred slice (&SLCF ... CELL_CENTERED=T) holds its values at
         * the cell centres, otherwise they lie on the grid nodes.
         */
        assembleSlice(slc) {
            if (slc.orientation !== 3) {
                throw new VisMapValueError('Slice ' + VisMapFds.describeSlice(slc) +
                    ' is not horizontal. A vismap needs a slice at a fixed height (PBZ).');
            }
            const parts = slc.subslices.map(sub => {
                const dataset = this.sliceFiles.get(sub.fileName);
                if (!dataset) throw new VisMapStateError('The slice file ' + sub.fileName + ' has not been read.');
                const mesh = this.meshes[sub.meshIndex];
                const [i1, i2, j1, j2] = sub.indices;
                if (dataset.dims[0] !== i2 - i1 + 1 || dataset.dims[1] !== j2 - j1 + 1 || dataset.dims[2] !== 1) {
                    throw new VisMapValueError('The slice file ' + sub.fileName + ' holds ' + dataset.dims.join(' x ') +
                        ' values, the .smv announces ' + (i2 - i1 + 1) + ' x ' + (j2 - j1 + 1) + ' x 1.');
                }
                return {
                    dataset, sub,
                    axes: [0, 1].map(axis => {
                        const nodes = mesh.coordinates[axis], first = sub.indices[axis * 2], last = sub.indices[axis * 2 + 1];
                        let coords;
                        if (slc.cellCentered) {
                            // fdsreader shifts the nodes by half the first cell and drops the last one
                            const half = Math.abs(Math.fround(nodes[1] - nodes[0])) / 2;
                            coords = Float32Array.from({ length: last - first }, (_, k) => nodes[first + k] + half);
                        } else {
                            coords = nodes.slice(first, last + 1);
                        }
                        return { coords, end: nodes[last] };
                    }),
                };
            });

            const grid = [0, 1].map(axis => {
                // Coordinates of all meshes without the ones they share
                const all = Float32Array.from(parts.flatMap(p => Array.from(p.axes[axis].coords))).sort();
                const coords = all.filter((v, k) => k === 0 || Math.fround(v - all[k - 1]) > Math.fround(0.000002));
                const name = 'xy'[axis];
                if (coords.length < 2) {
                    throw new VisMapValueError('The slice has less than two cells in ' + name + ' direction.');
                }
                const steps = uniformSteps(coords, 1e-3);
                if (!steps.uniform) {
                    throw new VisMapValueError('The cells of the slice are not equally wide in ' + name +
                        ' direction (' + steps.min.toPrecision(4) + ' m to ' + steps.max.toPrecision(4) +
                        ' m). A vismap needs meshes of one cell size that adjoin without stretching.');
                }
                return { coords, end: Math.max(...parts.map(p => p.axes[axis].end)) };
            });
            const nx = grid[0].coords.length, ny = grid[1].coords.length;

            for (const part of parts) {
                part.offset = [0, 1].map(axis => closestIndex(grid[axis].coords, part.axes[axis].coords[0]));
                // Values on the nodes: a node on the border between two meshes
                // belongs to the mesh that starts there, as in fdsreader.
                part.count = [0, 1].map(axis => {
                    const { coords, end } = part.axes[axis];
                    const outer = Math.abs(end - grid[axis].end) <= 1e-8 + 1e-5 * Math.abs(grid[axis].end);
                    return slc.cellCentered || outer ? coords.length : coords.length - 1;
                });
            }

            const first = parts[0].dataset;
            const frameCount = Math.min(...parts.map(p => p.dataset.frames.length));
            const shift = slc.cellCentered ? 1 : 0;  // skips the ghost values of a cell-centred slice
            return {
                xCoords: grid[0].coords,
                yCoords: grid[1].coords,
                extent: slc.extent,
                times: Float64Array.from(first.frames.slice(0, frameCount), f => f.time),
                /** Values of one FDS time step, index = i + nx * j. */
                frame(timeIndex) {
                    const out = new Float32Array(nx * ny).fill(NaN);
                    for (const part of parts) {
                        const values = part.dataset.getFrameData(timeIndex);
                        const width = part.dataset.dims[0];
                        for (let b = 0; b < part.count[1]; b++) {
                            const target = part.offset[0] + nx * (part.offset[1] + b);
                            const source = shift + width * (b + shift);
                            for (let a = 0; a < part.count[0]; a++) out[target + a] = values[source + a];
                        }
                    }
                    return out;
                },
            };
        }
    }

    // ── VisMap ────────────────────────────────────────────────────────────
    /**
     * Visibility maps based on FDS data (fdsvismap.VisMap).
     *
     * One instance holds the smoke field, the obstructions, all safety signs
     * and all routes of egress. A sign has a position, one viewing direction
     * and a contrast factor; its visibility map does not depend on any route
     * and is computed only once (addSign). A route is a polyline of waypoints
     * together with the signs that guide along it, which do not have to lie
     * on it (addRoute). From that follow the maps of a route and its
     * coverage, the share of its length from which a sign is visible
     * (getRouteCoverage).
     */
    class VisMap {
        constructor() {
            this.obstructionsArray = new Uint8Array(0);
            this.vismapTimePoints = new Float64Array(0);
            this.quantity = 'ext_coef_C0.9H0.1';
            /** Signs by ID: { x, y, c, alpha }, alpha null for an omnidirectional sign */
            this.allSignDict = new Map();
            /** Routes by ID: VisMapRoute */
            this.allRouteDict = new Map();
            this.minVis = 0.0;
            this.maxVis = 30;
            this.style = new VisMapStyle();
            this.numEdgeCells = 1;

            // Set by readFdsData() or setGrid()
            this.fdsGridShape = null;       // [nx, ny]
            this.slc = null;
            this.extent = [];               // [[x_min, x_max], [y_min, y_max], ...]
            this.allXCoords = new Float64Array(0);
            this.allYCoords = new Float64Array(0);
            this.cellSize = [1.0, 1.0];
            this.fdsTimePoints = new Float64Array(0);
            /** Obstructions of the simulation: [{ xb: [x1, x2, y1, y2, z1, z2] }] */
            this.obstructionsCollection = [];
            this.fdsSlcHeight = 2.0;
            // Rectangles of addVisualObstruction() and addVisualHole() as
            // [x1, x2, y1, y2, obstructed], applied again after every rebuild
            this.visualObjects = [];

            /** Sight lines are kept for all time steps up to this number of
             *  cells per VisMap; beyond it they are traced again per time step. */
            this.rayCacheLimit = 16e6;

            this._field = null;             // assembled slice, see VisMapFds.assembleSlice
            this._sliceFrames = new Map();  // slice data per FDS time step, loaded on first access
            this._uniformExtco = null;      // set by setUniformExtco() instead of readFdsData()
            this._invalidateResults();
        }

        // Discard the computed maps and the auxiliary arrays, because their
        // input has changed: signs, time points, obstructions and the
        // visibility bounds all enter the maps.
        _invalidateResults() {
            this._signBitsByTime = [];      // per computed time point: bit s is set where sign s is visible
            this._bitWords = 1;
            this._tMaxComputed = null;
            this._prepared = new Map();     // auxiliary arrays per sign ID
        }

        _checkComputed() {
            if (this._signBitsByTime.length === 0) {
                throw new VisMapStateError(
                    'No vismaps for the current signs, time points and obstructions. Call computeAll() first.');
            }
        }

        _checkPrepared(signId) {
            this._getSignPosition(signId);
            if (!this._prepared.has(signId)) {
                throw new VisMapStateError('No auxiliary arrays for sign ' + signId + '. Call computeAll() first.');
            }
        }

        /**
         * Set the times on which the simulation should be evaluated, in any
         * order. They are sorted and duplicates are removed, because the
         * aggregation over time relies on that order.
         */
        setTimePoints(timePoints) {
            this.vismapTimePoints = uniqueSorted(timePoints);
            this._releaseSliceFrames();
            this._invalidateResults();
        }

        /** Set a lower and upper bound for visibility as a performance
         *  criterion. The lower bound is a local minimum value. */
        setVisibilityBounds(minVis, maxVis) {
            this.minVis = minVis;
            this.maxVis = maxVis;
            this._invalidateResults();
        }

        /**
         * Add a safety sign, whose visibility is evaluated independently of
         * the routes it belongs to. A sign has exactly one viewing direction;
         * a sign that two routes approach from different sides is added
         * twice, once per viewing direction.
         * @param {number|string} signId
         * @param {number} x  FDS coordinates
         * @param {number} y
         * @param {number} c  contrast factor of the sign according to Jin
         * @param {number|null|'omni'} alpha  orientation, measured clockwise
         *        from the positive y-axis; 'omni' or null for a sign that is
         *        visible from all directions
         */
        addSign(signId, x, y, c, alpha) {
            this.allSignDict.set(signId, {
                x, y, c, alpha: (alpha === 'omni' || alpha === null || alpha === undefined) ? null : alpha,
            });
            this._invalidateResults();
        }

        /**
         * Add a route of egress as a polyline of waypoints, together with the
         * signs that guide along it. A sign may belong to several routes, its
         * visibility map is computed only once.
         * @param {number|string} routeId
         * @param {number[][]} waypoints (x, y) pairs, the first one is the starting point
         * @param {Array<number|string>} [signs] IDs of the signs of the route;
         *        all signs added so far if omitted
         */
        addRoute(routeId, waypoints, signs) {
            const signIds = (signs === undefined || signs === null) ? Array.from(this.allSignDict.keys()) : Array.from(signs);
            const unknown = signIds.filter(id => !this.allSignDict.has(id));
            if (unknown.length) {
                throw new VisMapValueError('No sign with the ID(s) ' + unknown.join(', ') +
                    '. Available IDs: ' + Array.from(this.allSignDict.keys()).join(', '));
            }
            this.allRouteDict.set(routeId, new VisMapRoute(waypoints, signIds));
        }

        _gridShape() {
            if (this.fdsGridShape === null) {
                throw new VisMapStateError('No sampling grid. Call readFdsData() for an FDS scene, or ' +
                    'setGrid() for a scene without a fire.');
            }
            return this.fdsGridShape;
        }

        /**
         * Define the sampling grid without reading an FDS simulation.
         *
         * Visibility is a property of geometry and smoke, and only the smoke
         * has to come from FDS. A scene that has walls and signs but no fire
         * still needs somewhere to evaluate. Pair with setUniformExtco() for
         * the extinction field and addVisualObstruction() for the walls. Maps
         * that were computed before are discarded.
         * @param {number[]} xCoords cell-centre x coordinates, ascending and evenly spaced
         * @param {number[]} yCoords cell-centre y coordinates, ascending and evenly spaced
         * @param {number} [slcHeight=2.0] height the scene is evaluated at,
         *        only used to select obstructions by their z range
         */
        setGrid(xCoords, yCoords, slcHeight) {
            const x = Float64Array.from(xCoords), y = Float64Array.from(yCoords);
            if (x.length < 2 || y.length < 2) {
                throw new VisMapValueError('setGrid needs at least two coordinates per axis to derive a ' +
                    'cell size; got ' + x.length + ' x and ' + y.length + ' y');
            }
            // The index snapping in _addVisualObject assumes a positive,
            // constant cell size. A descending or uneven axis would silently
            // place obstructions on the wrong cells.
            for (const [name, coords] of [['x', x], ['y', y]]) {
                const steps = uniformSteps(coords, 1e-6);
                if (!(steps.first > 0) || !steps.uniform) {
                    throw new VisMapValueError('setGrid needs ascending, uniformly spaced ' + name +
                        ' coordinates; got steps from ' + steps.min + ' to ' + steps.max);
                }
            }
            this.allXCoords = x;
            this.allYCoords = y;
            this.fdsGridShape = [x.length, y.length];
            // extent is the outer envelope of the cells, as for a slice
            const dx = x[1] - x[0], dy = y[1] - y[0];
            this.extent = [
                [x[0] - dx / 2, x[x.length - 1] + dx / 2],
                [y[0] - dy / 2, y[y.length - 1] + dy / 2],
            ];
            this.cellSize = [
                (this.extent[0][1] - this.extent[0][0]) / x.length,
                (this.extent[1][1] - this.extent[1][0]) / y.length,
            ];
            this.fdsSlcHeight = slcHeight === undefined ? 2.0 : slcHeight;
            this.buildObstructionsArray();
            this._invalidateResults();
        }

        /**
         * Use one extinction coefficient everywhere instead of an FDS slice.
         * 0 is clear air, a higher value a uniformly smoke-logged scene.
         * @param {number} [extco=0] extinction coefficient in 1/m
         * @param {number[]} [timePoints] times the scene is defined at;
         *        the times of setTimePoints() if omitted, or [0]. Sets the
         *        evaluation times as well.
         */
        setUniformExtco(extco, timePoints) {
            const value = extco === undefined ? 0.0 : extco;
            if (value < 0) throw new VisMapValueError('extinction coefficient must be >= 0, got ' + value);
            // A real slice no longer applies once a synthetic field is set
            this.slc = null;
            this._field = null;
            this._uniformExtco = Number(value);
            let points;
            if (timePoints !== undefined && timePoints !== null) points = Array.from(timePoints);
            else if (this.vismapTimePoints.length) points = Array.from(this.vismapTimePoints);
            else points = [0.0];
            this.fdsTimePoints = Float64Array.from(points);
            this.setTimePoints(points);
        }

        /**
         * Find the slice readFdsData() evaluates, without reading any data:
         * by index or ID if given, otherwise by quantity as the horizontal
         * slice closest to the height.
         * @param {VisMapFds} sim
         * @param {string} quantity  see VisMap.quantity
         * @param {object} [options] { fdsSlcHeight = 2.0, fdsSlcId, fdsSlcIndex }
         */
        static selectSlice(sim, quantity, options) {
            const o = options || {};
            const height = o.fdsSlcHeight === undefined ? 2.0 : o.fdsSlcHeight;
            let slc, searched;
            if (o.fdsSlcIndex !== undefined && o.fdsSlcIndex !== null) {
                if (!(Number.isInteger(o.fdsSlcIndex) && o.fdsSlcIndex >= 0 && o.fdsSlcIndex < sim.slices.length)) {
                    throw new VisMapValueError('No slice with index ' + o.fdsSlcIndex + ' in ' + sim.name +
                        '. Select one of the available slices:\n' + VisMap._describeSlices(sim.slices));
                }
                slc = sim.slices[o.fdsSlcIndex];
                searched = 'with index ' + o.fdsSlcIndex;
            } else if (o.fdsSlcId) {
                slc = sim.slices.find(s => s.id === o.fdsSlcId);
                searched = 'with ID \'' + o.fdsSlcId + '\'';
            } else {
                let fdsQuantity;
                if (EXTCO_QUANTITIES.includes(quantity)) fdsQuantity = 'SOOT EXTINCTION COEFFICIENT';
                else if (OD_QUANTITIES.includes(quantity)) fdsQuantity = 'SOOT OPTICAL DENSITY';
                else throw new VisMapValueError('Unsupported quantity: ' + quantity);
                const wanted = fdsQuantity.toLowerCase();
                slc = VisMap._getNearestHorizontalSlice(sim.slices.filter(s =>
                    s.quantity.toLowerCase() === wanted || s.shortName.toLowerCase() === wanted), height);
                searched = 'with quantity \'' + fdsQuantity + '\'';
            }
            if (!slc) {
                throw new VisMapValueError('No slice ' + searched + ' found in ' + sim.name +
                    '. Select one of the available slices with fdsSlcIndex or fdsSlcId:\n' +
                    VisMap._describeSlices(sim.slices));
            }
            return slc;
        }

        /**
         * Read FDS data and store relevant coordinates, shape of the grid,
         * slices and obstructions. The slice is selected by index or ID if
         * given, otherwise by quantity as the horizontal slice closest to the
         * given height; a slice selected by index or ID is treated as
         * `quantity` without its own quantity being checked. Its files have
         * to be handed to `sim` before, see VisMapFds.
         * @param {VisMapFds} sim
         * @param {object} [options] { fdsSlcHeight = 2.0, fdsSlcId, fdsSlcIndex }
         */
        readFdsData(sim, options) {
            const o = options || {};
            const slc = VisMap.selectSlice(sim, this.quantity, o);
            const field = sim.assembleSlice(slc);
            this.slc = slc;
            this._field = field;
            this.extent = field.extent;
            this.allXCoords = field.xCoords;
            this.allYCoords = field.yCoords;
            this.fdsGridShape = [this.allXCoords.length, this.allYCoords.length];
            this.cellSize = [
                (this.extent[0][1] - this.extent[0][0]) / this.fdsGridShape[0],
                (this.extent[1][1] - this.extent[1][0]) / this.fdsGridShape[1],
            ];
            this.fdsTimePoints = field.times;
            this.obstructionsCollection = sim.obstructions;
            this.fdsSlcHeight = o.fdsSlcHeight === undefined ? 2.0 : o.fdsSlcHeight;
            this._sliceFrames = new Map();
            // A real slice supersedes any synthetic field
            this._uniformExtco = null;
            this.buildObstructionsArray();
            this._invalidateResults();
        }

        // The horizontal slice closest to the height; ties go to the slice declared first.
        static _getNearestHorizontalSlice(slices, height) {
            let best = null, bestDiff = Infinity;
            for (const slc of slices) {
                if (slc.orientation !== 3) continue;
                const diff = Math.abs(slc.extent[2][0] - height);
                if (diff < bestDiff) { bestDiff = diff; best = slc; }
            }
            return best;
        }

        // FDS slices by ID, quantity and position, one slice per line.
        static _describeSlices(slices) {
            return slices.length ? slices.map(slc => '  ' + VisMapFds.describeSlice(slc)).join('\n') : '  (none)';
        }

        // fdsreader's Slice.get_nearest_timestep: the earlier of two time
        // steps only if it is strictly closer.
        _getNearestTimestep(time) {
            const times = this.fdsTimePoints, n = times.length;
            let idx = 0;
            while (idx < n && times[idx] < time) idx++;
            const before = times[idx > 0 ? idx - 1 : n - 1];
            if (time > 0 && (idx === n || Math.abs(time - before) < Math.abs(time - times[idx]))) return idx - 1;
            return idx;
        }

        _getRequiredTimeIndices() {
            const required = new Set();
            if (this._field) for (const time of this.vismapTimePoints) required.add(this._getNearestTimestep(time));
            return required;
        }

        // Drop the slice data of all FDS time steps the time points do not need.
        _releaseSliceFrames() {
            const required = this._getRequiredTimeIndices();
            for (const timeIndex of Array.from(this._sliceFrames.keys())) {
                if (!required.has(timeIndex)) this._sliceFrames.delete(timeIndex);
            }
        }

        _getSliceFrame(timeIndex) {
            if (!this._sliceFrames.has(timeIndex)) {
                if (!this._field) throw new VisMapStateError('FDS data not loaded. Call readFdsData() first.');
                this._releaseSliceFrames();
                this._sliceFrames.set(timeIndex, this._field.frame(timeIndex));
            }
            return this._sliceFrames.get(timeIndex);
        }

        /**
         * Get the extinction coefficients of the slice at the FDS time step
         * closest to the given time. Optical density is converted with
         * K = OD · ln(10).
         * @returns {Float64Array} index = i + nx * j
         */
        getExtcoArrayAtTime(time) {
            if (this._uniformExtco !== null) {
                const [nx, ny] = this._gridShape();
                return new Float64Array(nx * ny).fill(this._uniformExtco);
            }
            if (!this._field) {
                throw new VisMapStateError('No extinction data. Call readFdsData() for an FDS scene, or ' +
                    'setGrid() + setUniformExtco() for a scene without a fire.');
            }
            const frame = this._getSliceFrame(this._getNearestTimestep(time));
            const out = Float64Array.from(frame);
            if (OD_QUANTITIES.includes(this.quantity)) {
                for (let i = 0; i < out.length; i++) out[i] *= Math.LN10;
            }
            return out;
        }

        // Distances between the sign and all cells, in the precision of the coordinates.
        _getDistArray(sign) {
            const [nx, ny] = this.fdsGridShape;
            const x = this.allXCoords, y = this.allYCoords;
            const single = x instanceof Float32Array;
            const round = single ? Math.fround : v => v;
            const sx = round(sign.x), sy = round(sign.y);
            const dx = Float64Array.from(x, v => round(v - sx)), dy = Float64Array.from(y, v => round(v - sy));
            const distance = new x.constructor(nx * ny);
            for (let j = 0; j < ny; j++) {
                const dy2 = round(dy[j] * dy[j]);
                for (let i = 0; i < nx; i++) distance[i + nx * j] = Math.sqrt(round(round(dx[i] * dx[i]) + dy2));
            }
            return { distance, dx, dy };
        }

        // Cosine of the angle between the viewing direction of the sign and
        // the direction to each cell, 0 behind the sign. The cell of the sign
        // itself (distance 0) counts as seen from the front.
        _getViewAngleArray(sign, dist) {
            const [nx, ny] = this.fdsGridShape;
            const out = new Float64Array(nx * ny).fill(1);
            if (sign.alpha === null) return out;
            const rad = sign.alpha * (Math.PI / 180);
            const sin = Math.sin(rad), cos = Math.cos(rad);
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const d = dist.distance[i + nx * j];
                    if (!(d > 0)) continue;
                    const v = (sin * dist.dx[i] + cos * dist.dy[j]) / d;
                    out[i + nx * j] = v < 0 ? 0 : v > 1 ? 1 : v;
                }
            }
            return out;
        }

        /**
         * Build the array of obstructed cells from the obstructions of the
         * simulation whose z range includes the evaluation height. The
         * rectangles of addVisualObstruction() and addVisualHole() are applied
         * again afterwards, in the order in which they were added.
         */
        buildObstructionsArray() {
            const [nx, ny] = this._gridShape();
            const array = new Uint8Array(nx * ny);
            for (const obstruction of this.obstructionsCollection) {
                const xb = obstruction.xb;
                if (xb[4] <= this.fdsSlcHeight && this.fdsSlcHeight <= xb[5]) {
                    this._addVisualObject(xb[0], xb[1], xb[2], xb[3], array, true);
                }
            }
            for (const [x1, x2, y1, y2, obstructed] of this.visualObjects) {
                this._addVisualObject(x1, x2, y1, y2, array, obstructed);
            }
            this.obstructionsArray = array;
        }

        /**
         * Build the auxiliary arrays of all signs: the cells an obstruction
         * does not conceal, the view angle factor, the distances and the
         * sight lines.
         * @param {boolean} obstructions consider cells being concealed by obstructions
         * @param {boolean} viewAngle    consider the viewing direction of each sign
         * @param {boolean} aa           anti-aliased lines for the concealment
         */
        buildHelpArrays(obstructions, viewAngle, aa) {
            this._rayCacheLeft = this.rayCacheLimit;
            for (const signId of this.allSignDict.keys()) this._prepareSign(signId, obstructions, viewAngle, aa);
        }

        _prepareSign(signId, obstructions, viewAngle, aa) {
            const [nx, ny] = this._gridShape();
            const sign = this.allSignDict.get(signId);
            const nonConcealed = obstructions ? this._getNonConcealedCellsArray(sign, aa) : null;
            const dist = this._getDistArray(sign);
            const prep = {
                nonConcealed,
                viewAngle: viewAngle ? this._getViewAngleArray(sign, dist) : null,
                distance: dist.distance,
                refX: closestIndex(this.allXCoords, sign.x),
                refY: closestIndex(this.allYCoords, sign.y),
                cells: null, rayCells: null, rayStart: null,
            };
            // Cells with a sight line, in the order of np.where
            let count = 0, rayLength = 0;
            const cells = new Int32Array(nx * ny);
            for (let idx = 0; idx < cells.length; idx++) {
                if (nonConcealed && !nonConcealed[idx]) continue;
                cells[count++] = idx;
                rayLength += Math.max(Math.abs(idx % nx - prep.refX), Math.abs(Math.floor(idx / nx) - prep.refY)) + 1;
            }
            prep.cells = cells.slice(0, count);
            // The cells along all sight lines, one after the other, so they
            // are not traced again at every time step
            if (rayLength <= this._rayCacheLeft) {
                this._rayCacheLeft -= rayLength;
                prep.rayCells = new Int32Array(rayLength);
                prep.rayStart = new Int32Array(count + 1);
                let offset = 0;
                for (let k = 0; k < count; k++) {
                    const idx = prep.cells[k];
                    prep.rayStart[k] = offset;
                    offset += rayCells(prep.refX, prep.refY, idx % nx, Math.floor(idx / nx), nx, prep.rayCells, offset);
                }
                prep.rayStart[count] = offset;
            }
            this._prepared.set(signId, prep);
        }

        // Cells an obstruction does not conceal from the sign: lines from the
        // cell of the sign to every cell on the edge of the domain, each one
        // up to its first obstructed cell.
        _getNonConcealedCellsArray(sign, aa) {
            const [nx, ny] = this.fdsGridShape;
            const col0 = closestIndex(this.allXCoords, sign.x);
            const row0 = closestIndex(this.allYCoords, sign.y);
            const out = new Uint8Array(nx * ny);
            const obstructed = this.obstructionsArray;
            const size = aa ? 3 * (nx + ny + 1) : Math.max(nx, ny) + 1;
            const rr = new Int32Array(size), cc = new Int32Array(size);
            const edge = this.numEdgeCells;
            for (let row = 0; row < ny; row++) {
                const edgeRow = edge <= 0 || row < edge || row >= ny - edge;
                for (let col = 0; col < nx; col++) {
                    if (!edgeRow && col >= edge && col < nx - edge) { col = nx - edge - 1; continue; }
                    const n = aa ? lineAA(row0, col0, row, col, rr, cc) : line(row0, col0, row, col, rr, cc);
                    for (let k = 0; k < n; k++) {
                        const idx = cc[k] + nx * rr[k];
                        if (obstructed[idx]) break;
                        out[idx] = 1;
                    }
                }
            }
            return out;
        }

        // Mean extinction coefficient along the sight line to cell k of prep.cells.
        _meanExtco(prep, k, extco, scratch) {
            let cells = prep.rayCells, start, n;
            if (cells) {
                start = prep.rayStart[k];
                n = prep.rayStart[k + 1] - start;
            } else {
                const [nx] = this.fdsGridShape, idx = prep.cells[k];
                cells = scratch.cells;
                start = 0;
                n = rayCells(prep.refX, prep.refY, idx % nx, Math.floor(idx / nx), nx, cells, 0);
            }
            const values = scratch.values;
            for (let m = 0; m < n; m++) values[m] = extco[cells[start + m]];
            return reduceSegment(values, n) / n;
        }

        _scratch() {
            const [nx, ny] = this.fdsGridShape;
            const size = Math.max(nx, ny) + 1;
            return { cells: new Int32Array(size), values: new Float64Array(size) };
        }

        // Visibility along the line of sight to the sign, limited to maxVis.
        _visibility(sign, meanExtco) {
            const vis = meanExtco !== 0 ? sign.c / meanExtco : this.maxVis;
            return vis > this.maxVis ? this.maxVis : vis;
        }

        // Boolean vismap of a sign for an extinction field: view angle
        // factor × visibility has to reach the distance and the lower bound.
        _signVismap(signId, extco, out) {
            const sign = this.allSignDict.get(signId), prep = this._prepared.get(signId);
            const scratch = this._scratch();
            out.fill(0);
            for (let k = 0; k < prep.cells.length; k++) {
                const idx = prep.cells[k];
                const total = (prep.viewAngle ? prep.viewAngle[idx] : 1) *
                    this._visibility(sign, this._meanExtco(prep, k, extco, scratch));
                if (total >= prep.distance[idx] && !(total < this.minVis)) out[idx] = 1;
            }
            // A concealed cell has the visibility 0, which reaches the
            // distance only in the cell the sign itself sits in.
            const ref = prep.refX + this.fdsGridShape[0] * prep.refY;
            if (prep.nonConcealed && !prep.nonConcealed[ref]) {
                const total = this.maxVis * 0;
                if (total >= prep.distance[ref] && !(total < this.minVis)) out[ref] = 1;
            }
            return out;
        }

        /**
         * Generate the boolean vismap of a single sign at a given time,
         * independently of any route.
         * @returns {Uint8Array} 1 where the sign can be seen from a cell
         */
        getSignVismap(signId, time) {
            this._checkPrepared(signId);
            const [nx, ny] = this.fdsGridShape;
            return this._signVismap(signId, this.getExtcoArrayAtTime(time), new Uint8Array(nx * ny));
        }

        // A uniform field is exempt: it is identical at every time. For a
        // slice a time past the computed range would silently reuse the last
        // computed time point.
        _checkTimeInComputedRange(time) {
            if (this._uniformExtco !== null) return;
            if (this._tMaxComputed !== null && time > this._tMaxComputed) {
                throw new VisMapValueError('time=' + time + ' exceeds the maximum computed time (' +
                    this._tMaxComputed + '). Re-run computeAll() with a higher tMax.');
            }
        }

        // Position of the computed maps of the time point closest to the time.
        _timeId(time) {
            this._checkTimeInComputedRange(time);
            const timeId = closestIndex(this.vismapTimePoints, time);
            if (timeId >= this._signBitsByTime.length) {
                throw new VisMapValueError('time=' + time + ' exceeds the maximum computed time (' +
                    this._tMaxComputed + '). Re-run computeAll() with a higher tMax.');
            }
            return timeId;
        }

        // Bit mask of signs, in the words of the computed maps.
        _signMask(signIds) {
            const mask = new Uint32Array(this._bitWords);
            for (const signId of signIds) {
                const position = this._getSignPosition(signId);
                mask[position >> 5] |= 1 << (position & 31);
            }
            return mask;
        }

        // Is one of the signs of the mask visible from the cell at a computed time point?
        _anyVisible(timeId, idx, mask) {
            const bits = this._signBitsByTime[timeId], words = this._bitWords;
            for (let w = 0; w < words; w++) if (bits[idx * words + w] & mask[w]) return true;
            return false;
        }

        // Mask of the signs of a route, or of all signs.
        _scopeMask(routeId) {
            if (routeId === undefined || routeId === null) return this._signMask(this.allSignDict.keys());
            return this._signMask(this._getRoute(routeId).signs);
        }

        /**
         * Get the boolean visibility map at a point in time, aggregated over
         * the signs of a route or over all signs. A cell is 1 if at least one
         * of the signs is visible from it.
         * @param {number} time rounded to the closest computed time point
         * @param {number|string} [routeId] all signs if omitted
         * @returns {Uint8Array}
         */
        getAggVismap(time, routeId) {
            this._checkComputed();
            const timeId = this._timeId(time);
            const mask = this._scopeMask(routeId);
            const [nx, ny] = this.fdsGridShape;
            const out = new Uint8Array(nx * ny);
            for (let idx = 0; idx < out.length; idx++) if (this._anyVisible(timeId, idx, mask)) out[idx] = 1;
            return out;
        }

        /**
         * Get the boolean visibility map aggregated over time and over the
         * signs of a route or over all signs. A cell is 1 if at least one of
         * the signs is visible from it at every time point.
         * @param {number} [tMax] all computed time points if omitted
         * @param {number|string} [routeId] all signs if omitted
         * @returns {Uint8Array}
         */
        getTimeAggVismap(tMax, routeId) {
            const maxTime = this._getMaxTime(tMax);
            const [nx, ny] = this._gridShape();
            const out = new Uint8Array(nx * ny).fill(1);
            for (const time of this.vismapTimePoints) {
                if (!(time <= maxTime)) continue;
                const map = this.getAggVismap(time, routeId);
                for (let idx = 0; idx < out.length; idx++) out[idx] &= map[idx];
            }
            return out;
        }

        /**
         * Generate a map of the earliest time at which each cell becomes
         * non-visible. Cells that never become non-visible hold maxTime.
         * @param {number} [maxTime] the maximum computed time if omitted
         * @param {number|string} [routeId] all signs if omitted
         * @returns {Float64Array}
         */
        getAsetMap(maxTime, routeId) {
            const max = this._getMaxTime(maxTime);
            const [nx, ny] = this._gridShape();
            const aset = new Float64Array(nx * ny).fill(max);
            for (const time of this.vismapTimePoints) {
                if (time > max) break;
                const map = this.getAggVismap(time, routeId);
                for (let idx = 0; idx < aset.length; idx++) {
                    if (!map[idx] && aset[idx] === max) aset[idx] = time;
                }
            }
            return aset;
        }

        // The maximum time of an evaluation: the requested one, or the
        // maximum time computed by computeAll().
        _getMaxTime(maxTime) {
            if (maxTime === undefined || maxTime === null) {
                if (this._tMaxComputed !== null) return this._tMaxComputed;
                if (!this.vismapTimePoints.length) {
                    throw new VisMapValueError('No time points. Call setTimePoints() and computeAll() first.');
                }
                return this.vismapTimePoints[this.vismapTimePoints.length - 1];
            }
            this._checkTimeInComputedRange(maxTime);
            return maxTime;
        }

        // Position of a sign in the order in which the signs were added.
        _getSignPosition(signId) {
            if (!this.allSignDict.has(signId)) {
                throw new VisMapValueError('No sign with ID ' + signId + '. Available IDs: ' +
                    Array.from(this.allSignDict.keys()).join(', '));
            }
            return Array.from(this.allSignDict.keys()).indexOf(signId);
        }

        _getRoute(routeId) {
            if (!this.allRouteDict.has(routeId)) {
                throw new VisMapValueError('No route with ID ' + routeId + '. Available IDs: ' +
                    Array.from(this.allRouteDict.keys()).join(', '));
            }
            return this.allRouteDict.get(routeId);
        }

        /**
         * Get the points at which a route is evaluated, sampled along its
         * polyline in the resolution of the grid.
         * @returns {number[][]} (x, y) pairs
         */
        getRoutePoints(routeId) {
            return this._getRoute(routeId).sample(Math.min(this.cellSize[0], this.cellSize[1]));
        }

        /**
         * Get for each point of a route whether at least one sign of the
         * route is visible from it at a point in time.
         * @returns {Uint8Array} one value per point of getRoutePoints()
         */
        getRouteCoverage(routeId, time) {
            return this.coverageFromVismap(routeId, this.getAggVismap(time, routeId));
        }

        /**
         * Look up a vismap at the points of a route, e.g. the time aggregated
         * one to draw the route on it.
         * @returns {Uint8Array} one value per point of getRoutePoints()
         */
        coverageFromVismap(routeId, vismap) {
            const cells = this._routeCells(routeId);
            return Uint8Array.from(cells, idx => vismap[idx]);
        }

        // Grid cell of each point of a route.
        _routeCells(routeId) {
            const points = this.getRoutePoints(routeId);
            const xIdx = closestIndices(this.allXCoords, points.map(p => p[0]));
            const yIdx = closestIndices(this.allYCoords, points.map(p => p[1]));
            const nx = this._gridShape()[0];
            return Int32Array.from(xIdx, (i, k) => i + nx * yIdx[k]);
        }

        /**
         * Get for each point of a route the first time at which no sign of
         * the route is visible from it any more. Points from which a sign is
         * visible up to maxTime hold maxTime.
         * @param {number|string} routeId
         * @param {number} [maxTime] the maximum computed time if omitted
         * @returns {Float64Array} one time per point of getRoutePoints()
         */
        getRouteAset(routeId, maxTime) {
            const max = this._getMaxTime(maxTime);
            const aset = new Float64Array(this.getRoutePoints(routeId).length).fill(max);
            for (const time of this.vismapTimePoints) {
                if (time > max) break;
                const coverage = this.getRouteCoverage(routeId, time);
                for (let k = 0; k < aset.length; k++) {
                    if (!coverage[k] && aset[k] === max) aset[k] = time;
                }
            }
            return aset;
        }

        /**
         * Extent of the cells of the domain as [x_min, x_max, y_min, y_max].
         * The edges lie half a cell outside the outermost cell centres, so
         * that each pixel of a map covers its cell.
         */
        getDomainExtent() {
            this._gridShape();
            const x = this.allXCoords, y = this.allYCoords;
            return [
                x[0] - this.cellSize[0] / 2, x[x.length - 1] + this.cellSize[0] / 2,
                y[0] - this.cellSize[1] / 2, y[y.length - 1] + this.cellSize[1] / 2,
            ];
        }

        // The computation in steps, one per prepared sign and per sign and
        // time point, so that a caller can keep the page responsive in
        // between. Each step yields { phase, done, total }.
        *_computeSteps(options) {
            const { tMax, viewAngle = true, obstructions = true, aa = true } = options || {};
            const all = this.vismapTimePoints;
            const hasMax = tMax !== undefined && tMax !== null;
            const timePoints = hasMax ? all.filter(t => t <= tMax) : all;
            if (!timePoints.length) {
                if (!all.length) throw new VisMapValueError('No time points to compute. Call setTimePoints() first.');
                throw new VisMapValueError('No time point up to tMax=' + tMax + '. The time points are [' +
                    Array.from(all).join(', ') + '].');
            }
            const [nx, ny] = this._gridShape();
            const signIds = Array.from(this.allSignDict.keys());
            let finished = false;
            try {
                this._tMaxComputed = timePoints[timePoints.length - 1];
                this._signBitsByTime = [];
                this._prepared = new Map();
                this._rayCacheLeft = this.rayCacheLimit;
                for (let s = 0; s < signIds.length; s++) {
                    this._prepareSign(signIds[s], obstructions, viewAngle, aa);
                    yield { phase: 'signs', done: s + 1, total: signIds.length };
                }
                // One bit per sign and cell: as wide as the signs need
                const Words = signIds.length <= 8 ? Uint8Array : signIds.length <= 16 ? Uint16Array : Uint32Array;
                this._bitWords = Math.max(Math.ceil(signIds.length / 32), 1);
                const vismap = new Uint8Array(nx * ny);
                const steps = timePoints.length * Math.max(signIds.length, 1);
                const maps = [];
                for (let t = 0; t < timePoints.length; t++) {
                    const extco = this.getExtcoArrayAtTime(timePoints[t]);
                    const bits = new Words(nx * ny * this._bitWords);
                    for (let s = 0; s < signIds.length; s++) {
                        this._signVismap(signIds[s], extco, vismap);
                        const word = s >> 5, bit = 1 << (s & 31);
                        for (let idx = 0; idx < vismap.length; idx++) {
                            if (vismap[idx]) bits[idx * this._bitWords + word] |= bit;
                        }
                        yield { phase: 'times', done: t * signIds.length + s + 1, total: steps, time: timePoints[t] };
                    }
                    maps.push(bits);
                }
                this._signBitsByTime = maps;
                finished = true;
            } finally {
                // An abandoned computation leaves no half-finished maps behind
                if (!finished) this._invalidateResults();
            }
        }

        /**
         * Execute all required computations to generate the visibility maps
         * of all signs at all time points. The results of previous calls are
         * replaced.
         * @param {object} [options]
         * @param {number}  [options.tMax]              compute up to this time only
         * @param {boolean} [options.viewAngle=true]    consider the viewing direction of the signs
         * @param {boolean} [options.obstructions=true] consider obstructions
         * @param {boolean} [options.aa=true]           anti-aliased lines for the concealment
         * @param {function} [options.progress]         called with { phase, done, total } after each step
         */
        computeAll(options) {
            const progress = options && options.progress;
            for (const step of this._computeSteps(options)) if (typeof progress === 'function') progress(step);
        }

        /**
         * computeAll() that hands control back to the browser about every
         * 30 ms. `options.cancelled()` returning true abandons the
         * computation and discards its results.
         * @returns {Promise<boolean>} false if the computation was cancelled
         */
        async computeAllAsync(options) {
            const o = options || {};
            const steps = this._computeSteps(o);
            const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
            let last = now();
            for (let step = steps.next(); !step.done; step = steps.next()) {
                if (now() - last < 30) continue;
                if (typeof o.progress === 'function') o.progress(step.value);
                await new Promise(resolve => setTimeout(resolve, 0));
                last = now();
                if (typeof o.cancelled === 'function' && o.cancelled()) {
                    steps.return();
                    return false;
                }
            }
            return true;
        }

        /**
         * Calculate the local visibility C / K in the cell closest to (x, y)
         * at a certain time, from the local extinction coefficient.
         * @param {number} c contrast factor according to Jin
         */
        getLocalVisibility(time, x, y, c) {
            const nx = this._gridShape()[0];
            const refX = closestIndex(this.allXCoords, x), refY = closestIndex(this.allYCoords, y);
            const localExtco = this.getExtcoArrayAtTime(time)[refX + nx * refY];
            if (localExtco === 0) return this.maxVis;
            return Math.min(c / localExtco, this.maxVis);
        }

        /**
         * Calculate the visibility of a sign from the cell closest to (x, y)
         * at a certain time: smoke along the line of sight, then the readable
         * half-plane of the sign, then obstructions.
         */
        getVisibilityToSign(time, x, y, signId) {
            this._checkPrepared(signId);
            const sign = this.allSignDict.get(signId), prep = this._prepared.get(signId);
            const nx = this.fdsGridShape[0];
            const idx = closestIndex(this.allXCoords, x) + nx * closestIndex(this.allYCoords, y);
            const extco = this.getExtcoArrayAtTime(time);
            const viewAngle = prep.viewAngle ? prep.viewAngle[idx] : 1;
            if (prep.nonConcealed && !prep.nonConcealed[idx]) return viewAngle * this.maxVis * 0;
            // prep.cells is ascending, find the sight line of the cell
            let lo = 0, hi = prep.cells.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (prep.cells[mid] < idx) lo = mid + 1; else hi = mid;
            }
            return viewAngle * this._visibility(sign, this._meanExtco(prep, lo, extco, this._scratch()));
        }

        /**
         * Determine if a sign is visible from the cell closest to (x, y) at
         * a certain time, rounded to the closest computed time point.
         */
        signIsVisible(time, x, y, signId) {
            this._checkComputed();
            const timeId = this._timeId(time);
            const nx = this.fdsGridShape[0];
            const idx = closestIndex(this.allXCoords, x) + nx * closestIndex(this.allYCoords, y);
            return this._anyVisible(timeId, idx, this._signMask([signId]));
        }

        /** Calculate the distance from (x, y) to a sign. */
        getDistanceToSign(x, y, signId) {
            this._getSignPosition(signId);
            const sign = this.allSignDict.get(signId);
            const dx = x - sign.x, dy = y - sign.y;
            return Math.sqrt(dx * dx + dy * dy);
        }

        // Add or remove obstructions in a rectangle. The corners are moved
        // inwards by half a cell, so that a rectangle ending on a cell face
        // does not claim the next row of cells.
        _addVisualObject(x1, x2, y1, y2, obstructionsArray, status) {
            const nx = this._gridShape()[0];
            const refX1 = closestIndex(this.allXCoords, x1 + this.cellSize[0] / 2);
            const refX2 = closestIndex(this.allXCoords, x2 - this.cellSize[0] / 2) + 1;
            const refY1 = closestIndex(this.allYCoords, y1 + this.cellSize[1] / 2);
            const refY2 = closestIndex(this.allYCoords, y2 - this.cellSize[1] / 2) + 1;
            for (let j = refY1; j < refY2; j++) {
                for (let i = refX1; i < refX2; i++) obstructionsArray[i + nx * j] = status ? 1 : 0;
            }
        }

        /**
         * Remove obstructions from a rectangle of the grid, for everything
         * the sight lines are concerned with (e.g. a window in a wall).
         */
        addVisualHole(x1, x2, y1, y2) {
            this._gridShape();
            this.visualObjects.push([x1, x2, y1, y2, false]);
            this._addVisualObject(x1, x2, y1, y2, this.obstructionsArray, false);
            this._invalidateResults();
        }

        /**
         * Add an obstruction in a rectangle of the grid, for everything the
         * sight lines are concerned with (e.g. a curtain).
         */
        addVisualObstruction(x1, x2, y1, y2) {
            this._gridShape();
            this.visualObjects.push([x1, x2, y1, y2, true]);
            this._addVisualObject(x1, x2, y1, y2, this.obstructionsArray, true);
            this._invalidateResults();
        }
    }

    VisMap.FDSVISMAP_VERSION = FDSVISMAP_VERSION;
    VisMap.EXTCO_QUANTITIES = EXTCO_QUANTITIES;
    VisMap.OD_QUANTITIES = OD_QUANTITIES;

    // ── Public API ────────────────────────────────────────────────────────
    global.VisMap = VisMap;
    global.VisMapStyle = VisMapStyle;
    global.VisMapRoute = VisMapRoute;
    global.VisMapFds = VisMapFds;
    global.VisMapUtil = {
        line, lineAA, rayCells, pairwiseSum, closestIndex, closestIndices, viridis,
        ValueError: VisMapValueError, StateError: VisMapStateError,
    };
})(window);
