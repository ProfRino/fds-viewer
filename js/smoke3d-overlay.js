/**
 * Smoke3D Overlay for the Output page
 *
 * Renders FDS Smoke3D output (.s3d) as a WebGL2 ray-marched volumetric layer.
 * Requires WebGL2 + DataTexture3D + RedFormat. supportsVolumeRendering()
 * reports false on machines that don't have it.
 *
 * FDS-to-Three coordinate convention: X→X, Z→Y (up), Y→Z.
 */

(function (global) {
    'use strict';

    function fdsToScene(x, y, z) { return new THREE.Vector3(x, z, -y); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

    // ── SMV parsing ───────────────────────────────────────────────────────
    function parseSmv(text, fileName) {
        const lines = text.split(/\r?\n/);
        const groups = new Map();
        const meshes = parseSmvMeshes(lines);
        const hrrpuvRange = parseSmvRange(lines, 'HRRPUV_MINMAX', [0, 1200]);
        const tempRange   = parseSmvRange(lines, 'TEMP_MINMAX', [20, 2000]);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('SMOKF3D')) continue;
            const parts = line.split(/\s+/);
            const meshIndex = Number(parts[1]);
            const scaleValue = Number(parts[2]);
            const file = (lines[i + 1] || '').trim();
            const quantity = (lines[i + 2] || '').trim();
            const shortName = (lines[i + 3] || '').trim();
            const units = (lines[i + 4] || '').trim();
            if (!file || !quantity || !Number.isFinite(meshIndex)) continue;
            const key = quantity.toUpperCase();
            if (!groups.has(key)) {
                groups.set(key, {
                    key, quantity, shortName, units, entries: [],
                    extinction: /SOOT/i.test(quantity) ? scaleValue : 0,
                    scale: /^HRRPUV$/i.test(quantity) ? hrrpuvRange : tempRange,
                });
            }
            groups.get(key).entries.push({
                meshIndex, fileName: file, quantity, shortName, units, scaleValue
            });
        }
        for (const g of groups.values()) g.entries.sort((a, b) => a.meshIndex - b.meshIndex);
        return { fileName, groups, meshes, hrrpuvMin: hrrpuvRange[0], hrrpuvMax: hrrpuvRange[1] };
    }

    function parseSmvMeshes(lines) {
        const meshes = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('GRID')) continue;
            const id = line.replace(/^GRID\s*/i, '').trim() || ('mesh_' + (meshes.length + 1));
            const ijk = (lines[i + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite).slice(0, 3);
            if (ijk.length < 3) continue;
            let xb = null;
            for (let j = i + 2; j < lines.length; j++) {
                const la = lines[j].trim();
                if (la.startsWith('GRID') || la.startsWith('SMOKF3D')) break;
                if (la !== 'PDIM') continue;
                const v = (lines[j + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
                if (v.length >= 6) xb = v.slice(0, 6);
                break;
            }
            if (xb) meshes.push({ index: meshes.length + 1, id, ijk, xb, source: 'smv' });
        }
        return meshes;
    }

    function parseSmvRange(lines, token, fallback) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() !== token) continue;
            const v = (lines[i + 1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
            if (v.length >= 2) return [v[0], v[1]];
        }
        return fallback;
    }

    // ── Frame alignment ───────────────────────────────────────────────────
    function frameTimeKey(time) { return Number(time).toFixed(5); }
    function frameTimeMap(frames) {
        const map = new Map();
        for (let i = 0; i < frames.length; i++) {
            const key = frameTimeKey(frames[i].time);
            if (!map.has(key)) map.set(key, i);
        }
        return map;
    }

    function alignEntryFrames(entries) {
        const counts = entries.map(e => e.dataset.frames.length);
        if (counts.every(c => c === counts[0])) {
            for (const e of entries) e.frameMap = null;
            return { frames: entries[0].dataset.frames, note: '' };
        }
        const maps = entries.map(e => frameTimeMap(e.dataset.frames));
        let common = new Set(maps[0].keys());
        for (const m of maps.slice(1))
            common = new Set(Array.from(common).filter(k => m.has(k)));
        const frames = [];
        const frameMaps = entries.map(() => []);
        for (let i = 0; i < entries[0].dataset.frames.length; i++) {
            const key = frameTimeKey(entries[0].dataset.frames[i].time);
            if (!common.has(key)) continue;
            frames.push(entries[0].dataset.frames[i]);
            for (let ei = 0; ei < entries.length; ei++) frameMaps[ei].push(maps[ei].get(key));
        }
        for (let ei = 0; ei < entries.length; ei++) entries[ei].frameMap = frameMaps[ei];
        if (!frames.length) throw new Error('Smoke3D mesh files have no common timestamps.');
        return { frames, note: 'Aligned ' + frames.length + ' common frame(s).' };
    }

    function alignGroupsByTime(groups) {
        if (groups.length === 1) { groups[0].activeFrameMap = null; return { frames: groups[0].frames, note: '' }; }
        const maps = groups.map(g => frameTimeMap(g.frames));
        let common = new Set(maps[0].keys());
        for (const m of maps.slice(1))
            common = new Set(Array.from(common).filter(k => m.has(k)));
        const frames = [];
        const groupMaps = groups.map(() => []);
        for (let i = 0; i < groups[0].frames.length; i++) {
            const key = frameTimeKey(groups[0].frames[i].time);
            if (!common.has(key)) continue;
            frames.push(groups[0].frames[i]);
            for (let gi = 0; gi < groups.length; gi++) groupMaps[gi].push(maps[gi].get(key));
        }
        if (!frames.length) throw new Error('Selected Smoke3D quantities have no common timestamps.');
        for (let gi = 0; gi < groups.length; gi++) groups[gi].activeFrameMap = groupMaps[gi];
        return { frames, note: 'Aligned to ' + frames.length + ' common timestamp(s).' };
    }

    // ── Smoke3DOverlay class ─────────────────────────────────────────────
    class Smoke3DOverlay {
        constructor(scene, camera, controls, renderer) {
            this.scene = scene;
            this.camera = camera;
            this.controls = controls;
            this.renderer = renderer || null;
            this.smvContext = null;
            this.fileMap = new Map();
            this.meshContext = [];
            this.loadedGroups = new Map();
            this.activeKeys = [];
            this.activeFrames = [];
            this.frameIndex = 0;
            this.quantityMode = 'combined';
            this.sampleStep = 1;

            // Temporal smoothing — when enabled, the byte volume uploaded each
            // frame is a per-cell linear interpolation between the current
            // .s3d frame and the next, weighted by wall-clock progress. This
            // makes playback visually smooth even though the data only has
            // ~3 frames per simulation second. CPU cost ≈ volume_size bytes
            // copied per render; GPU cost ≈ one extra texture upload per
            // render. Toggled via setSmoothMotion().
            this.smoothMotion = false;
            this._smoothFrameDuration = 220; // ms — matches playback timer
            this._lastFrameChangeTime = (typeof performance !== 'undefined') ? performance.now() : 0;
            this.sootThreshold = 0;
            this.hrrThreshold = 42;
            this.sootOpacity = 1;
            this.hrrOpacity = 0.85;
            this.webglTransfer = { base: 0.2, exponent: 0.82, gain: 7.2 };
            // Fire (HRRPUV) transfer-function constants — defaults match the
            // values previously hard-coded in the shader. These are empirical
            // "flame look" tuning, not from any physical model.
            this.fireTransfer  = { base: 0.12, exponent: 1.10, gain: 5.4 };

            // Active clip volume (FDS coords). Null = no clipping.
            this._clipBounds = null;

            this.group = new THREE.Group();
            this.group.name = 'smoke3d-overlay';
            this.scene.add(this.group);
        }

        dispose() {
            this._clearGroup();
            if (this.group.parent) this.group.parent.remove(this.group);
        }

        setVisible(v) { this.group.visible = !!v; }

        async loadFolder(files) {
            this._reset();
            this.fileMap = new Map(files.map(f => [f.name.toLowerCase(), f]));
            const smvFile = files.find(f => /\.smv$/i.test(f.name));
            if (!smvFile) throw new Error('No .smv file in selected folder.');
            const smvText = await smvFile.text();
            this.smvContext = parseSmv(smvText, smvFile.name);

            if (!this.smvContext.meshes || this.smvContext.meshes.length === 0) {
                const fdsFile = files.find(f => /\.fds$/i.test(f.name));
                if (fdsFile && global._outputFdsMeshes) this.meshContext = global._outputFdsMeshes;
                else if (fdsFile) this.meshContext = await this._meshesFromFds(fdsFile);
                else throw new Error('SMV has no GRID/PDIM and no .fds file was found.');
            } else {
                this.meshContext = this.smvContext.meshes;
            }
            return this._availableQuantities();
        }

        async _meshesFromFds(fdsFile) {
            const text = await fdsFile.text();
            const meshes = [];
            const re = /&MESH\b/ig;
            let m;
            while ((m = re.exec(text)) !== null) {
                const start = re.lastIndex;
                let end = -1, q = null;
                for (let i = start; i < text.length; i++) {
                    const ch = text[i];
                    if (q) { if (ch === q) q = null; continue; }
                    if (ch === "'" || ch === '"') { q = ch; continue; }
                    if (ch === '/') { end = i; break; }
                }
                if (end < 0) continue;
                const body = text.slice(start, end);
                const params = {};
                const cleaned = body.split(/\r?\n/).map(l => l.replace(/!.*/, ' ')).join(' ');
                const pre = /([A-Z][A-Z0-9_()]*)\s*=\s*([^=]*?)(?=,\s*[A-Z][A-Z0-9_()]*\s*=|$)/gi;
                let mp;
                while ((mp = pre.exec(cleaned)) !== null) params[mp[1].toUpperCase()] = mp[2].replace(/,$/, '').trim();
                const parseArr = (raw, count) => {
                    if (!raw) return null;
                    const v = raw.split(',').map(p => Number(p.trim().replace(/[dD]/, 'E'))).filter(Number.isFinite);
                    return v.length >= count ? v.slice(0, count) : null;
                };
                const ijk = parseArr(params.IJK, 3), xb = parseArr(params.XB, 6);
                if (!ijk || !xb) continue;
                meshes.push({ index: meshes.length + 1, id: 'mesh_' + (meshes.length + 1), ijk, xb, source: 'fds' });
                re.lastIndex = end + 1;
            }
            if (!meshes.length) throw new Error('No usable &MESH records in .fds file.');
            return meshes;
        }

        _availableQuantities() {
            const out = { soot: false, hrr: false };
            if (!this.smvContext) return out;
            for (const g of this.smvContext.groups.values()) {
                if (/SOOT/i.test(g.quantity)) out.soot = true;
                if (/^HRRPUV$/i.test(g.quantity)) out.hrr = true;
            }
            return out;
        }

        async loadActiveQuantities(setStatus) {
            const keys = this._modeKeys();
            if (!keys.length) throw new Error('No quantity selected.');
            // Generation token — if the user toggles quantities while a load
            // is in flight, the older call's result must NOT overwrite the
            // newer one's. Each call captures its generation and checks before
            // committing state.
            const gen = (this._loadGen = (this._loadGen || 0) + 1);
            for (const key of keys) {
                if (!this.loadedGroups.has(key)) {
                    if (setStatus) setStatus('Loading ' + key + '...');
                    const loaded = await this._loadGroup(key, setStatus);
                    if (gen !== this._loadGen) return { frameCount: 0, note: 'cancelled' };
                    this.loadedGroups.set(key, loaded);
                }
            }
            if (gen !== this._loadGen) return { frameCount: 0, note: 'cancelled' };
            const groups = keys.map(k => this.loadedGroups.get(k)).filter(Boolean);
            const alignment = alignGroupsByTime(groups);
            this.activeKeys = keys;
            this.activeFrames = alignment.frames;
            this.frameIndex = 0;
            this._renderCurrentFrame();
            return { frameCount: this.activeFrames.length, note: alignment.note };
        }

        async _loadGroup(key, setStatus) {
            const group = this.smvContext.groups.get(key);
            if (!group) throw new Error('Group not found: ' + key);
            const entries = [];
            const truncated = [];
            for (let i = 0; i < group.entries.length; i++) {
                const e = group.entries[i];
                const file = this.fileMap.get(e.fileName.toLowerCase());
                if (!file) throw new Error('Missing Smoke3D file: ' + e.fileName);
                if (setStatus) setStatus('Loading ' + e.fileName + ' (' + (i + 1) + ' of ' + group.entries.length + ')...');
                const dataset = Smoke3DReader.parse(await file.arrayBuffer(), e.fileName);
                if (dataset.truncatedAt != null) truncated.push(e.fileName);
                entries.push({ ...e, dataset });
            }
            const alignment = alignEntryFrames(entries);
            let note = alignment.note;
            if (truncated.length) {
                const suffix = ' Partial data: ' + truncated.join(', ') + ' truncated — frame count limited to common range.';
                note = note ? note + suffix : suffix.trim();
            }
            return {
                key, quantity: group.quantity, shortName: group.shortName,
                units: group.units, extinction: group.extinction,
                entries, frames: alignment.frames, note,
            };
        }

        _modeKeys() {
            if (!this.smvContext) return [];
            let sootKey = null, hrrKey = null;
            for (const [k, g] of this.smvContext.groups.entries()) {
                if (/SOOT/i.test(g.quantity)) sootKey = k;
                if (/^HRRPUV$/i.test(g.quantity)) hrrKey = k;
            }
            if (this.quantityMode === 'combined') return [sootKey, hrrKey].filter(Boolean);
            if (this.quantityMode === 'soot') return sootKey ? [sootKey] : [];
            if (this.quantityMode === 'hrrpuv') return hrrKey ? [hrrKey] : [];
            return [];
        }

        setQuantity(mode) {
            this.quantityMode = mode;
            const keys = this._modeKeys();
            if (keys.every(k => this.loadedGroups.has(k))) {
                const groups = keys.map(k => this.loadedGroups.get(k));
                if (groups.length) {
                    const alignment = alignGroupsByTime(groups);
                    this.activeKeys = keys;
                    this.activeFrames = alignment.frames;
                    this.frameIndex = clamp(this.frameIndex, 0, this.activeFrames.length - 1);
                    this._renderCurrentFrame();
                }
            }
        }

        setFrame(idx) {
            if (!this.activeFrames.length) return;
            this.frameIndex = clamp(idx, 0, this.activeFrames.length - 1);
            this._lastFrameChangeTime = performance.now();
            this._renderCurrentFrame();
        }

        /** Toggle temporal smoothing. See constructor for cost notes. */
        setSmoothMotion(enabled) {
            this.smoothMotion = !!enabled;
            this._renderCurrentFrame();
        }

        setSampleStep(step)  { this.sampleStep = step; this._renderCurrentFrame(); }
        setSootThreshold(v)  { this.sootThreshold = v; this._renderCurrentFrame(); }
        setHrrThreshold(v)   { this.hrrThreshold = v; this._renderCurrentFrame(); }
        setSootOpacity(v)    { this.sootOpacity = v; this._renderCurrentFrame(); }
        setHrrOpacity(v)     { this.hrrOpacity = v; this._renderCurrentFrame(); }

        setWebGlTransfer(base, exponent, gain) {
            this.webglTransfer = { base, exponent, gain };
            this._renderCurrentFrame();
        }

        /** Set the HRRPUV fire transfer-function coefficients. Same shape as
         *  setWebGlTransfer but applied to the fire branch of the shader. */
        setFireTransfer(base, exponent, gain) {
            this.fireTransfer = { base, exponent, gain };
            this._renderCurrentFrame();
        }

        // Apply the same clip box that's wired to the FDS geometry. Coordinates are
        // in FDS units; live-updates uniforms on existing volume meshes so the user
        // sees the effect immediately without rebuilding textures.
        setClipBoundsFDS(xmin, xmax, ymin, ymax, zmin, zmax) {
            this._clipBounds = { enabled: true, xmin, xmax, ymin, ymax, zmin, zmax };
            this._applyClipUniforms();
        }
        clearClipBoundsFDS() {
            this._clipBounds = null;
            this._applyClipUniforms();
        }
        _applyClipUniforms() {
            const cb = this._clipBounds;
            for (const child of this.group.children) {
                const u = child.material && child.material.uniforms;
                if (!u || !u.clipEnabled) continue;
                if (cb && cb.enabled) {
                    u.clipEnabled.value = 1;
                    u.clipMin.value.set(cb.xmin, cb.ymin, cb.zmin);
                    u.clipMax.value.set(cb.xmax, cb.ymax, cb.zmax);
                } else {
                    u.clipEnabled.value = 0;
                }
            }
        }

        supportsVolumeRendering() {
            const isWebGL2 = this.renderer
                ? this.renderer.capabilities.isWebGL2
                : Boolean(window.WebGL2RenderingContext);
            return Boolean(isWebGL2 && THREE.DataTexture3D && THREE.RedFormat);
        }

        currentTime() {
            if (!this.activeFrames.length) return 0;
            return this.activeFrames[this.frameIndex].time;
        }

        _meshForEntry(entry) {
            return this.meshContext.find(m => m.index === entry.meshIndex) ||
                   this.meshContext[entry.meshIndex - 1] || null;
        }

        _frameBytesForEntry(group, entry) {
            return this._frameBytesForEntryAt(group, entry, this.frameIndex);
        }

        _frameBytesForEntryAt(group, entry, activeFrameIdx) {
            const gfi = group.activeFrameMap ? group.activeFrameMap[activeFrameIdx] : activeFrameIdx;
            const sf  = entry.frameMap ? entry.frameMap[gfi] : gfi;
            if (sf == null) return new Uint8Array(0);
            if (!entry._bytesCache) entry._bytesCache = new Map();
            if (entry._bytesCache.has(sf)) return entry._bytesCache.get(sf);
            const bytes = entry.dataset.decompressFrame(sf);
            entry._bytesCache.set(sf, bytes);
            if (entry._bytesCache.size > 12) entry._bytesCache.delete(entry._bytesCache.keys().next().value);
            return bytes;
        }

        /**
         * Temporal smoothing — per-render byte interpolation between the
         * current data frame and the next, weighted by wall-clock progress
         * since the last setFrame() call. Skips work when the playback has
         * been paused for longer than ~1.5× a frame interval (otherwise the
         * blend would drift to 1 and lock onto the next frame's data).
         */
        _interpolateVolume(mesh) {
            if (!mesh._smokeEntry || !mesh._smokeGroup || !this.activeFrames.length) return;
            const elapsed = performance.now() - this._lastFrameChangeTime;
            // If no recent frame change, assume paused — keep the current
            // frame on screen. Snap blend to 0 if we haven't already.
            const paused = elapsed > this._smoothFrameDuration * 1.5;
            const blend = paused ? 0 : Math.max(0, Math.min(1, elapsed / this._smoothFrameDuration));
            // Skip the upload if the blend hasn't changed enough to matter
            // (cheap optimisation; CPU lerp + GPU upload is the main cost).
            if (Math.abs(blend - mesh._smokeLastBlend) < 0.005) return;
            mesh._smokeLastBlend = blend;

            const a = this._frameBytesForEntryAt(mesh._smokeGroup, mesh._smokeEntry, this.frameIndex);
            const nextIdx = (this.frameIndex + 1) % this.activeFrames.length;
            const b = this._frameBytesForEntryAt(mesh._smokeGroup, mesh._smokeEntry, nextIdx);
            const buf = mesh._smokeBuffer;
            if (!a || !b || !buf || a.length !== buf.length || b.length !== buf.length) return;
            // Lerp every byte (volumes are typically 50k–500k bytes; <1 ms on
            // a modern laptop, runs at most once per render).
            if (blend <= 0) {
                buf.set(a);
            } else if (blend >= 1) {
                buf.set(b);
            } else {
                const inv = 1 - blend;
                for (let i = 0; i < buf.length; i++) buf[i] = (a[i] * inv + b[i] * blend) | 0;
            }
            mesh._smokeTexture.needsUpdate = true;
        }

        _volumeStepCount(mergedMeshes) {
            // Widened range so the visual difference between Full and Coarse
            // is actually noticeable. Path-length opacity correction keeps
            // overall brightness consistent across step counts, but Coarse
            // (~24 steps) is low enough to show ray-band artefacts in fine
            // smoke detail — useful for performance debugging on slow GPUs.
            const boost = (mergedMeshes || 1) > 1 ? 48 : 0;
            if (this.sampleStep <= 1) return 200 + boost;
            if (this.sampleStep === 2) return 120 + Math.round(boost * 0.6);
            if (this.sampleStep === 3) return  60 + Math.round(boost * 0.3);
            return                              24 + Math.round(boost * 0.1);
        }

        // ── Main render dispatcher ────────────────────────────────────────
        _renderCurrentFrame() {
            if (!this.activeKeys.length || !this.activeFrames.length) {
                this._clearGroup(); return;
            }
            this._clearGroup();
            if (!this.supportsVolumeRendering()) return;
            for (const key of this.activeKeys) {
                const group = this.loadedGroups.get(key);
                if (!group) continue;
                const layer = this._buildWebGlVolumeLayer(group);
                if (layer.volumes.length) this._addVolumeLayerToGroup(layer);
            }
        }

        // ── WebGL volumetric render ───────────────────────────────────────
        _buildWebGlVolumeLayer(group) {
            const isSoot    = /SOOT/i.test(group.quantity);
            const threshold = isSoot ? this.sootThreshold : this.hrrThreshold;
            const opacity   = isSoot ? this.sootOpacity   : this.hrrOpacity;
            const transfer  = this.webglTransfer;

            const merged = this._buildMergedZStackVolume(group, threshold, opacity, isSoot, transfer);
            if (merged) return { volumes: [merged], steps: this._volumeStepCount(merged.mergedMeshes) };

            const volumes = [];
            const fireTransfer = this.fireTransfer; // shared across all fire volumes
            for (const entry of group.entries) {
                const mesh = this._meshForEntry(entry);
                if (!mesh) continue;
                const bytes = this._frameBytesForEntry(group, entry);
                // For temporal smoothing we need to look up the bytes for the
                // NEXT frame from the same entry — store back-refs so the per
                // -render hook can fetch and interpolate them.
                volumes.push({ data: bytes, dims: entry.dataset.header.dims, meshXb: mesh.xb.slice(),
                    quantity: group.quantity, threshold, opacity, transfer, fireTransfer, additive: !isSoot,
                    _entry: entry, _group: group });
            }
            return { volumes, steps: this._volumeStepCount(1) };
        }

        _buildMergedZStackVolume(group, threshold, opacity, isSoot, transfer) {
            if (group.entries.length < 2) return null;
            const prepared = group.entries.map(e => ({
                entry: e, mesh: this._meshForEntry(e),
                dims: e.dataset.header.dims, bytes: this._frameBytesForEntry(group, e),
            })).filter(p => p.mesh).sort((a, b) => a.mesh.xb[4] - b.mesh.xb[4]);
            if (!this._canMergeZStack(prepared)) return null;
            const [nx, ny] = prepared[0].dims;
            let mergedNz = prepared[0].dims[2];
            for (let i = 1; i < prepared.length; i++) mergedNz += prepared[i].dims[2] - 1;
            const data = new Uint8Array(nx * ny * mergedNz);
            let kOff = 0;
            for (let ei = 0; ei < prepared.length; ei++) {
                const item = prepared[ei], srcNz = item.dims[2], skip = ei === 0 ? 0 : 1;
                for (let k = skip; k < srcNz; k++) {
                    const tk = kOff + k - skip;
                    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
                        data[i + nx*(j + ny*tk)] = item.bytes[i + nx*(j + ny*k)];
                }
                kOff += srcNz - skip;
            }
            const first = prepared[0].mesh, last = prepared[prepared.length-1].mesh;
            return { data, dims: [nx, ny, mergedNz],
                meshXb: [first.xb[0], first.xb[1], first.xb[2], first.xb[3], first.xb[4], last.xb[5]],
                quantity: group.quantity, threshold, opacity, transfer, fireTransfer: this.fireTransfer, additive: !isSoot,
                mergedMeshes: prepared.length };
        }

        _canMergeZStack(items) {
            if (!items.length) return false;
            const [nx, ny] = items[0].dims, [x0, x1, y0, y1] = items[0].mesh.xb, eps = 1e-5;
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                if (it.dims[0] !== nx || it.dims[1] !== ny) return false;
                if (Math.abs(it.mesh.xb[0]-x0) > eps || Math.abs(it.mesh.xb[1]-x1) > eps) return false;
                if (Math.abs(it.mesh.xb[2]-y0) > eps || Math.abs(it.mesh.xb[3]-y1) > eps) return false;
                if (i > 0 && Math.abs(it.mesh.xb[4] - items[i-1].mesh.xb[5]) > eps) return false;
            }
            return true;
        }

        // ── Volume rendering — ported verbatim from prototype/smoke3d-viewer.js ──
        _addVolumeLayerToGroup(layer) {
            for (const volume of layer.volumes) {
                const [nx, ny, nz] = volume.dims;
                // Clone the source bytes into a dedicated texture buffer.
                // volume.data points at the entry's frame-bytes CACHE — if the
                // texture and the cache shared the same Uint8Array, the
                // per-render temporal lerp would overwrite the cached source
                // frame, corrupting subsequent frame fetches. With a clone,
                // the cache stays pristine and lerps remain accurate.
                const textureData = new Uint8Array(volume.data);
                const texture = new THREE.DataTexture3D(textureData, nx, ny, nz);
                texture.format = THREE.RedFormat;
                texture.type = THREE.UnsignedByteType;
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.wrapR = THREE.ClampToEdgeWrapping;
                texture.wrapS = THREE.ClampToEdgeWrapping;
                texture.wrapT = THREE.ClampToEdgeWrapping;
                texture.unpackAlignment = 1;
                texture.needsUpdate = true;

                const material = this._createVolumeMaterial(volume, texture, layer.steps);
                const geometry = new THREE.BoxGeometry(1, 1, 1);
                const mesh = new THREE.Mesh(geometry, material);
                const [x0, x1, y0, y1, z0, z1] = volume.meshXb;

                mesh.position.copy(fdsToScene(
                    (x0 + x1) / 2,
                    (y0 + y1) / 2,
                    (z0 + z1) / 2
                ));
                mesh.scale.set(
                    Math.max(x1 - x0, 0.001),
                    Math.max(z1 - z0, 0.001),
                    Math.max(y1 - y0, 0.001)
                );
                mesh.renderOrder = volume.additive ? 5 : 4;
                mesh.frustumCulled = false;
                mesh._isSmokeVolume = true; // viewer hides these during the depth pass
                // Stash refs so the per-render hook can interpolate without
                // looking them up each frame. _smokeBuffer is the texture's
                // private clone — safe to overwrite during lerp without
                // corrupting the entry's frame-bytes cache.
                mesh._smokeTexture = texture;
                mesh._smokeBuffer  = textureData;
                mesh._smokeEntry   = volume._entry || null;
                mesh._smokeGroup   = volume._group || null;
                mesh._smokeLastBlend = -1; // sentinel so first frame uploads
                mesh.onBeforeRender = (_renderer, _scene, camera) => {
                    mesh.updateMatrixWorld();
                    material.uniforms.inverseModelMatrix.value.copy(mesh.matrixWorld).invert();
                    // M*V*P composed in JS: clip = projection * view * model
                    material.uniforms.mvpMatrix.value
                        .copy(camera.projectionMatrix)
                        .multiply(camera.matrixWorldInverse)
                        .multiply(mesh.matrixWorld);
                    // Camera near/far for linear-depth conversion in the shader
                    material.uniforms.uNear.value = camera.near;
                    material.uniforms.uFar.value  = camera.far;
                    // Temporal smoothing — see _interpolateVolume for details.
                    if (this.smoothMotion) this._interpolateVolume(mesh);
                };

                this.group.add(mesh);
            }
        }

        _createVolumeMaterial(volume, texture, steps) {
            const transfer = volume.transfer || {};
            const [x0, x1, y0, y1, z0, z1] = volume.meshXb;
            const fo = (v, d) => Number.isFinite(v) ? v : d;
            // Use the overlay's current clip state as the initial uniform values so
            // newly-built materials immediately reflect an active clip.
            const cb = this._clipBounds;
            return new THREE.ShaderMaterial({
                glslVersion: THREE.GLSL3,
                uniforms: {
                    volumeMap: { value: texture },
                    threshold: { value: Math.max(0, Math.min(1, volume.threshold / 255)) },
                    opacity: { value: volume.opacity },
                    quantityMode: { value: /SOOT/i.test(volume.quantity) ? 0 : 1 },
                    sootBase: { value: fo(transfer.base, 0.2) },
                    sootExponent: { value: fo(transfer.exponent, 0.82) },
                    sootGain: { value: fo(transfer.gain, 7.2) },
                    // Fire (HRRPUV) transfer coefficients — exposed so users
                    // can tune flame appearance. Defaults preserve the look
                    // of the previously hard-coded constants 0.12, 1.10, 5.4.
                    fireBase: { value: fo((volume.fireTransfer || {}).base, 0.12) },
                    fireExponent: { value: fo((volume.fireTransfer || {}).exponent, 1.10) },
                    fireGain: { value: fo((volume.fireTransfer || {}).gain, 5.4) },
                    steps: { value: steps || 96 },
                    volumeDimensions: { value: new THREE.Vector3(volume.dims[0], volume.dims[1], volume.dims[2]) },
                    volumeWorldSize: { value: new THREE.Vector3(
                        Math.max(x1 - x0, 0.001),
                        Math.max(z1 - z0, 0.001),
                        Math.max(y1 - y0, 0.001)
                    ) },
                    inverseModelMatrix: { value: new THREE.Matrix4() },
                    // Clip volume in FDS coordinates (matches the Output clip panel).
                    // clipEnabled=0 disables; otherwise samples outside [clipMin..clipMax] are skipped.
                    clipEnabled: { value: cb && cb.enabled ? 1 : 0 },
                    clipMin: { value: new THREE.Vector3(
                        cb ? cb.xmin : -1e30,
                        cb ? cb.ymin : -1e30,
                        cb ? cb.zmin : -1e30
                    ) },
                    clipMax: { value: new THREE.Vector3(
                        cb ? cb.xmax :  1e30,
                        cb ? cb.ymax :  1e30,
                        cb ? cb.zmax :  1e30
                    ) },
                    // FDS-space bounds of THIS volume box, used to map sample coords back to FDS coords.
                    boxFdsMin: { value: new THREE.Vector3(x0, y0, z0) },
                    boxFdsMax: { value: new THREE.Vector3(x1, y1, z1) },
                    // Scene-depth occlusion (Solid-aware mode). The viewer
                    // renders the opaque scene to a DepthTexture once per
                    // frame and binds it here; the shader compares each
                    // ray-march sample's NDC depth to the stored scene depth
                    // and stops marching when the sample crosses a solid.
                    // depthEnabled=0 disables the check (smoke always wins,
                    // legacy behaviour). mvpMatrix maps a local box-space
                    // sample (in [-0.5..0.5]) to clip space — passed via JS
                    // because ShaderMaterial fragment shaders don't get
                    // modelMatrix/projectionMatrix auto-injected.
                    depthEnabled: { value: 0 },
                    sceneDepth: { value: null },
                    uResolution: { value: new THREE.Vector2(2, 2) },
                    mvpMatrix: { value: new THREE.Matrix4() },
                    // Camera near/far for linear-depth conversion. NDC z is
                    // highly non-linear at typical viewing distances, so the
                    // fade zone is computed in real metres instead.
                    uNear: { value: 0.01 },
                    uFar:  { value: 1000.0 },
                },
                vertexShader: `
                    out vec3 vLocalPosition;

                    void main() {
                        vLocalPosition = position + vec3(0.5);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    precision highp float;
                    precision highp sampler3D;

                    uniform sampler3D volumeMap;
                    uniform float threshold;
                    uniform float opacity;
                    uniform float sootBase;
                    uniform float sootExponent;
                    uniform float sootGain;
                    uniform float fireBase;
                    uniform float fireExponent;
                    uniform float fireGain;
                    uniform int quantityMode;
                    uniform int steps;
                    uniform vec3 volumeDimensions;
                    uniform vec3 volumeWorldSize;
                    uniform mat4 inverseModelMatrix;

                    // Clip volume — Output clip panel, in FDS coordinates
                    uniform int  clipEnabled;
                    uniform vec3 clipMin;
                    uniform vec3 clipMax;
                    uniform vec3 boxFdsMin;
                    uniform vec3 boxFdsMax;

                    // Scene-depth occlusion uniforms (Solid-aware mode)
                    uniform int        depthEnabled;
                    uniform sampler2D  sceneDepth;
                    uniform vec2       uResolution;
                    uniform mat4       mvpMatrix;
                    uniform float      uNear;
                    uniform float      uFar;

                    in vec3 vLocalPosition;
                    out vec4 outColor;

                    vec2 hitBox(vec3 origin, vec3 direction) {
                        vec3 safeDirection = direction;
                        if (abs(safeDirection.x) < 0.00001) safeDirection.x = safeDirection.x < 0.0 ? -0.00001 : 0.00001;
                        if (abs(safeDirection.y) < 0.00001) safeDirection.y = safeDirection.y < 0.0 ? -0.00001 : 0.00001;
                        if (abs(safeDirection.z) < 0.00001) safeDirection.z = safeDirection.z < 0.0 ? -0.00001 : 0.00001;
                        vec3 invDirection = 1.0 / safeDirection;
                        vec3 tMinTemp = (vec3(0.0) - origin) * invDirection;
                        vec3 tMaxTemp = (vec3(1.0) - origin) * invDirection;
                        vec3 tMin = min(tMinTemp, tMaxTemp);
                        vec3 tMax = max(tMinTemp, tMaxTemp);
                        float t0 = max(max(tMin.x, tMin.y), tMin.z);
                        float t1 = min(min(tMax.x, tMax.y), tMax.z);
                        return vec2(t0, t1);
                    }

                    vec3 fireColor(float t) {
                        if (t < 0.45) {
                            float local = t / 0.45;
                            return vec3(1.0, mix(0.82, 0.45, local), mix(0.22, 0.04, local));
                        }
                        float local = (t - 0.45) / 0.55;
                        return vec3(mix(1.0, 0.72, local), mix(0.45, 0.03, local), mix(0.04, 0.02, local));
                    }

                    vec3 smokeColor(float raw) {
                        float v = mix(0.065, 0.004, clamp(pow(raw, 0.62) * 1.18, 0.0, 1.0));
                        return vec3(v, v * 0.98, v * 0.95);
                    }

                    void main() {
                        vec3 rayOrigin = (inverseModelMatrix * vec4(cameraPosition, 1.0)).xyz + vec3(0.5);
                        vec3 rayDirection = normalize(vLocalPosition - rayOrigin);
                        vec2 bounds = hitBox(rayOrigin, rayDirection);
                        if (bounds.x > bounds.y) discard;

                        float start = max(bounds.x, 0.0);
                        float end = bounds.y;
                        float dt = (end - start) / float(max(steps, 1));
                        float travel = start + 0.35 * dt;
                        vec4 accum = vec4(0.0);
                        vec3 halfTexel = 0.5 / max(volumeDimensions, vec3(1.0));
                        float pathLength = length(rayDirection * dt * volumeWorldSize);

                        // Scene-depth NDC value at this fragment's screen pixel.
                        // Read once outside the loop — same pixel ray sees the
                        // same scene-depth value at every march step.
                        float sceneNdcZ = 1.0; // 1.0 = far plane, i.e. nothing blocks
                        if (depthEnabled == 1) {
                            vec2 screenUv = gl_FragCoord.xy / uResolution;
                            float sceneWindowZ = texture(sceneDepth, screenUv).r;
                            sceneNdcZ = sceneWindowZ * 2.0 - 1.0;
                            // Sub-pixel jitter on the first march step breaks
                            // up the regular stair-step pattern at OBST edges
                            // into noise the eye perceives as a soft boundary.
                            float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
                            travel += (jitter - 0.5) * dt;
                        }

                        for (int i = 0; i < 256; i++) {
                            if (i >= steps || travel > end || accum.a > 0.96) break;
                            vec3 positionInBox = rayOrigin + rayDirection * (travel + 0.5 * dt);

                            // Solid-aware ray-march. Project sample into clip
                            // space (mvpMatrix = M*V*P prebuilt on JS side).
                            // The fade is computed in LINEAR depth (metres):
                            // NDC z is severely non-linear at typical viewing
                            // distances, so a constant NDC range covers wildly
                            // different physical distances at near vs far —
                            // using NDC made the whole smoke volume fade.
                            float depthFade = 1.0;
                            if (depthEnabled == 1) {
                                vec3 localGeomPos = positionInBox - vec3(0.5);
                                vec4 clipPos = mvpMatrix * vec4(localGeomPos, 1.0);
                                float sampleNdcZ = clipPos.z / clipPos.w;
                                if (sampleNdcZ >= sceneNdcZ) break;
                                // Linear view-space distance (m). For a
                                // perspective projection, clip.w = -viewZ,
                                // and scene depth is unprojected here.
                                float sampleViewZ = clipPos.w;
                                float sceneViewZ = (2.0 * uNear * uFar) /
                                    (uFar + uNear - sceneNdcZ * (uFar - uNear));
                                // ~30 cm fade band before the wall — large
                                // enough to hide ray-march steps, small enough
                                // not to wash out the smoke.
                                depthFade = clamp((sceneViewZ - sampleViewZ) / 0.3, 0.0, 1.0);
                            }

                            vec3 samplePosition = vec3(positionInBox.x, 1.0 - positionInBox.z, positionInBox.y);
                            samplePosition = clamp(samplePosition, halfTexel, vec3(1.0) - halfTexel);

                            // Clip-volume test (FDS coords). After the axis remap above,
                            // samplePosition is ALREADY in FDS axis order:
                            //   samplePosition.x → FDS X, .y → FDS Y, .z → FDS Z
                            if (clipEnabled == 1) {
                                vec3 fdsPos = vec3(
                                    mix(boxFdsMin.x, boxFdsMax.x, samplePosition.x),
                                    mix(boxFdsMin.y, boxFdsMax.y, samplePosition.y),
                                    mix(boxFdsMin.z, boxFdsMax.z, samplePosition.z)
                                );
                                if (fdsPos.x < clipMin.x || fdsPos.x > clipMax.x ||
                                    fdsPos.y < clipMin.y || fdsPos.y > clipMax.y ||
                                    fdsPos.z < clipMin.z || fdsPos.z > clipMax.z) {
                                    travel += dt;
                                    continue;
                                }
                            }

                            vec3 lowFade = smoothstep(vec3(0.0), halfTexel * 3.0, samplePosition);
                            vec3 highFade = 1.0 - smoothstep(vec3(1.0) - halfTexel * 3.0, vec3(1.0), samplePosition);
                            float edgeFade = min(min(lowFade.x * highFade.x, lowFade.y * highFade.y), lowFade.z * highFade.z);
                            float raw = texture(volumeMap, samplePosition).r;

                            // Soft threshold (smoothstep) instead of hard step.
                            // A hard 'raw > threshold' test clips trilinear
                            // gradients at cell walls, which reads as a blocky
                            // voxel pattern. The smoothstep band lets each
                            // sample contribution taper across the cutoff so
                            // adjacent cells blend smoothly.
                            // Band width is in 0..1 (texture units; ~16/255).
                            float thresholdFade = smoothstep(threshold, threshold + 0.06, raw);
                            if (thresholdFade > 0.001) {
                                float t = clamp((raw - threshold) / max(0.001, 1.0 - threshold), 0.0, 1.0);
                                vec3 color = quantityMode == 0 ? smokeColor(raw) : fireColor(t);
                                float alpha = quantityMode == 0
                                    ? 1.0 - exp(-(sootBase + pow(raw, sootExponent) * sootGain) * opacity * pathLength)
                                    : 1.0 - exp(-(fireBase + pow(t, fireExponent) * fireGain) * opacity * pathLength);

                                alpha *= mix(0.60, 1.0, edgeFade);
                                alpha *= depthFade;       // soft cutoff at OBST surfaces (~30 cm)
                                alpha *= thresholdFade;   // soft cutoff at the value threshold (~16/255 band)
                                accum.rgb += (1.0 - accum.a) * color * alpha;
                                accum.a += (1.0 - accum.a) * alpha;
                            }

                            travel += dt;
                        }

                        if (accum.a <= 0.003) discard;
                        outColor = accum;
                    }
                `,
                transparent: true,
                depthWrite: false,
                // depthTest is disabled because the ray-marched volume is
                // rendered on the volume box's BACK face. With depthTest:true,
                // ANY OBST between the camera and that back face occludes the
                // whole pixel ray, killing the smoke even when it sits IN FRONT
                // of the OBST. The correct fix is to sample the scene depth
                // texture inside the shader and stop the ray when it crosses a
                // solid — that needs a two-pass render setup. Until that's
                // added, accept that smoke can bleed through walls so it
                // stays visible everywhere it actually is.
                depthTest: false,
                side: THREE.BackSide,
                blending: volume.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
            });
        }

        _clearGroup() {
            while (this.group.children.length) {
                const child = this.group.children.pop();
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (child.material.map) child.material.map.dispose();
                    if (child.material.uniforms) {
                        const u = child.material.uniforms;
                        if (u.volumeMap && u.volumeMap.value) u.volumeMap.value.dispose();
                        if (u.map && u.map.value) u.map.value.dispose();
                    }
                    child.material.dispose();
                }
            }
        }

        _reset() {
            this._clearGroup();
            this.smvContext = null;
            this.fileMap = new Map();
            this.meshContext = [];
            this.loadedGroups = new Map();
            this.activeKeys = [];
            this.activeFrames = [];
            this.frameIndex = 0;
        }
    }

    global.Smoke3DOverlay = Smoke3DOverlay;
    global.Smoke3DFiles = { parseSmv };
})(window);
