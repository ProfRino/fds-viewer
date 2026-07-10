/**
 * Slice Renderer for the Output page
 *
 * Builds a Three.js textured plane mesh for an FDS slice dataset and adds it
 * to the existing viewer's scene. Translates the prototype's standalone
 * slice viewer into an overlay that lives inside the greyscale geometry
 * viewer.
 *
 * Exposes (on window):
 *   SliceOverlay          — class that owns the slice mesh in the scene
 *   SliceFiles            — folder/group helpers (parse names, stitch parts)
 *   SliceColorMap         — colorMap(t, name) → [r,g,b]
 *   SliceUtil             — buildPlaneView, computePercentileRange, etc.
 *
 * FDS-to-Three coordinate convention used by our viewer:
 *   FDS X -> Three X,  FDS Z -> Three Y (up),  FDS Y -> Three Z
 * (matches viewer.js _xbToBox)
 */

(function (global) {
    'use strict';

    // ── Coordinate mapping (matches viewer.js convention) ─────────────────
    function fdsToScene(x, y, z) {
        return new THREE.Vector3(x, z, y);
    }

    // ── Color maps ────────────────────────────────────────────────────────
    const COLOR_MAPS = {
        diagnostic: [
            [0.00, [38, 124, 177]],
            [0.18, [57, 190, 201]],
            [0.42, [248, 232, 90]],
            [0.68, [244, 139, 48]],
            [1.00, [185, 28, 45]],
        ],
        inferno: [
            [0.00, [0, 0, 4]],
            [0.22, [76, 15, 109]],
            [0.45, [160, 44, 91]],
            [0.68, [229, 92, 45]],
            [0.86, [252, 175, 52]],
            [1.00, [252, 255, 164]],
        ],
        viridis: [
            [0.00, [68, 1, 84]],
            [0.25, [59, 82, 139]],
            [0.50, [33, 145, 140]],
            [0.75, [94, 201, 98]],
            [1.00, [253, 231, 37]],
        ],
        turbo: [
            [0.00, [48, 18, 59]],
            [0.17, [37, 82, 188]],
            [0.33, [33, 144, 141]],
            [0.50, [122, 209, 81]],
            [0.67, [253, 231, 37]],
            [0.83, [248, 118, 39]],
            [1.00, [174, 20, 2]],
        ],
        coolwarm: [
            [0.00, [59, 76, 192]],
            [0.50, [241, 239, 238]],
            [1.00, [180, 4, 38]],
        ],
        gray: [
            [0.00, [20, 24, 28]],
            [1.00, [245, 247, 250]],
        ],
    };

    function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function interpolateStops(t, stops) {
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i], b = stops[i + 1];
            if (t >= a[0] && t <= b[0]) {
                const local = (t - a[0]) / (b[0] - a[0] || 1);
                return [
                    Math.round(lerp(a[1][0], b[1][0], local)),
                    Math.round(lerp(a[1][1], b[1][1], local)),
                    Math.round(lerp(a[1][2], b[1][2], local)),
                ];
            }
        }
        return stops[stops.length - 1][1];
    }

    function colorMap(t, name) {
        return interpolateStops(clamp(t, 0, 1), COLOR_MAPS[name] || COLOR_MAPS.inferno);
    }

    // ── Texture canvas (rasterise values to RGBA pixels) ──────────────────
    function makeTextureCanvas(values, width, height, min, max, mapName, constantRange) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(width, 1);
        canvas.height = Math.max(height, 1);
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(canvas.width, canvas.height);
        const span = max - min || 1;
        for (let y = 0; y < height; y++) {
            const sourceY = height - 1 - y;
            for (let x = 0; x < width; x++) {
                const value = values[x + width * sourceY];
                const t = constantRange ? 0.5 : clamp((value - min) / span, 0, 1);
                const c = colorMap(t, mapName);
                const dst = 4 * (x + width * y);
                image.data[dst]     = c[0];
                image.data[dst + 1] = c[1];
                image.data[dst + 2] = c[2];
                image.data[dst + 3] = Number.isFinite(value) ? 255 : 0;
            }
        }
        ctx.putImageData(image, 0, 0);
        return canvas;
    }

    // ── Value extraction + stats ──────────────────────────────────────────
    function index3d(i, j, k, nx, ny) { return i + nx * (j + ny * k); }

    function extractPlaneValues(values, dataset, view) {
        const [nx, ny, nz] = dataset.dims;
        const out = new Float32Array(view.width * view.height);
        if (view.label === 'Line strip') {
            for (let p = 0; p < out.length; p++) {
                const i = nx > 1 ? p : 0;
                const j = nx === 1 && ny > 1 ? p : 0;
                const k = nx === 1 && ny === 1 && nz > 1 ? p : 0;
                out[p] = values[index3d(i, j, k, nx, ny)];
            }
            return out;
        }
        if (view.kind === 'yz') {
            for (let k = 0; k < nz; k++)
                for (let j = 0; j < ny; j++)
                    out[j + ny * k] = values[index3d(0, j, k, nx, ny)];
        } else if (view.kind === 'xz') {
            for (let k = 0; k < nz; k++)
                for (let i = 0; i < nx; i++)
                    out[i + nx * k] = values[index3d(i, 0, k, nx, ny)];
        } else {
            const k = view.slabIndex || 0;
            for (let j = 0; j < ny; j++)
                for (let i = 0; i < nx; i++)
                    out[i + nx * j] = values[index3d(i, j, k, nx, ny)];
        }
        return out;
    }

    function computeStats(values) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return { min, max };
    }

    function computePercentileRange(values, low, high) {
        const finite = [];
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (Number.isFinite(v)) finite.push(v);
        }
        if (finite.length === 0) return { min: NaN, max: NaN };
        finite.sort((a, b) => a - b);
        const lowIdx  = Math.floor((finite.length - 1) * low);
        const highIdx = Math.ceil((finite.length - 1) * high);
        return {
            min: finite[clamp(lowIdx, 0, finite.length - 1)],
            max: finite[clamp(highIdx, 0, finite.length - 1)],
        };
    }

    function hasUsefulRange(stats) {
        if (!Number.isFinite(stats.min) || !Number.isFinite(stats.max)) return false;
        const range = Math.abs(stats.max - stats.min);
        const scale = Math.max(Math.abs(stats.min), Math.abs(stats.max), 1);
        return range > scale * 1e-5;
    }

    function findInitialFrame(dataset) {
        if (!dataset || dataset.frames.length <= 1) return 0;
        const sampleCount = Math.min(dataset.frames.length, 120);
        for (let s = 0; s < sampleCount; s++) {
            const index = Math.round((dataset.frames.length - 1) * s / Math.max(sampleCount - 1, 1));
            const stats = computeStats(dataset.getFrameData(index));
            if (hasUsefulRange(stats)) return index;
        }
        return 0;
    }

    // ── Plane view (geometry placement) ───────────────────────────────────
    function meshCoordinate(min, max, count, index) {
        if (!Number.isFinite(count) || count === 0) return min;
        return min + (max - min) * index / count;
    }

    /** World coordinate of grid node `index` along `axis` (0=X, 1=Y, 2=Z).
     *  Uses the mesh's TRN node-coordinate table when available (exact, and
     *  correct for stretched grids); falls back to linear XB interpolation. */
    function meshAxisCoordinate(mesh, axis, index) {
        const trn = mesh.trn && mesh.trn[axis];
        if (trn && Number.isFinite(trn[index])) return trn[index];
        return meshCoordinate(mesh.xb[axis * 2], mesh.xb[axis * 2 + 1], mesh.ijk[axis], index);
    }

    function unionBounds(a, b) {
        return {
            x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
            y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
            z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1),
        };
    }

    function physicalBoundsForPart(dataset, mesh) {
        const idx = dataset.indices;
        return {
            x0: meshAxisCoordinate(mesh, 0, idx.i1),
            x1: meshAxisCoordinate(mesh, 0, idx.i2),
            y0: meshAxisCoordinate(mesh, 1, idx.j1),
            y1: meshAxisCoordinate(mesh, 1, idx.j2),
            z0: meshAxisCoordinate(mesh, 2, idx.k1),
            z1: meshAxisCoordinate(mesh, 2, idx.k2),
        };
    }

    function physicalBoundsForDataset(dataset, fdsContext, view) {
        const pieces = dataset.parts
            ? dataset.parts.map(p => ({ meshIndex: p.meshIndex, dataset: p.dataset }))
            : [{ meshIndex: dataset.sourceMeshIndex || 1, dataset }];

        let bounds = null;
        for (const piece of pieces) {
            const mesh = fdsContext.meshes[piece.meshIndex - 1];
            if (!mesh || !mesh.ijk || !mesh.xb) continue;
            const partBounds = physicalBoundsForPart(piece.dataset, mesh);
            bounds = bounds ? unionBounds(bounds, partBounds) : partBounds;
        }
        if (!bounds) return null;

        const physical = { x0: bounds.x0, x1: bounds.x1, y0: bounds.y0, y1: bounds.y1, z0: bounds.z0, z1: bounds.z1 };
        if (view.kind === 'yz')       physical.slabOffset = bounds.x0;
        else if (view.kind === 'xz')  physical.slabOffset = bounds.y0;
        else                          physical.slabOffset = view.slabCount && view.slabCount > 1
            ? bounds.z0 + (bounds.z1 - bounds.z0) * (view.slabIndex / Math.max(view.slabCount - 1, 1))
            : bounds.z0;
        return physical;
    }

    function applyPhysicalPlacement(view, dataset, fdsContext) {
        if (!fdsContext || !fdsContext.meshes || fdsContext.meshes.length === 0) return view;
        const physical = physicalBoundsForDataset(dataset, fdsContext, view);
        if (!physical) return view;
        view.physical = physical;
        view.label = view.label + ' in FDS space';
        return view;
    }

    function buildPlaneView(dataset, requestedSlab, fdsContext) {
        const [nx, ny, nz] = dataset.dims;
        const nonSingle = [nx, ny, nz].filter(v => v > 1).length;
        const maxSpan = Math.max(nx - 1, ny - 1, nz - 1, 1);
        const scale = 7 / maxSpan;
        let view;
        if (nonSingle <= 1) {
            const width = Math.max(nx, ny, nz);
            view = { kind: 'xy', label: 'Line strip', width, height: 1, nx: width, ny: 1, nz: 1, scale, slabCount: 1 };
        } else if (nx === 1) {
            view = { kind: 'yz', label: 'YZ plane', width: ny, height: nz, nx, ny, nz, scale, slabCount: 1 };
        } else if (ny === 1) {
            view = { kind: 'xz', label: 'XZ plane', width: nx, height: nz, nx, ny, nz, scale, slabCount: 1 };
        } else if (nz === 1) {
            view = { kind: 'xy', label: 'XY plane', width: nx, height: ny, nx, ny, nz, scale, slabCount: 1 };
        } else {
            const slab = clamp(requestedSlab, 0, nz - 1);
            view = {
                kind: 'xy',
                label: 'XY volume slab ' + (slab + 1) + '/' + nz,
                width: nx, height: ny, nx, ny, nz, scale,
                slabCount: nz,
                slabIndex: slab,
                slabOffset: slab - (nz - 1) / 2,
            };
        }
        return applyPhysicalPlacement(view, dataset, fdsContext);
    }

    // ── File grouping (folder mode) ───────────────────────────────────────
    function parseSliceFilename(fileName) {
        const base = fileName.split(/[\\/]/).pop();
        // Multi-mesh FDS output: CHID_meshIndex_sliceIndex.sf
        let match = /^(.+)_(\d+)_(\d+)\.sf$/i.exec(base);
        if (match) {
            return { chid: match[1], meshIndex: Number(match[2]), sliceIndex: Number(match[3]) };
        }
        // Single-mesh FDS output: CHID_sliceIndex.sf (meshIndex defaults to 1)
        match = /^(.+)_(\d+)\.sf$/i.exec(base);
        if (match) {
            return { chid: match[1], sliceIndex: Number(match[2]), meshIndex: 1 };
        }
        return null;
    }

    function sliceGroupKey(info) { return info.chid + '::' + info.sliceIndex; }

    async function readSliceHeader(file) {
        try {
            const buf = await file.slice(0, 8192).arrayBuffer();
            return FdsSliceReader.parseHeader(buf);
        } catch (e) {
            console.warn('Could not read header for ' + file.name, e);
            return null;
        }
    }

    function slicePlaneLabel(indices) {
        if (!indices) return 'unknown plane';
        if (indices.i1 === indices.i2) return 'YZ plane, X index ' + indices.i1;
        if (indices.j1 === indices.j2) return 'XZ plane, Y index ' + indices.j1;
        if (indices.k1 === indices.k2) return 'XY plane, Z index ' + indices.k1;
        return '3D slice volume';
    }

    function sliceGroupLabel(group) {
        const header = group.header;
        const fileCount = group.items.length + ' file' + (group.items.length === 1 ? '' : 's');
        if (!header) return group.chid + ' | Slice ' + group.sliceIndex + ' | ' + fileCount;
        const quantity = header.quantity || 'Slice';
        const units = header.units ? ' (' + header.units + ')' : '';
        return quantity + units + ' | ' + slicePlaneLabel(header.indices) +
            ' | Slice ' + group.sliceIndex + ' | ' + fileCount;
    }

    async function describeSliceGroups(files) {
        const groupsByKey = new Map();
        for (const file of files) {
            const info = parseSliceFilename(file.name);
            if (!info) continue;
            const key = sliceGroupKey(info);
            if (!groupsByKey.has(key))
                groupsByKey.set(key, { key, chid: info.chid, sliceIndex: info.sliceIndex, items: [], header: null, label: '' });
            groupsByKey.get(key).items.push({ file, info });
        }
        const groups = Array.from(groupsByKey.values()).sort(
            (a, b) => a.chid.localeCompare(b.chid) || a.sliceIndex - b.sliceIndex);
        for (const group of groups) {
            group.items.sort((a, b) => a.info.meshIndex - b.info.meshIndex);
            group.header = await readSliceHeader(group.items[0].file);
            group.label = sliceGroupLabel(group);
        }
        return groups;
    }

    // ── Multi-mesh stitching ──────────────────────────────────────────────
    function chooseStitchAxis(dims) {
        if (dims[2] > 1) return 2;
        if (dims[1] > 1) return 1;
        return 0;
    }

    /**
     * Compute the physical (FDS world coords) extent of a part's slice cells.
     * Returns { axis: 0|1|2, fixedValue, min, max } for the FIXED axis (the
     * one with dim=1) and per-slice-axis world bounds. Returns null if the
     * mesh metadata isn't available.
     *
     * This is the key the stitcher uses to:
     *   (a) detect duplicate slice files that represent the SAME physical
     *       plane (e.g. mesh 1's back face = mesh 3's front face at Y=5)
     *   (b) determine the correct axis to concatenate along — index ranges
     *       alone can't tell us because FDS writes per-mesh-LOCAL indices.
     */
    function physicalSliceFootprint(part, fdsContext) {
        const ds = part.dataset;
        const mesh = fdsContext && fdsContext.meshes
            ? fdsContext.meshes[part.meshIndex - 1]
            : null;
        if (!mesh || !mesh.ijk || !mesh.xb) return null;
        const idx = ds.indices;
        // Convert per-mesh integer indices → world coordinates
        return {
            xMin: meshAxisCoordinate(mesh, 0, idx.i1),
            xMax: meshAxisCoordinate(mesh, 0, idx.i2),
            yMin: meshAxisCoordinate(mesh, 1, idx.j1),
            yMax: meshAxisCoordinate(mesh, 1, idx.j2),
            zMin: meshAxisCoordinate(mesh, 2, idx.k1),
            zMax: meshAxisCoordinate(mesh, 2, idx.k2),
        };
    }

    function combinedIndices(indices, dims) {
        return {
            i1: indices.i1, i2: indices.i1 + dims[0] - 1,
            j1: indices.j1, j2: indices.j1 + dims[1] - 1,
            k1: indices.k1, k2: indices.k1 + dims[2] - 1,
        };
    }

    function frameTimeKey(time) { return Number(time).toFixed(5); }

    function frameTimeMap(frames) {
        const map = new Map();
        for (let i = 0; i < frames.length; i++) {
            const key = frameTimeKey(frames[i].time);
            if (!map.has(key)) map.set(key, i);
        }
        return map;
    }

    function alignPartFrames(parts) {
        const counts = parts.map(p => p.dataset.frames.length);
        const allMatch = counts.every(c => c === counts[0]);
        if (allMatch) {
            for (const p of parts) p.frameMap = null;
            return { frames: parts[0].dataset.frames, note: '' };
        }
        const maps = parts.map(p => frameTimeMap(p.dataset.frames));
        let commonKeys = new Set(maps[0].keys());
        for (const m of maps.slice(1))
            commonKeys = new Set(Array.from(commonKeys).filter(k => m.has(k)));
        const frames = [];
        const frameMaps = parts.map(() => []);
        for (let fi = 0; fi < parts[0].dataset.frames.length; fi++) {
            const key = frameTimeKey(parts[0].dataset.frames[fi].time);
            if (!commonKeys.has(key)) continue;
            frames.push(parts[0].dataset.frames[fi]);
            for (let pi = 0; pi < parts.length; pi++) frameMaps[pi].push(maps[pi].get(key));
        }
        if (frames.length === 0) throw new Error('Selected slice files have no common time frames.');
        for (let pi = 0; pi < parts.length; pi++) parts[pi].frameMap = frameMaps[pi];
        return {
            frames,
            note: 'Aligned ' + frames.length + ' common frame(s) from mesh pieces with ' +
                  Math.min(...counts) + ' to ' + Math.max(...counts) + ' frames.',
        };
    }

    function stitchFrame(parts, frameIndex, axis, dims) {
        const [nx, ny, nz] = dims;
        const out = new Float32Array(nx * ny * nz);
        let offset = 0;
        for (let pi = 0; pi < parts.length; pi++) {
            const ds = parts[pi].dataset;
            const srcIdx = parts[pi].frameMap ? parts[pi].frameMap[frameIndex] : frameIndex;
            const values = ds.getFrameData(srcIdx);
            const [px, py, pz] = ds.dims;
            const start = pi === 0 ? 0 : 1;
            if (axis === 2) {
                for (let k = start; k < pz; k++)
                    for (let j = 0; j < py; j++)
                        for (let i = 0; i < px; i++)
                            out[index3d(i, j, offset + k - start, nx, ny)] = values[index3d(i, j, k, px, py)];
                offset += pz - start;
            } else if (axis === 1) {
                for (let k = 0; k < pz; k++)
                    for (let j = start; j < py; j++)
                        for (let i = 0; i < px; i++)
                            out[index3d(i, offset + j - start, k, nx, ny)] = values[index3d(i, j, k, px, py)];
                offset += py - start;
            } else {
                for (let k = 0; k < pz; k++)
                    for (let j = 0; j < py; j++)
                        for (let i = start; i < px; i++)
                            out[index3d(offset + i - start, j, k, nx, ny)] = values[index3d(i, j, k, px, py)];
                offset += px - start;
            }
        }
        return out;
    }

    function combineSliceDatasets(parts, fdsContext) {
        if (parts.length === 0) throw new Error('No slice datasets to combine.');
        const first = parts[0].dataset;
        // Quantity sanity check
        for (const part of parts) {
            const ds = part.dataset;
            if (ds.quantity !== first.quantity || ds.shortName !== first.shortName)
                throw new Error('Selected files do not contain the same slice quantity.');
        }

        // ── Physical-aware path ─────────────────────────────────────────
        // When fdsContext is available we know each mesh's XB and IJK, so we
        // can convert each part's per-mesh indices into world coordinates.
        // From that we can (1) deduplicate parts that represent the SAME
        // physical plane (boundary face shared between meshes) and (2) pick
        // the stitch axis from how the surviving parts tile physically,
        // rather than guessing from dims.
        if (fdsContext && fdsContext.meshes && fdsContext.meshes.length) {
            const placed = [];
            for (const part of parts) {
                const fp = physicalSliceFootprint(part, fdsContext);
                if (fp) placed.push({ part, fp });
            }
            if (placed.length === parts.length) {
                const KEY_PRECISION = 1e-3;
                const k = v => Math.round(v / KEY_PRECISION) * KEY_PRECISION;
                const seen = new Map();
                for (const p of placed) {
                    const key = [p.fp.xMin, p.fp.xMax, p.fp.yMin, p.fp.yMax, p.fp.zMin, p.fp.zMax].map(k).join('|');
                    // First file wins; later duplicates are silently dropped.
                    if (!seen.has(key)) seen.set(key, p);
                }
                const unique = Array.from(seen.values());

                if (unique.length === 1) {
                    // All parts described the same physical plane — return the lone dataset.
                    unique[0].part.dataset.sourceMeshIndex = unique[0].part.meshIndex;
                    return unique[0].part.dataset;
                }

                // Determine the stitch axis by checking which world coordinate
                // actually varies across the unique parts.
                const ranges = ['xMin','xMax','yMin','yMax','zMin','zMax'].reduce((o, key) => {
                    let min = Infinity, max = -Infinity;
                    for (const u of unique) { if (u.fp[key] < min) min = u.fp[key]; if (u.fp[key] > max) max = u.fp[key]; }
                    o[key] = { min, max };
                    return o;
                }, {});
                const xVaries = (ranges.xMin.max - ranges.xMin.min) > KEY_PRECISION || (ranges.xMax.max - ranges.xMax.min) > KEY_PRECISION;
                const yVaries = (ranges.yMin.max - ranges.yMin.min) > KEY_PRECISION || (ranges.yMax.max - ranges.yMax.min) > KEY_PRECISION;
                const zVaries = (ranges.zMin.max - ranges.zMin.min) > KEY_PRECISION || (ranges.zMax.max - ranges.zMax.min) > KEY_PRECISION;
                const varying = [xVaries, yVaries, zVaries];
                const varyingAxes = [0, 1, 2].filter(a => varying[a]);
                if (varyingAxes.length === 1) {
                    const axis = varyingAxes[0];
                    // Sort parts along the stitch axis so the concatenation
                    // matches physical order regardless of file ordering.
                    const sortKey = axis === 0 ? 'xMin' : (axis === 1 ? 'yMin' : 'zMin');
                    unique.sort((a, b) => a.fp[sortKey] - b.fp[sortKey]);
                    const orderedParts = unique.map(u => u.part);
                    return _stitchOnAxis(orderedParts, axis);
                }
                if (varyingAxes.length === 2) {
                    // Meshes tile the slice plane in 2D (rows × columns),
                    // e.g. a 4×2 mesh arrangement cut by one horizontal slice.
                    const stitched = _stitch2DGrid(unique, varyingAxes[0], varyingAxes[1], KEY_PRECISION);
                    if (stitched) return stitched;
                }
                // Fall through to legacy stitching for unknown cases
            }
        }

        // ── Legacy path (no fdsContext) ─────────────────────────────────
        const axis = chooseStitchAxis(first.dims);
        return _stitchOnAxis(parts, axis);
    }

    /** Assemble `parts` into one stitched dataset along `axis` (0=I, 1=J, 2=K).
     *  Validates that dims on the non-stitch axes match. */
    function _stitchOnAxis(parts, axis) {
        const first = parts[0].dataset;
        const dims = first.dims.slice();
        dims[axis] = first.dims[axis] + parts.slice(1).reduce((s, p) => s + p.dataset.dims[axis] - 1, 0);
        for (const part of parts) {
            const ds = part.dataset;
            for (let i = 0; i < 3; i++)
                if (i !== axis && ds.dims[i] !== first.dims[i])
                    throw new Error('Selected slice files are not aligned for simple stitching.');
        }
        const frameAlignment = alignPartFrames(parts);
        return {
            quantity: first.quantity, shortName: first.shortName, units: first.units,
            indices: combinedIndices(first.indices, dims),
            dims, valueCount: dims[0] * dims[1] * dims[2],
            frames: frameAlignment.frames, frameAlignmentNote: frameAlignment.note,
            parts, stitchAxis: axis,
            displayName: parts[0].fileName.replace(/_\d+_(\d+)\.sf$/i, '_all_$1.sf'),
            getFrameData(frameIndex) { return stitchFrame(parts, frameIndex, axis, dims); },
        };
    }

    /** Assemble parts that tile the slice plane in a 2D grid. `placed` is the
     *  deduplicated [{ part, fp }] list; `axisA`/`axisB` are the two varying
     *  axes (0=I/X, 1=J/Y, 2=K/Z). Rows are formed along axisB and each row is
     *  stitched along axisA, then the row results are stitched along axisB.
     *  Returns null when the parts don't form a complete rectangular grid, so
     *  the caller can fall back to legacy stitching. */
    function _stitch2DGrid(placed, axisA, axisB, tolerance) {
        const minKeys = ['xMin', 'yMin', 'zMin'];
        const rowsByStart = new Map();
        for (const p of placed) {
            const key = Math.round(p.fp[minKeys[axisB]] / tolerance) * tolerance;
            if (!rowsByStart.has(key)) rowsByStart.set(key, []);
            rowsByStart.get(key).push(p);
        }
        const rows = Array.from(rowsByStart.keys()).sort((a, b) => a - b)
            .map(k => rowsByStart.get(k).sort((a, b) => a.fp[minKeys[axisA]] - b.fp[minKeys[axisA]]));

        // Every row must have the same columns at the same positions.
        const colCount = rows[0].length;
        if (rows.length * colCount !== placed.length) return null;
        for (const row of rows) {
            if (row.length !== colCount) return null;
            for (let c = 0; c < colCount; c++) {
                if (Math.abs(row[c].fp[minKeys[axisA]] - rows[0][c].fp[minKeys[axisA]]) > tolerance) return null;
            }
        }

        try {
            const rowParts = rows.map(row => ({
                dataset: _stitchOnAxis(row.map(u => u.part), axisA),
                fileName: row[0].part.fileName,
                meshIndex: row[0].part.meshIndex,
            }));
            const combined = _stitchOnAxis(rowParts, axisB);
            // Expose the flat per-mesh parts (not the synthetic row datasets)
            // so physical placement can union the real mesh footprints.
            combined.parts = placed.map(p => p.part);
            return combined;
        } catch (e) {
            console.warn('2D slice stitching failed, falling back to legacy stitching.', e);
            return null;
        }
    }

    // ── FDS context from a Smokeview (.smv) file ──────────────────────────
    // The .smv is written by FDS itself, so its GRID / PDIM / TRN records are
    // the authoritative description of the grid the simulation actually ran
    // on. The .fds input can disagree (edited after the run, MULT expansion,
    // stretched grids), which mis-places and mis-sizes slices, so a context
    // built from the .smv is preferred over one parsed from the .fds.
    function parseSmvTrnAxis(lines, start, nodeCount) {
        // TRN block layout: a count of stretch entries, that many stretch
        // lines, then nodeCount+1 lines of "index coordinate".
        let s = start;
        const stretchCount = parseInt((lines[s] || '').trim(), 10);
        s += 1 + (Number.isFinite(stretchCount) && stretchCount > 0 ? stretchCount : 0);
        const coords = [];
        for (; s < lines.length && coords.length <= nodeCount; s++) {
            const m = /^\s*(\d+)\s+([-+0-9.Ee]+)\s*$/.exec(lines[s]);
            if (!m) break;
            coords[Number(m[1])] = Number(m[2]);
        }
        return coords.length === nodeCount + 1 && coords.every(Number.isFinite) ? coords : null;
    }

    function fdsContextFromSmvText(text, fileName) {
        const lines = String(text).split(/\r?\n/);
        const meshes = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('GRID')) continue;
            const id = line.replace(/^GRID\s*/i, '').trim() || 'mesh_' + (meshes.length + 1);
            const ijk = (lines[i + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite).slice(0, 3);
            if (ijk.length < 3) continue;
            let xb = null;
            const trn = [null, null, null];
            for (let s = i + 2; s < lines.length; s++) {
                const keyword = lines[s].trim();
                if (keyword.startsWith('GRID')) break;
                if (keyword === 'PDIM') {
                    const values = (lines[s + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
                    if (values.length >= 6) xb = values.slice(0, 6);
                } else if (/^TRN[XYZ]$/.test(keyword)) {
                    const axis = { TRNX: 0, TRNY: 1, TRNZ: 2 }[keyword];
                    trn[axis] = parseSmvTrnAxis(lines, s + 1, ijk[axis]);
                }
                if (xb && trn[0] && trn[1] && trn[2]) break;
            }
            if (xb) meshes.push({ id, ijk, xb, trn });
        }
        if (meshes.length === 0) return null;
        return { fileName: fileName || 'smv', meshes, source: 'smv' };
    }

    // ── FDS context from our parser's data ────────────────────────────────
    function fdsContextFromParsedData(parsedData) {
        if (!parsedData || !parsedData.meshes) return null;
        const meshes = parsedData.meshes
            .filter(m => m.xb && m.ijk)
            .map(m => ({ id: m.id || '', ijk: m.ijk.slice(), xb: m.xb.slice() }));
        if (meshes.length === 0) return null;
        return { fileName: parsedData.head && parsedData.head.CHID || 'fds', meshes };
    }

    // ── SliceOverlay: lives in a passed-in Three.js scene ─────────────────
    class SliceOverlay {
        constructor(scene) {
            this.scene = scene;
            this.dataset = null;
            this.view = null;
            this.frameIndex = 0;
            this.mapName = 'diagnostic';
            this.opacity = 1.0;
            this.rangeMin = null;
            this.rangeMax = null;
            this.autoRange = true;
            this.robustRange = true;
            // 'basic'  — depthTest off, renderOrder high → slice always wins.
            // 'depth' — depthTest on, lower renderOrder → OBSTs in front
            //           of the slice plane occlude it correctly.
            this.renderMode = 'basic';

            this.mesh = null;
            this.outline = null;
        }

        /** Toggle the slice between "always on top" (basic) and proper depth
         *  occlusion (solid-aware). Re-applies state to the live mesh + outline
         *  if a slice is already loaded so the change is instant. */
        setRenderMode(mode) {
            this.renderMode = (mode === 'depth') ? 'depth' : 'basic';
            const depthOn = this.renderMode === 'depth';
            if (this.mesh && this.mesh.material) {
                this.mesh.material.depthTest = depthOn;
                this.mesh.material.needsUpdate = true;
                this.mesh.renderOrder = depthOn ? 1 : 100;
            }
            if (this.outline && this.outline.material) {
                this.outline.material.depthTest = depthOn;
                this.outline.material.needsUpdate = true;
                this.outline.renderOrder = depthOn ? 2 : 101;
            }
        }

        setDataset(dataset, fdsContext) {
            this.dataset = dataset;
            this.fdsContext = fdsContext;
            this.frameIndex = findInitialFrame(dataset);
            this.view = buildPlaneView(dataset, 0, fdsContext);
            this._rebuildMesh();
            this._render();
        }

        setFrame(idx) {
            if (!this.dataset) return;
            this.frameIndex = clamp(idx, 0, this.dataset.frames.length - 1);
            this._render();
        }

        setColorMap(name) {
            this.mapName = name;
            this._render();
        }

        setOpacity(opacity) {
            this.opacity = clamp(opacity, 0, 1);
            if (this.mesh) {
                this.mesh.material.opacity = this.opacity;
                this.mesh.material.needsUpdate = true;
            }
        }

        setAutoRange(enabled) { this.autoRange = !!enabled; this._render(); }
        setRobustRange(enabled) { this.robustRange = !!enabled; this._render(); }
        setManualRange(min, max) {
            this.rangeMin = Number.isFinite(min) ? min : null;
            this.rangeMax = Number.isFinite(max) ? max : null;
            this._render();
        }

        dispose() {
            if (this.mesh) {
                if (this.mesh.material.map) this.mesh.material.map.dispose();
                this.mesh.geometry.dispose();
                this.mesh.material.dispose();
                this.scene.remove(this.mesh);
                this.mesh = null;
            }
            if (this.outline) {
                this.outline.geometry.dispose();
                this.outline.material.dispose();
                this.scene.remove(this.outline);
                this.outline = null;
            }
            this.dataset = null;
            this.view = null;
        }

        getCurrentRange() {
            if (!this.dataset || !this.view) return { min: 0, max: 1 };
            const values = this.dataset.getFrameData(this.frameIndex);
            const plane = extractPlaneValues(values, this.dataset, this.view);
            return this._resolveRange(plane);
        }

        _resolveRange(planeValues) {
            if (!this.autoRange && Number.isFinite(this.rangeMin) && Number.isFinite(this.rangeMax)) {
                return { min: this.rangeMin, max: this.rangeMax };
            }
            if (this.robustRange) {
                const robust = computePercentileRange(planeValues, 0.02, 0.98);
                if (Number.isFinite(robust.min) && Number.isFinite(robust.max) && robust.max > robust.min) return robust;
            }
            return computeStats(planeValues);
        }

        _rebuildMesh() {
            // Remove old mesh
            if (this.mesh) {
                if (this.mesh.material.map) this.mesh.material.map.dispose();
                this.mesh.geometry.dispose();
                this.mesh.material.dispose();
                this.scene.remove(this.mesh);
                this.mesh = null;
            }
            if (this.outline) {
                this.outline.geometry.dispose();
                this.outline.material.dispose();
                this.scene.remove(this.outline);
                this.outline = null;
            }
            if (!this.view) return;

            const geometry = this._buildGeometry(this.view);
            // Match the current renderMode at material creation so freshly
            // loaded slices honour the dropdown without needing a re-toggle.
            const depthOn = this.renderMode === 'depth';
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: this.opacity,
                side: THREE.DoubleSide,
                depthWrite: false,
                depthTest: depthOn,
            });
            this.mesh = new THREE.Mesh(geometry, material);
            this.mesh.renderOrder = depthOn ? 1 : 100;
            this.mesh._isSliceOverlay = true; // flag so viewer.setGrayscale skips it
            this.scene.add(this.mesh);

            const outlineMaterial = new THREE.LineBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.85, depthTest: depthOn,
            });
            this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), outlineMaterial);
            this.outline.renderOrder = depthOn ? 2 : 101;
            this.outline._isSliceOverlay = true;
            this.scene.add(this.outline);

            // Honour an existing "Slices" layer-toggle so loading a new slice
            // while the toggle is off doesn't pop a stale overlay back into view.
            // viewer.js writes scene.userData.slicesVisible from setVisibility.
            if (this.scene.userData && this.scene.userData.slicesVisible === false) {
                this.mesh.visible = false;
                this.outline.visible = false;
            }
        }

        _buildGeometry(view) {
            const b = this._viewBounds(view);
            let positions;
            if (view.kind === 'yz') {
                const x = b.slabOffset;
                positions = this._quadPositions(view, [
                    [x, b.y0, b.z0], [x, b.y1, b.z0], [x, b.y1, b.z1], [x, b.y0, b.z1],
                ]);
            } else if (view.kind === 'xz') {
                const y = b.slabOffset;
                positions = this._quadPositions(view, [
                    [b.x0, y, b.z0], [b.x1, y, b.z0], [b.x1, y, b.z1], [b.x0, y, b.z1],
                ]);
            } else {
                const z = b.slabOffset;
                positions = this._quadPositions(view, [
                    [b.x0, b.y0, z], [b.x1, b.y0, z], [b.x1, b.y1, z], [b.x0, b.y1, z],
                ]);
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
            geometry.setIndex([0, 1, 2, 0, 2, 3]);
            geometry.computeVertexNormals();
            return geometry;
        }

        _quadPositions(view, points) {
            const out = [];
            for (const p of points) {
                const v = view.physical ? fdsToScene(p[0], p[1], p[2]) : new THREE.Vector3(p[0], p[1], p[2]);
                out.push(v.x, v.y, v.z);
            }
            return out;
        }

        _viewBounds(view) {
            if (view.physical) {
                return {
                    x0: view.physical.x0, x1: view.physical.x1,
                    y0: view.physical.y0, y1: view.physical.y1,
                    z0: view.physical.z0, z1: view.physical.z1,
                    slabOffset: view.physical.slabOffset || 0,
                };
            }
            const scale = view.scale;
            const xSpan = Math.max(view.nx - 1, 1) * scale;
            const ySpan = Math.max(view.ny - 1, 1) * scale;
            const zSpan = Math.max(view.nz - 1, 1) * scale;
            return {
                x0: -xSpan / 2, x1: xSpan / 2,
                y0: -ySpan / 2, y1: ySpan / 2,
                z0: -zSpan / 2, z1: zSpan / 2,
                slabOffset: (view.slabOffset || 0) * scale,
            };
        }

        _render() {
            if (!this.mesh || !this.dataset || !this.view) return;
            const values = this.dataset.getFrameData(this.frameIndex);
            const plane = extractPlaneValues(values, this.dataset, this.view);
            const range = this._resolveRange(plane);
            const min = Number.isFinite(range.min) ? range.min : 0;
            const max = Number.isFinite(range.max) ? range.max : (min + 1);
            const canvas = makeTextureCanvas(plane, this.view.width, this.view.height,
                min, max, this.mapName, max === min);

            const tex = new THREE.CanvasTexture(canvas);
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.NearestFilter;
            tex.flipY = false;
            if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
            const prev = this.mesh.material.map;
            this.mesh.material.map = tex;
            this.mesh.material.needsUpdate = true;
            if (prev) prev.dispose();

            // Notify listeners that rendering finished (used to update legend, etc.)
            if (typeof this.onAfterRender === 'function') {
                this.onAfterRender({ min, max, frameIndex: this.frameIndex, time: this.dataset.frames[this.frameIndex].time });
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────
    global.SliceOverlay = SliceOverlay;
    global.SliceFiles = {
        parseSliceFilename, sliceGroupKey, describeSliceGroups,
        combineSliceDatasets,
        fdsContextFromParsedData,
        fdsContextFromSmvText,
    };
    global.SliceColorMap = { colorMap, COLOR_MAPS };
    global.SliceUtil = {
        buildPlaneView, extractPlaneValues, makeTextureCanvas,
        computeStats, computePercentileRange, findInitialFrame, hasUsefulRange,
    };
})(window);
