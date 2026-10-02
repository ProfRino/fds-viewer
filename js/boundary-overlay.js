// Boundary (BNDF) overlay for the FDS Viewer standalone Output page.
// Ported from New Feature Prototype/boundary_viewer (BoundaryViewer3D + app.js)
// adapted to overlay onto the main viewer's scene rather than owning its own.
(function (global) {
    'use strict';

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function fdsToScene(x, y, z) { return new THREE.Vector3(x, z, -y); }
    function lerp(a, b, t) { return a + (b - a) * t; }

    // ── Colour maps ──────────────────────────────────────────────────────────
    function interpolateStops(stops, t) {
        const scaled = clamp(t, 0, 1) * (stops.length - 1);
        const idx = Math.min(Math.floor(scaled), stops.length - 2);
        const local = scaled - idx;
        return [
            lerp(stops[idx][0], stops[idx + 1][0], local),
            lerp(stops[idx][1], stops[idx + 1][1], local),
            lerp(stops[idx][2], stops[idx + 1][2], local),
        ];
    }
    function inferno(t) {
        return interpolateStops([
            [0.001, 0.000, 0.014], [0.165, 0.020, 0.286], [0.478, 0.106, 0.427],
            [0.832, 0.283, 0.259], [0.988, 0.647, 0.039], [0.988, 0.998, 0.645],
        ], t);
    }
    function viridis(t) {
        return interpolateStops([
            [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530],
            [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551],
            [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318],
            [0.741, 0.873, 0.150],
        ], t);
    }
    function turbo(t) {
        return interpolateStops([
            [0.190, 0.072, 0.232], [0.146, 0.322, 0.738], [0.129, 0.566, 0.551],
            [0.477, 0.821, 0.318], [0.993, 0.906, 0.144], [0.973, 0.462, 0.153],
            [0.680, 0.079, 0.004],
        ], t);
    }
    function colorForMap(name, t) {
        // Unified path: defer to SliceColorMap so the boundary patch and the
        // colorbar (which uses SliceColorMap directly) draw identical gradients.
        // Previously "diagnostic" rendered as [t, t, t] grayscale here while the
        // slice/colorbar interpreted "diagnostic" as a colourful blue→red ramp
        // — the boundary looked gray under a colourful legend.
        if (typeof SliceColorMap !== 'undefined' && SliceColorMap.colorMap) {
            const c = SliceColorMap.colorMap(t, name);
            return [c[0] / 255, c[1] / 255, c[2] / 255];
        }
        // Fallback when slice-renderer.js hasn't loaded yet — keeps the
        // overlay usable in isolation (boundary_viewer prototype, etc).
        if (name === 'viridis') return viridis(t);
        if (name === 'turbo') return turbo(t);
        if (name === 'diagnostic') return [t, t, t];
        return inferno(t);
    }

    // ── .smv parsing for BNDF groups and meshes ──────────────────────────────
    function parseSmvForBoundary(text, fileName) {
        const lines = text.split(/\r?\n/);
        const boundaryGroups = new Map();
        const meshes = parseSmvMeshes(lines);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('BNDF')) continue;
            const parts = line.split(/\s+/);
            const meshIndex = Number(parts[1]);
            const file = (lines[i + 1] || '').trim();
            const quantity = (lines[i + 2] || '').trim();
            const shortName = (lines[i + 3] || '').trim();
            const units = (lines[i + 4] || '').trim();
            if (!file || !quantity || !Number.isFinite(meshIndex)) continue;
            const key = quantity.toUpperCase();
            if (!boundaryGroups.has(key)) {
                boundaryGroups.set(key, { key, quantity, shortName, units, entries: [] });
            }
            boundaryGroups.get(key).entries.push({ meshIndex, fileName: file, quantity, shortName, units });
        }
        for (const group of boundaryGroups.values()) {
            group.entries.sort((a, b) => a.meshIndex - b.meshIndex || a.fileName.localeCompare(b.fileName));
        }
        return { fileName, boundaryGroups, meshes };
    }
    function parseSmvMeshes(lines) {
        const meshes = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('GRID')) continue;
            const id = line.replace(/^GRID\s*/i, '').trim() || 'mesh_' + (meshes.length + 1);
            const ijk = (lines[i + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite).slice(0, 3);
            if (ijk.length < 3) continue;
            let xb = null;
            for (let s = i + 2; s < lines.length; s++) {
                const la = lines[s].trim();
                if (la.startsWith('GRID') || la.startsWith('BNDF') || la.startsWith('SMOKF3D')) break;
                if (la !== 'PDIM') continue;
                const values = (lines[s + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
                if (values.length >= 6) xb = values.slice(0, 6);
                break;
            }
            if (xb) meshes.push({ index: meshes.length + 1, id, ijk, xb, source: 'smv' });
        }
        return meshes;
    }

    // ── .fds parsing for OBST/VENT context ───────────────────────────────────
    function parseFdsForBoundary(text, fileName) {
        const meshes = collectNamelists(text, 'MESH').map((rec, i) => {
            const p = parseSimpleParams(rec.body);
            return {
                index: i + 1,
                id: stripQuotes(p.ID || '') || 'mesh_' + (i + 1),
                ijk: parseNumberArray(p.IJK, 3),
                xb: parseNumberArray(p.XB, 6),
                source: 'fds',
            };
        }).filter(m => m.ijk && m.xb);

        const objects = collectNamelists(text, 'OBST').map((rec, i) => {
            const p = parseSimpleParams(rec.body);
            return {
                index: i + 1,
                id: stripQuotes(p.ID || '') || 'OBST ' + (i + 1),
                xb: parseNumberArray(p.XB, 6),
                surfId: stripQuotes(p.SURF_ID || ''),
                surfId6: p.SURF_ID6 || '',
            };
        }).filter(o => o.xb);

        const vents = collectNamelists(text, 'VENT').map((rec, i) => {
            const p = parseSimpleParams(rec.body);
            return {
                index: i + 1,
                id: stripQuotes(p.ID || '') || 'VENT ' + (i + 1),
                xb: parseNumberArray(p.XB, 6),
                surfId: stripQuotes(p.SURF_ID || ''),
            };
        }).filter(v => v.xb);

        if (!meshes.length) throw new Error('No &MESH records with IJK and XB were found in ' + fileName + '.');
        return { fileName, meshes, objects, vents };
    }
    function collectNamelists(text, name) {
        const records = [];
        const pattern = new RegExp('&' + name + '\\b', 'ig');
        let m;
        while ((m = pattern.exec(text)) !== null) {
            const end = findNamelistEnd(text, pattern.lastIndex);
            if (end === -1) continue;
            records.push({ body: text.slice(pattern.lastIndex, end) });
            pattern.lastIndex = end + 1;
        }
        return records;
    }
    function findNamelistEnd(text, start) {
        let quote = null;
        for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (quote) { if (c === quote) quote = null; continue; }
            if (c === "'" || c === '"') { quote = c; continue; }
            if (c === '/') return i;
        }
        return -1;
    }
    function parseSimpleParams(body) {
        const params = {};
        const cleaned = body.split(/\r?\n/).map(l => l.replace(/!.*/, ' ')).join(' ');
        const re = /([A-Z][A-Z0-9_()]*)\s*=\s*([^=]*?)(?=,\s*[A-Z][A-Z0-9_()]*\s*=|$)/gi;
        let m;
        while ((m = re.exec(cleaned)) !== null) {
            params[m[1].toUpperCase()] = m[2].replace(/,$/, '').trim();
        }
        return params;
    }
    function parseNumberArray(raw, count) {
        if (!raw) return null;
        const values = raw.split(',').map(p => Number(p.trim().replace(/[dD]/, 'E'))).filter(Number.isFinite);
        return values.length >= count ? values.slice(0, count) : null;
    }
    function stripQuotes(t) { return String(t || '').trim().replace(/^['"]|['"]$/g, ''); }

    // ── Frame alignment across per-mesh BNDF files ──────────────────────────
    function frameTimeKey(t) { return Number(t).toFixed(5); }
    function frameTimeMap(frames) {
        const m = new Map();
        for (let i = 0; i < frames.length; i++) {
            const k = frameTimeKey(frames[i].time);
            if (!m.has(k)) m.set(k, i);
        }
        return m;
    }
    function alignEntryFrames(entries) {
        const counts = entries.map(e => e.dataset.frames.length);
        if (counts.every(c => c === counts[0])) {
            for (const e of entries) e.frameMap = null;
            return { frames: entries[0].dataset.frames, note: '' };
        }
        const maps = entries.map(e => frameTimeMap(e.dataset.frames));
        let common = new Set(maps[0].keys());
        for (const map of maps.slice(1)) common = new Set(Array.from(common).filter(k => map.has(k)));
        const frames = [];
        const frameMaps = entries.map(() => []);
        for (let fi = 0; fi < entries[0].dataset.frames.length; fi++) {
            const k = frameTimeKey(entries[0].dataset.frames[fi].time);
            if (!common.has(k)) continue;
            frames.push(entries[0].dataset.frames[fi]);
            for (let ei = 0; ei < entries.length; ei++) frameMaps[ei].push(maps[ei].get(k));
        }
        for (let ei = 0; ei < entries.length; ei++) entries[ei].frameMap = frameMaps[ei];
        if (!frames.length) throw new Error('Boundary mesh files have no common timestamps.');
        return { frames, note: 'Aligned ' + frames.length + ' common frame(s).' };
    }

    // ── Patch geometry on FDS mesh surfaces ─────────────────────────────────
    function axisCoord(mesh, axis, index) {
        const cells = Math.max(1, mesh.ijk[axis]);
        const min = mesh.xb[axis * 2];
        const max = mesh.xb[axis * 2 + 1];
        return min + (max - min) * index / cells;
    }
    function patchGeometry(mesh, patch) {
        if (!mesh || !mesh.xb || !mesh.ijk) return null;
        const lengths = [patch.ni, patch.nj, patch.nk];
        const varying = [];
        for (let a = 0; a < 3; a++) if (lengths[a] > 1) varying.push(a);
        if (varying.length !== 2) return null;
        const uAxis = varying[0], vAxis = varying[1];
        const fixedAxis = [0, 1, 2].find(a => !varying.includes(a));
        const width = lengths[uAxis], height = lengths[vAxis];
        const minIdx = [patch.i1, patch.j1, patch.k1];
        const maxIdx = [patch.i2, patch.j2, patch.k2];
        const min = [axisCoord(mesh, 0, minIdx[0]), axisCoord(mesh, 1, minIdx[1]), axisCoord(mesh, 2, minIdx[2])];
        const max = [axisCoord(mesh, 0, maxIdx[0]), axisCoord(mesh, 1, maxIdx[1]), axisCoord(mesh, 2, maxIdx[2])];
        const fixed = fixedAxis === undefined ? 0 : min[fixedAxis];
        const c0 = min.slice(), c1 = min.slice(), c2 = min.slice(), c3 = min.slice();
        c0[fixedAxis] = c1[fixedAxis] = c2[fixedAxis] = c3[fixedAxis] = fixed;
        c1[uAxis] = max[uAxis]; c2[uAxis] = max[uAxis]; c2[vAxis] = max[vAxis]; c3[vAxis] = max[vAxis];
        return {
            width, height,
            // Always flip canvas rows now — see makeTextureCanvas comment.
            // (Removed the `vAxis !== 2` conditional which flipped horizontal
            //  patches but left vertical walls in the wrong orientation —
            //  produced the "hot at top, cool near burner" bug on the cladding
            //  face that Smokeview correctly shows the other way round.)
            flipRows: true,
            corners: [c0, c1, c2, c3].map(p => fdsToScene(p[0], p[1], p[2])),
        };
    }
    function quadGeometry(corners) {
        const positions = [];
        for (const c of corners) positions.push(c.x, c.y, c.z);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        // UV convention matches slice-renderer.js (which is known to render
        // FDS Fortran-ordered data correctly): V=0 at the "high index" corner,
        // V=1 at the "low index" corner. Combined with the always-flip in
        // makeTextureCanvas, this maps FDS index 0 → V=1 → corner c0 (xmin),
        // and FDS max index → V=0 → corner c2 (xmax). For a vertical wall
        // that puts FDS k=0 at the visual bottom (burner level), which is
        // what Smokeview shows.
        g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.computeBoundingSphere();
        return g;
    }

    // ── Texture canvas (per-patch heat-map image) ───────────────────────────
    function makeTextureCanvas(values, width, height, min, max, colorMapName, constantRange, flipRows) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(Math.round(width), 1);
        canvas.height = Math.max(Math.round(height), 1);
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(canvas.width, canvas.height);
        const span = Math.max(max - min, 1e-12);
        for (let y = 0; y < canvas.height; y++) {
            const sy = flipRows ? canvas.height - 1 - y : y;
            for (let x = 0; x < canvas.width; x++) {
                const si = x + canvas.width * sy;
                const value = values[si];
                const target = 4 * (x + canvas.width * y);
                if (!Number.isFinite(value)) { image.data[target + 3] = 0; continue; }
                const t = constantRange ? 0.5 : clamp((value - min) / span, 0, 1);
                const c = colorForMap(colorMapName, t);
                image.data[target] = Math.round(c[0] * 255);
                image.data[target + 1] = Math.round(c[1] * 255);
                image.data[target + 2] = Math.round(c[2] * 255);
                image.data[target + 3] = colorMapName === 'diagnostic' ? 235 : Math.round(45 + 210 * Math.sqrt(t));
            }
        }
        ctx.putImageData(image, 0, 0);
        return canvas;
    }

    // ── Main overlay class ───────────────────────────────────────────────────
    class BoundaryOverlay {
        constructor(scene, camera, controls, renderer) {
            this.scene = scene;
            this.camera = camera;
            this.controls = controls;
            this.renderer = renderer || null;

            this.fileMap = new Map();
            this.smvContext = null;
            this.fdsContext = null;
            this.meshContext = [];
            this.loadedGroups = new Map();
            this.activeGroup = null;
            this.activeFrames = [];
            this.frameIndex = 0;

            // Match the slice default so a freshly opened folder shows the same
            // colours in both views.
            this.colorMap = 'diagnostic';
            this.opacity = 0.88;
            this.autoRange = true;
            this.robustRange = false;
            this.manualMin = 0;
            this.manualMax = 1;
            this.lastRange = { min: 0, max: 1, constant: false };
            // 'basic' — depthTest off + renderOrder high → boundary always wins.
            // 'depth' — depthTest on + renderOrder low  → OBSTs occlude correctly.
            this.renderMode = 'basic';

            this.group = new THREE.Group();
            this.group.name = 'boundary-overlay';
            this.scene.add(this.group);
        }

        setVisible(v) { this.group.visible = !!v; }
        setColorMap(name) { this.colorMap = name; this._renderCurrentFrame(); }
        setRenderMode(mode) {
            this.renderMode = (mode === 'depth') ? 'depth' : 'basic';
            const depthOn = this.renderMode === 'depth';
            // Live-update any patches already in the scene so the toggle is
            // instant — no need to wait for the next frame change.
            for (const child of this.group.children) {
                if (!child.material) continue;
                child.material.depthTest = depthOn;
                child.material.needsUpdate = true;
                child.renderOrder = depthOn ? 1 : 6;
            }
        }
        setOpacity(v) {
            this.opacity = v;
            // Live-update existing patches' opacity without rebuilding textures.
            for (const child of this.group.children) {
                if (child.material) child.material.opacity = v;
            }
        }
        setAutoRange(b) { this.autoRange = b; this._renderCurrentFrame(); }
        setRobustRange(b) { this.robustRange = b; this._renderCurrentFrame(); }
        setManualRange(min, max) { this.manualMin = min; this.manualMax = max; if (!this.autoRange) this._renderCurrentFrame(); }
        setFrame(idx) {
            if (!this.activeFrames.length) return;
            this.frameIndex = clamp(idx, 0, this.activeFrames.length - 1);
            this._renderCurrentFrame();
        }
        currentTime() {
            if (!this.activeFrames.length) return 0;
            return this.activeFrames[this.frameIndex].time;
        }

        async loadFolder(files) {
            this._clearGroup();
            this.fileMap = new Map(files.map(f => [f.name.toLowerCase(), f]));
            this.loadedGroups = new Map();
            this.activeGroup = null;
            this.activeFrames = [];

            const smv = files.find(f => /\.smv$/i.test(f.name));
            const fds = files.find(f => /\.fds$/i.test(f.name));
            if (!smv) throw new Error('No .smv file in folder.');
            if (!fds) throw new Error('No .fds file in folder.');

            this.smvContext = parseSmvForBoundary(await smv.text(), smv.name);
            this.fdsContext = parseFdsForBoundary(await fds.text(), fds.name);
            this.meshContext = this.smvContext.meshes.length ? this.smvContext.meshes : this.fdsContext.meshes;

            return {
                smvName: smv.name,
                fdsName: fds.name,
                meshCount: this.meshContext.length,
                objectCount: this.fdsContext.objects.length,
                ventCount: this.fdsContext.vents.length,
                groupKeys: Array.from(this.smvContext.boundaryGroups.keys()),
                groups: this.smvContext.boundaryGroups,
            };
        }

        async loadSet(key, setStatus) {
            if (!this.smvContext) throw new Error('No boundary folder loaded.');
            // Generation token to discard stale concurrent loads.
            const gen = (this._loadGen = (this._loadGen || 0) + 1);
            if (!this.loadedGroups.has(key)) {
                const group = this.smvContext.boundaryGroups.get(key);
                if (!group) throw new Error('Boundary group not found: ' + key);
                const entries = [];
                for (let i = 0; i < group.entries.length; i++) {
                    const e = group.entries[i];
                    const file = this.fileMap.get(e.fileName.toLowerCase());
                    if (!file) throw new Error('Missing boundary file: ' + e.fileName);
                    if (setStatus) setStatus('Loading ' + e.fileName + ' (' + (i + 1) + ' of ' + group.entries.length + ')...');
                    const dataset = FdsBoundaryReader.parse(await file.arrayBuffer(), e.fileName);
                    if (gen !== this._loadGen) return { frameCount: 0, note: 'cancelled' };
                    entries.push({ ...e, dataset });
                    await new Promise(r => requestAnimationFrame(r));
                }
                if (gen !== this._loadGen) return { frameCount: 0, note: 'cancelled' };
                const alignment = alignEntryFrames(entries);
                this.loadedGroups.set(key, {
                    key, quantity: group.quantity, shortName: group.shortName, units: group.units,
                    entries, frames: alignment.frames, note: alignment.note,
                });
            }
            if (gen !== this._loadGen) return { frameCount: 0, note: 'cancelled' };
            this.activeGroup = this.loadedGroups.get(key);
            this.activeFrames = this.activeGroup.frames;
            this.frameIndex = this._findInitialFrame(this.activeGroup);
            this._renderCurrentFrame();
            return {
                frameCount: this.activeFrames.length,
                quantity: this.activeGroup.quantity,
                units: this.activeGroup.units,
                note: this.activeGroup.note,
            };
        }

        _findInitialFrame(group) {
            const maxScan = Math.min(group.frames.length, 180);
            const tol = /TEMP/i.test(group.quantity) ? 10
                : /HEAT FLUX/i.test(group.quantity) ? 1
                : /BURNING RATE/i.test(group.quantity) ? 0.001 : 0.05;
            for (let fi = 0; fi < maxScan; fi++) {
                let min = Infinity, max = -Infinity;
                for (const entry of group.entries) {
                    const ds = entry.dataset;
                    const gfi = group.activeFrameMap ? group.activeFrameMap[fi] : fi;
                    const sf = entry.frameMap ? entry.frameMap[gfi] : gfi;
                    for (let pi = 0; pi < ds.patches.length; pi++) {
                        const vals = ds.getPatchData(sf, pi);
                        for (const v of vals) {
                            if (!Number.isFinite(v)) continue;
                            if (v < min) min = v;
                            if (v > max) max = v;
                            if (max - min > tol) return fi;
                        }
                    }
                }
            }
            return 0;
        }

        _meshForEntry(entry) {
            return this.meshContext.find(m => m.index === entry.meshIndex)
                || this.meshContext[entry.meshIndex - 1] || null;
        }

        _collectFramePatches(group, frameIndex) {
            const patches = [];
            for (const entry of group.entries) {
                const ds = entry.dataset;
                const gfi = group.activeFrameMap ? group.activeFrameMap[frameIndex] : frameIndex;
                const sf = entry.frameMap ? entry.frameMap[gfi] : gfi;
                const mesh = this._meshForEntry(entry);
                for (let pi = 0; pi < ds.patches.length; pi++) {
                    const patch = ds.patches[pi];
                    const geo = patchGeometry(mesh, patch);
                    if (!geo) continue;
                    patches.push({
                        ...geo,
                        values: ds.getPatchData(sf, pi),
                        obstIndex: patch.obstIndex,
                        ior: patch.ior,
                    });
                }
            }
            return patches;
        }

        _resolveRange(patches) {
            if (!this.autoRange && Number.isFinite(this.manualMin) && Number.isFinite(this.manualMax) && this.manualMax > this.manualMin) {
                return { min: this.manualMin, max: this.manualMax, constant: false };
            }
            const values = [];
            for (const p of patches) for (const v of p.values) if (Number.isFinite(v)) values.push(v);
            if (!values.length) return { min: 0, max: 1, constant: false };
            values.sort((a, b) => a - b);
            let min = values[0], max = values[values.length - 1];
            if (this.robustRange && values.length > 20) {
                min = values[Math.floor(values.length * 0.02)];
                max = values[Math.floor(values.length * 0.98)];
            }
            const constant = Math.abs(max - min) < 1e-12;
            if (constant) {
                const pad = Math.max(Math.abs(min) * 0.02, 0.5);
                min -= pad; max += pad;
            }
            return { min, max, constant };
        }

        _renderCurrentFrame() {
            this._clearGroup();
            if (!this.activeGroup || !this.activeFrames.length) return;
            const patches = this._collectFramePatches(this.activeGroup, this.frameIndex);
            if (!patches.length) { this.lastRange = { min: 0, max: 1, constant: false }; return; }
            const range = this._resolveRange(patches);
            this.lastRange = range;
            for (const patch of patches) {
                const canvas = makeTextureCanvas(
                    patch.values, patch.width, patch.height,
                    range.min, range.max, this.colorMap, range.constant, patch.flipRows
                );
                const texture = new THREE.CanvasTexture(canvas);
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.NearestFilter;
                texture.flipY = false;
                if (THREE.sRGBEncoding) texture.encoding = THREE.sRGBEncoding;
                texture.wrapS = THREE.ClampToEdgeWrapping;
                texture.wrapT = THREE.ClampToEdgeWrapping;
                const depthOn = this.renderMode === 'depth';
                const material = new THREE.MeshBasicMaterial({
                    map: texture,
                    transparent: true,
                    opacity: this.opacity,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                    depthTest: depthOn, // basic = false (always on top), depth = true (OBSTs occlude)
                });
                const mesh = new THREE.Mesh(quadGeometry(patch.corners), material);
                mesh.renderOrder = depthOn ? 1 : 6;
                mesh.frustumCulled = false;
                this.group.add(mesh);
            }
        }

        _clearGroup() {
            while (this.group.children.length) {
                const child = this.group.children.pop();
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (child.material.map) child.material.map.dispose();
                    child.material.dispose();
                }
            }
        }

        // Compute bounds (FDS coords) from loaded meshes — used by Output page
        // to frame the camera when no other geometry is present.
        getBoundsFDS() {
            if (!this.meshContext.length) return null;
            let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
            for (const m of this.meshContext) {
                xmin = Math.min(xmin, m.xb[0]); xmax = Math.max(xmax, m.xb[1]);
                ymin = Math.min(ymin, m.xb[2]); ymax = Math.max(ymax, m.xb[3]);
                zmin = Math.min(zmin, m.xb[4]); zmax = Math.max(zmax, m.xb[5]);
            }
            return Number.isFinite(xmin) ? { xmin, xmax, ymin, ymax, zmin, zmax } : null;
        }
    }

    global.BoundaryOverlay = BoundaryOverlay;
})(window);
