/**
 * Output Page Controller
 *
 * Manages the Output page: greyscale 3D geometry viewer + Layers / Camera /
 * Clip controls on the left, and slice-file controls (Open .sf / Folder) on
 * the right. When a slice file is loaded, a textured plane is rendered into
 * the greyscale scene via SliceOverlay (slice-renderer.js).
 */

(function () {
    'use strict';

    let outputViewer = null;
    let lastData = null;
    let initialized = false;

    let sliceOverlay = null;
    let currentDataset = null;
    let availableGroups = null;
    let availableFiles = null;
    let playbackTimer = null;

    let smokeOverlay = null;
    let smokePlaybackTimer = null;
    let boundaryOverlay = null;
    let boundaryPlaybackTimer = null;
    let agentOverlay = null;
    let agentFile = null;
    let vismapOverlay = null;
    let vismapEngine = null;
    let vismapWaypointSeq = 0;
    let mode = 'smoke'; // 'slice' | 'smoke' | 'boundary' | 'vismap'
    // Module-level handle to wireModeToggle's inner applyMode so other
    // module functions (handleSimulationFolder) can re-run it without
    // refactoring it out of the closure.
    let applyModeRef = null;

    // Shared FDSParser instance used to refresh geometry from a folder's .fds
    const fdsParserForFolder = (typeof FDSParser === 'function') ? new FDSParser() : null;

    // Mesh context (XB/IJK/TRN per mesh) parsed from a folder's .smv file.
    // The .smv is written by FDS itself, so it reflects the grid the
    // simulation actually ran on — the .fds input can disagree (edited after
    // the run, MULT expansion, stretched grids), which would size and place
    // slices wrongly. Preferred over the .fds-derived context when available.
    let smvSliceContext = null;

    function currentSliceContext() {
        if (smvSliceContext) return smvSliceContext;
        return lastData ? SliceFiles.fdsContextFromParsedData(lastData) : null;
    }

    async function refreshSmvContextFromFolder(files) {
        smvSliceContext = null;
        const smvFile = files.find(f => /\.smv$/i.test(f.name));
        if (!smvFile) return;
        try {
            const text = await smvFile.text();
            smvSliceContext = SliceFiles.fdsContextFromSmvText(text, smvFile.name);
        } catch (e) {
            console.warn('Could not parse .smv in folder: ' + smvFile.name, e);
        }
    }

    /**
     * When a folder is opened (slice or smoke mode), look for an .fds file and
     * use it to refresh the greyscale geometry so the loaded simulation matches
     * the slice/smoke data being visualised. Also picks up the .smv mesh
     * context used to place slices in world coordinates.
     */
    async function refreshGeometryFromFolder(files) {
        await refreshSmvContextFromFolder(files);
        if (!fdsParserForFolder) return false;
        const fdsFile = files.find(f => /\.fds$/i.test(f.name));
        if (!fdsFile) return false;
        try {
            const text = await fdsFile.text();
            const parsed = fdsParserForFolder.parse(text);
            // Reuse outputPageSetData so the viewer reloads + re-applies greyscale + re-inits clip panel
            window.outputPageSetData(parsed);
            return true;
        } catch (e) {
            console.warn('Could not parse .fds in folder: ' + fdsFile.name, e);
            return false;
        }
    }

    function ensureViewer() {
        if (outputViewer) return outputViewer;
        const container = document.getElementById('output-viewer-container');
        if (!container) return null;
        outputViewer = new FDSViewer(container);
        // Match the current theme's scene background (set by app.js).
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        outputViewer.setBackground(isLight ? '#e8e8e8' : '#1a1a2e');
        // Greyscale is applied after every loadData
        // Start polling FPS for the readout — once per ~250 ms is enough.
        startFpsPolling();
        return outputViewer;
    }

    // Hook called from app.js applyTheme(). Updates the output viewer's
    // scene background and highlights the matching bg-option swatch in the
    // Output sidebar.
    window.outputPageSetSceneBackground = function (bg) {
        if (outputViewer && typeof outputViewer.setBackground === 'function') {
            outputViewer.setBackground(bg);
        }
        document.querySelectorAll('.output-bg-option').forEach(b => {
            b.classList.toggle('active', b.dataset.color === bg);
        });
    };

    let _fpsPollTimer = null;
    function startFpsPolling() {
        if (_fpsPollTimer) return;
        const readout = document.getElementById('output-smoke-fps-readout');
        if (!readout) return;
        _fpsPollTimer = setInterval(() => {
            if (!outputViewer) return;
            const fps = outputViewer.fps || 0;
            readout.textContent = (fps > 0 ? fps : '--') + ' fps';
        }, 250);
    }

    /**
     * Called by app.js when an .fds file is loaded so the Output page has
     * the same parsed model available when the user switches to it.
     */
    window.outputPageSetData = function (data) {
        lastData = data;
        if (outputViewer) {
            outputViewer.loadData(data);
            // Respect the Grayscale checkbox state. Default ON — Output is
            // for viewing simulation results, so a neutral greyscale backdrop
            // makes slice/boundary/smoke overlays stand out.
            const grayChk = document.getElementById('output-scene-grayscale');
            const grayOn = grayChk ? grayChk.checked : true;
            outputViewer.setGrayscale(grayOn);
            outputViewer._onResize();
            updateDropZone();
            initClipPanel(outputViewer);
        }
    };

    /**
     * Called by app.js when the user navigates AWAY from the Output tab.
     * Cleans up modes that don't make sense off-page (walk mode primarily,
     * which captures keyboard + pointer lock and would otherwise leak).
     */
    window.outputPageDeactivate = function () {
        if (outputViewer && outputViewer.walkMode) outputViewer.exitWalkMode();
    };

    /**
     * Called by app.js when the Output tab is activated.
     */
    window.outputPageActivate = function () {
        const v = ensureViewer();
        if (!v) return;
        if (!initialized) {
            wireControls(v);
            initialized = true;
        }
        if (lastData) {
            // Re-load if first activation or data changed since last load
            if (!v._lastLoadedData || v._lastLoadedData !== lastData) {
                v.loadData(lastData);
                v._lastLoadedData = lastData;
                v.setGrayscale(true);
                initClipPanel(v);
            }
            updateDropZone();
        }
        // Resize on activation so the canvas matches its new visible size
        setTimeout(() => v._onResize(), 0);
    };

    function updateDropZone() {
        const dz = document.getElementById('output-drop-zone');
        if (!dz) return;
        if (lastData) dz.classList.add('hidden');
        else dz.classList.remove('hidden');
    }

    function wireControls(viewer) {
        // Layer toggles
        document.querySelectorAll('.output-layer-toggle').forEach(toggle => {
            toggle.addEventListener('change', (e) => {
                viewer.setVisibility(toggle.dataset.layer, e.target.checked);
            });
        });

        // Bulk show/hide all
        function setAllOutputLayers(visible) {
            document.querySelectorAll('.output-layer-toggle').forEach(toggle => {
                toggle.checked = visible;
                viewer.setVisibility(toggle.dataset.layer, visible);
            });
        }
        const showAllBtn = document.getElementById('output-layer-show-all');
        const hideAllBtn = document.getElementById('output-layer-hide-all');
        if (showAllBtn) showAllBtn.addEventListener('click', () => setAllOutputLayers(true));
        if (hideAllBtn) hideAllBtn.addEventListener('click', () => setAllOutputLayers(false));

        // Grayscale toggle (default ON on Output)
        const grayChk = document.getElementById('output-scene-grayscale');
        if (grayChk) grayChk.addEventListener('change', () => {
            viewer.setGrayscale(grayChk.checked);
        });

        // OBST edge wireframe toggle (same control as 3D Geometry sidebar)
        const obstEdgesIn = document.getElementById('output-show-obst-edges');
        if (obstEdgesIn) obstEdgesIn.addEventListener('change', () => {
            viewer.setShowObstEdges(obstEdgesIn.checked);
        });

        // Opacity — applies to ALL geometry (meshes, OBSTs, vents, devices, ...)
        // but NOT to slice/smoke overlays (which carry the _isSliceOverlay flag).
        const opSlider = document.getElementById('output-opacity-slider');
        const opValue = document.getElementById('output-opacity-value');
        if (opSlider) {
            opSlider.addEventListener('input', (e) => {
                const v = parseFloat(e.target.value);
                viewer.setSceneOpacity(v);
                opValue.textContent = Math.round(v * 100) + '%';
            });
            opSlider.addEventListener('keydown', (e) => {
                if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
                    e.preventDefault();
                    opSlider.blur();
                }
            });
        }

        // Camera views
        document.querySelectorAll('[data-output-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                viewer.setView(btn.dataset.outputView);
            });
        });
        const resetBtn = document.getElementById('output-reset-camera');
        if (resetBtn) resetBtn.addEventListener('click', () => viewer.resetCamera());

        // ── Walk Mode (FPS) — drives 'output-walk-hud' overlay ──
        const walkBtn   = document.getElementById('output-walk-mode-btn');
        const walkEyeIn = document.getElementById('output-walk-eye-height');
        const walkEyeOut= document.getElementById('output-walk-eye-height-val');
        const walkSpdIn = document.getElementById('output-walk-speed');
        const walkSpdOut= document.getElementById('output-walk-speed-val');

        function syncOutputWalkBtn() {
            if (!walkBtn) return;
            if (viewer.walkMode) {
                walkBtn.textContent = 'Exit walk mode';
                walkBtn.classList.add('active');
            } else {
                walkBtn.textContent = 'Enter walk mode';
                walkBtn.classList.remove('active');
            }
        }
        if (walkBtn) walkBtn.addEventListener('click', () => {
            if (!lastData) { alert('Load an FDS file first.'); return; }
            if (viewer.walkMode) viewer.exitWalkMode();
            else viewer.enterWalkMode('output-walk-hud');
            syncOutputWalkBtn();
        });
        // Viewer auto-exits on Escape / page change — keep button label in sync.
        const outputContainer = document.getElementById('output-viewer-container');
        if (outputContainer) outputContainer.addEventListener('walkModeChanged', syncOutputWalkBtn);
        if (walkEyeIn) walkEyeIn.addEventListener('input', () => {
            const v = parseFloat(walkEyeIn.value);
            viewer.walkEyeHeight = v;
            if (walkEyeOut) walkEyeOut.textContent = v.toFixed(2) + ' m';
        });
        if (walkSpdIn) walkSpdIn.addEventListener('input', () => {
            const v = parseFloat(walkSpdIn.value);
            viewer.walkSpeed = v;
            if (walkSpdOut) walkSpdOut.textContent = v.toFixed(1) + ' m/s';
        });

        // Background
        const bgOptions = document.querySelectorAll('.output-bg-option');
        bgOptions.forEach(btn => {
            btn.addEventListener('click', () => {
                bgOptions.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                viewer.setBackground(btn.dataset.color);
            });
        });

        // Clip panel
        wireClipPanel(viewer);

        // Mode toggle (Slice vs Smoke)
        wireModeToggle(viewer);

        // Slice file controls
        wireSliceControls(viewer);

        // Smoke3D controls
        wireSmokeControls(viewer);

        // Boundary (BNDF) controls
        wireBoundaryControls(viewer);

        wireVismapControls(viewer);

        // Agent trajectory overlay controls
        wireAgents(viewer);

        // Projection toggle (perspective / orthographic) — floating button
        // bottom-right of the output viewer canvas.
        const projBtn = document.getElementById('output-proj-toggle');
        if (projBtn) {
            const refresh = () => {
                const ortho = viewer.getProjection() === 'orthographic';
                projBtn.classList.toggle('is-ortho', ortho);
                projBtn.title = ortho ? 'Switch to perspective projection' : 'Switch to orthographic projection';
                const lbl = projBtn.querySelector('.proj-toggle-label');
                if (lbl) lbl.textContent = ortho ? 'Ortho' : 'Persp';
            };
            projBtn.addEventListener('click', () => {
                viewer.setProjection(viewer.getProjection() === 'orthographic' ? 'perspective' : 'orthographic');
                refresh();
            });
            refresh();
        }
    }

    // ── Mode toggle (Slice / Smoke / Boundary / Vismap) ────────────────────
    function wireModeToggle(viewer) {
        const sliceBtn = document.getElementById('output-mode-slice');
        const smokeBtn = document.getElementById('output-mode-smoke');
        const boundaryBtn = document.getElementById('output-mode-boundary');
        const vismapBtn = document.getElementById('output-mode-vismap');
        const slicePanel = document.getElementById('output-slice-controls');
        const smokePanel = document.getElementById('output-smoke-controls');
        const boundaryPanel = document.getElementById('output-boundary-controls');
        const vismapPanel = document.getElementById('output-vismap-controls');
        if (!sliceBtn || !smokeBtn) return;

        function applyMode(next) {
            mode = next;
            sliceBtn.classList.toggle('active', mode === 'slice');
            smokeBtn.classList.toggle('active', mode === 'smoke');
            if (boundaryBtn) boundaryBtn.classList.toggle('active', mode === 'boundary');
            if (vismapBtn) vismapBtn.classList.toggle('active', mode === 'vismap');
            if (slicePanel) slicePanel.style.display = mode === 'slice' ? '' : 'none';
            if (smokePanel) smokePanel.style.display = mode === 'smoke' ? '' : 'none';
            if (boundaryPanel) boundaryPanel.style.display = mode === 'boundary' ? '' : 'none';
            if (vismapPanel) vismapPanel.style.display = mode === 'vismap' ? '' : 'none';

            // Hide the inactive overlay; keep colours intact
            if (sliceOverlay) {
                if (sliceOverlay.mesh) sliceOverlay.mesh.visible = mode === 'slice';
                if (sliceOverlay.outline) sliceOverlay.outline.visible = mode === 'slice';
            }
            if (smokeOverlay) smokeOverlay.setVisible(mode === 'smoke');
            if (boundaryOverlay) boundaryOverlay.setVisible(mode === 'boundary');
            if (vismapOverlay) vismapOverlay.setVisible(mode === 'vismap');

            // Colorbar is meaningful for any quantity-mapped overlay — slice and
            // boundary both have a quantity, units and a value range to legend.
            // Smoke mode has no fixed numeric range (it's a transfer function),
            // so the bar stays hidden there. Vismap manages the bar itself
            // (shown for the time-valued ASET map, hidden for boolean maps).
            const cb = document.getElementById('output-colorbar');
            if (cb) cb.style.display = (mode === 'slice' || mode === 'boundary') ? '' : 'none';
            if (mode === 'boundary') refreshBoundaryColorbar();
            else if (mode === 'slice') refreshColorbar();
            else if (mode === 'vismap') renderVismapMap();

            // Sync overlay play bar to newly active mode
            const vpBtn = document.getElementById('output-vp-play-btn');
            if (vpBtn) vpBtn.innerHTML = '&#9654;'; // reset to play icon on switch
            // Default-disable the shared viewport play bar. The conditional
            // branches below re-enable it only when the active mode's overlay
            // has actual frames loaded — otherwise it stays disabled. Stops
            // a stale slice-frame configuration from leaking into Soot or
            // Boundary tabs that haven't been explicitly loaded yet.
            const _vpSliderReset = document.getElementById('output-vp-slider');
            const _vpTimeReset   = document.getElementById('output-vp-time');
            if (_vpSliderReset) { _vpSliderReset.disabled = true; _vpSliderReset.value = 0; _vpSliderReset.min = 0; _vpSliderReset.max = 0; }
            if (vpBtn)          vpBtn.disabled = true;
            if (_vpTimeReset)   _vpTimeReset.textContent = '0.000 s';
            if (mode === 'smoke' && smokeOverlay && smokeOverlay.activeFrames.length) {
                const vpSlider = document.getElementById('output-vp-slider');
                const vpTime   = document.getElementById('output-vp-time');
                const n = smokeOverlay.activeFrames.length;
                if (vpSlider) { vpSlider.min = 0; vpSlider.max = n - 1; vpSlider.value = smokeOverlay.frameIndex; vpSlider.disabled = n <= 1; }
                if (vpBtn)    vpBtn.disabled = n <= 1;
                if (vpTime)   vpTime.textContent = smokeOverlay.currentTime().toFixed(3) + ' s';
            } else if (mode === 'boundary' && boundaryOverlay && boundaryOverlay.activeFrames.length) {
                const vpSlider = document.getElementById('output-vp-slider');
                const vpTime   = document.getElementById('output-vp-time');
                const n = boundaryOverlay.activeFrames.length;
                if (vpSlider) { vpSlider.min = 0; vpSlider.max = n - 1; vpSlider.value = boundaryOverlay.frameIndex; vpSlider.disabled = n <= 1; }
                if (vpBtn)    vpBtn.disabled = n <= 1;
                if (vpTime)   vpTime.textContent = boundaryOverlay.currentTime().toFixed(3) + ' s';
            } else if (mode === 'slice' && currentDataset) {
                const vpSlider = document.getElementById('output-vp-slider');
                const vpTime   = document.getElementById('output-vp-time');
                const n = currentDataset.frames.length;
                if (vpSlider) { vpSlider.min = 0; vpSlider.max = n - 1; vpSlider.value = sliceOverlay ? sliceOverlay.frameIndex : 0; vpSlider.disabled = n <= 1; }
                if (vpBtn)    vpBtn.disabled = n <= 1;
                if (vpTime && sliceOverlay) vpTime.textContent = (currentDataset.frames[sliceOverlay.frameIndex]?.time || 0).toFixed(3) + ' s';
            }
            syncAgents();

            // Pause playback for the modes that are no longer active
            if (mode !== 'slice') stopPlayback();
            if (mode !== 'smoke') stopSmokePlayback();
            if (mode !== 'boundary') stopBoundaryPlayback();
            if (mode !== 'vismap') stopVismapPlayback();
        }

        sliceBtn.addEventListener('click', () => applyMode('slice'));
        smokeBtn.addEventListener('click', () => applyMode('smoke'));
        if (boundaryBtn) boundaryBtn.addEventListener('click', () => applyMode('boundary'));
        if (vismapBtn) vismapBtn.addEventListener('click', () => applyMode('vismap'));

        // Expose to module scope so handleSimulationFolder can replay the
        // current-mode setup after the slice auto-load mucks with the
        // shared viewport overlays.
        applyModeRef = applyMode;
    }

    // ── Slice loading + rendering ──────────────────────────────────────────
    function setStatus(msg, isError) {
        const el = document.getElementById('output-status-line');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#e94560' : '';
    }

    // ── Colorbar helpers ──────────────────────────────────────────────────
    function formatColorbarValue(v) {
        if (!Number.isFinite(v)) return '--';
        if (Math.abs(v) >= 10000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(2);
        return v.toFixed(1);
    }

    function drawColorbarCanvas(mapName) {
        const canvas = document.getElementById('output-colorbar-canvas');
        if (!canvas || typeof SliceColorMap === 'undefined') return;
        const ctx = canvas.getContext('2d');
        const h = canvas.height;
        for (let y = 0; y < h; y++) {
            const t = 1 - y / (h - 1);
            const c = SliceColorMap.colorMap(t, mapName);
            ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
            ctx.fillRect(0, y, canvas.width, 1);
        }
    }

    function updateColorbar(quantity, units, min, max, mapName) {
        const label = document.getElementById('output-colorbar-label');
        const maxEl = document.getElementById('output-colorbar-max');
        const minEl = document.getElementById('output-colorbar-min');
        if (label) label.textContent = quantity + (units ? ' (' + units + ')' : '');
        if (maxEl) maxEl.textContent = formatColorbarValue(max);
        if (minEl) minEl.textContent = formatColorbarValue(min);
        drawColorbarCanvas(mapName);
    }

    // Recompute colorbar labels from current overlay state — call after dataset load
    // or when settings change, but NOT every frame.
    function refreshColorbar() {
        if (!sliceOverlay || !currentDataset) return;
        const range = sliceOverlay.getCurrentRange();
        updateColorbar(
            currentDataset.quantity || '',
            currentDataset.units || '',
            range.min, range.max,
            sliceOverlay.mapName
        );
    }

    // Same role for the boundary overlay. Pulls quantity/units from the active
    // group and the latest min/max recomputed every frame by _resolveRange().
    // Safe to call when no boundary data is loaded (early-returns).
    function refreshBoundaryColorbar() {
        if (!boundaryOverlay || !boundaryOverlay.activeGroup) return;
        const range = boundaryOverlay.lastRange || { min: 0, max: 1 };
        updateColorbar(
            boundaryOverlay.activeGroup.quantity || '',
            boundaryOverlay.activeGroup.units || '',
            range.min, range.max,
            boundaryOverlay.colorMap
        );
    }

    // The play bar is always visible (disabled until data loads).
    // This function now only toggles the colorbar — kept for compatibility with existing call sites.
    function showViewerOverlay(_visible, hideColorbar) {
        const cb = document.getElementById('output-colorbar');
        if (cb) cb.style.display = hideColorbar ? 'none' : '';
    }

    // ── Sync all frame UI (sidebar + overlay) ─────────────────────────────
    function syncFrameUI(frameIdx, time) {
        const sideSlider = document.getElementById('output-frame-slider');
        const sideReadout = document.getElementById('output-frame-readout');
        const vpSlider = document.getElementById('output-vp-slider');
        const vpTime = document.getElementById('output-vp-time');
        const timeStr = time.toFixed(3) + ' s';
        if (sideSlider) sideSlider.value = frameIdx;
        if (sideReadout) sideReadout.textContent = timeStr;
        if (vpSlider) vpSlider.value = frameIdx;
        if (vpTime) vpTime.textContent = timeStr;
    }

    function formatRangeInput(v) {
        if (!Number.isFinite(v)) return '';
        const abs = Math.abs(v);
        if (abs >= 100000 || (abs < 0.001 && abs > 0)) return v.toExponential(3);
        return parseFloat(v.toFixed(2)).toString();
    }

    // Compute the auto range across ALL frames and write it into the Min/Max
    // inputs + overlay. Called on dataset load, by the ↺ Auto button and when
    // the range-mode dropdown changes. Two modes: global min/max (the bounds
    // Smokeview's research mode shows) or a global 2–98 % percentile band for
    // contrast when outlier cells stretch the full range. Both span the whole
    // time series — a per-frame range collapses on typical fire slices
    // (nearly all cells at ambient) and saturates the render.
    function resetRangeToAuto() {
        if (!sliceOverlay || !currentDataset) return;
        const modeSel = document.getElementById('output-range-mode');
        const usePercentile = modeSel && modeSel.value === 'percentile';
        let range = usePercentile
            ? SliceUtil.computeGlobalPercentileRange(currentDataset, 0.02, 0.98)
            : SliceUtil.computeGlobalRange(currentDataset);
        if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) {
            const prev = sliceOverlay.autoRange;
            sliceOverlay.autoRange = true;
            sliceOverlay.robustRange = true;
            range = sliceOverlay.getCurrentRange();
            sliceOverlay.autoRange = prev;
        }
        sliceOverlay.autoRange = false;
        sliceOverlay.setManualRange(range.min, range.max);
        const minIn = document.getElementById('output-range-min');
        const maxIn = document.getElementById('output-range-max');
        if (minIn) minIn.value = formatRangeInput(range.min);
        if (maxIn) maxIn.value = formatRangeInput(range.max);
        refreshColorbar();
    }

    function ensureOverlay(viewer) {
        if (!sliceOverlay) {
            sliceOverlay = new SliceOverlay(viewer.scene);
            // Always use manual range after initial load — no per-frame auto updates.
            sliceOverlay.autoRange = false;
            sliceOverlay.robustRange = true;
            sliceOverlay.onAfterRender = (info) => {
                syncFrameUI(info.frameIndex, info.time);
                // Colorbar and range inputs are stable — only refreshed on explicit user action.
            };
            // Inherit whatever rendering mode the dropdown is currently on,
            // so first slice load respects the user's choice without waiting
            // for another dropdown change.
            const renderSel = document.getElementById('output-slice-render');
            if (renderSel) sliceOverlay.renderMode = renderSel.value === 'depth' ? 'depth' : 'basic';
        }
        return sliceOverlay;
    }

    function updateMetadata(dataset) {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        if (!dataset) {
            set('output-meta-quantity', '--');
            set('output-meta-short', '--');
            set('output-meta-units', '--');
            set('output-meta-indices', '--');
            set('output-meta-frames', '--');
            set('output-meta-plane', '--');
            return;
        }
        const idx = dataset.indices;
        set('output-meta-quantity', dataset.quantity || '--');
        set('output-meta-short', dataset.shortName || '--');
        set('output-meta-units', dataset.units || '--');
        set('output-meta-indices',
            'i=[' + idx.i1 + ',' + idx.i2 + '] j=[' + idx.j1 + ',' + idx.j2 + '] k=[' + idx.k1 + ',' + idx.k2 + ']');
        set('output-meta-frames', dataset.frames.length);
        const planeLabel = idx.i1 === idx.i2 ? 'YZ @ i=' + idx.i1
                         : idx.j1 === idx.j2 ? 'XZ @ j=' + idx.j1
                         : idx.k1 === idx.k2 ? 'XY @ k=' + idx.k1 : '3D';
        set('output-meta-plane', planeLabel);
    }

    function configureFrameSlider(dataset, initialFrame) {
        const maxFrame = Math.max(0, dataset.frames.length - 1);
        const idx = initialFrame || 0;
        const canPlay = dataset.frames.length > 1;

        const slider = document.getElementById('output-frame-slider');
        const playBtn = document.getElementById('output-play-button');
        if (slider) { slider.min = 0; slider.max = maxFrame; slider.value = idx; slider.disabled = !canPlay; }
        if (playBtn) playBtn.disabled = !canPlay;

        const vpSlider = document.getElementById('output-vp-slider');
        const vpPlay = document.getElementById('output-vp-play-btn');
        if (vpSlider) { vpSlider.min = 0; vpSlider.max = maxFrame; vpSlider.value = idx; vpSlider.disabled = !canPlay; }
        if (vpPlay) vpPlay.disabled = !canPlay;

        // Guard zero-frame datasets — dataset.frames[idx] may be undefined.
        const frame = dataset.frames[idx];
        const timeStr = frame && typeof frame.time === 'number'
            ? frame.time.toFixed(3) + ' s'
            : '—';
        const fr = document.getElementById('output-frame-readout');
        if (fr) fr.textContent = timeStr;
        const vpTime = document.getElementById('output-vp-time');
        if (vpTime) vpTime.textContent = timeStr;
    }

    function loadDatasetIntoOverlay(viewer, dataset, displayName) {
        const fdsContext = currentSliceContext();
        const overlay = ensureOverlay(viewer);
        overlay.setDataset(dataset, fdsContext);

        currentDataset = dataset;
        updateMetadata(dataset);
        configureFrameSlider(dataset, overlay.frameIndex);
        resetRangeToAuto();
        showViewerOverlay(true);

        const fileNameEl = document.getElementById('output-slice-file-name');
        if (fileNameEl) fileNameEl.textContent = displayName;
        setStatus('Loaded ' + dataset.frames.length + ' frame(s) from ' + displayName + '.');
    }

    async function handleOpenSf(viewer, file) {
        try {
            stopPlayback();
            setStatus('Loading ' + file.name + '...');
            const buf = await file.arrayBuffer();
            const dataset = FdsSliceReader.parse(buf);
            const info = SliceFiles.parseSliceFilename(file.name);
            if (info) dataset.sourceMeshIndex = info.meshIndex;
            loadDatasetIntoOverlay(viewer, dataset, file.name);
            resetSliceSetSelector();
        } catch (e) {
            console.error(e);
            setStatus(e.message, true);
        }
    }

    async function handleFolder(viewer, files) {
        try {
            stopPlayback();
            setStatus('Scanning folder...');
            // Update the greyscale geometry from any .fds file in the folder
            await refreshGeometryFromFolder(files);
            const sliceFiles = files.filter(f => /\.sf$/i.test(f.name));
            if (sliceFiles.length === 0) {
                setStatus('No .sf files found in folder.', true);
                return;
            }
            availableFiles = sliceFiles;
            availableGroups = await SliceFiles.describeSliceGroups(sliceFiles);
            if (availableGroups.length === 0) {
                setStatus('No FDS slice files named like CHID_M_N.sf were found.', true);
                resetSliceSetSelector();
                return;
            }
            populateSliceSetSelector(availableGroups);
            refreshVismapQuantityOptions();
            // Pick the largest group by default
            const chosen = availableGroups.slice().sort(
                (a, b) => b.items.length - a.items.length || a.sliceIndex - b.sliceIndex)[0];
            const sel = document.getElementById('output-slice-set-select');
            if (sel) sel.value = chosen.key;
            await loadSliceSet(viewer, chosen);
        } catch (e) {
            console.error(e);
            setStatus(e.message, true);
        }
    }

    function populateSliceSetSelector(groups) {
        const sel = document.getElementById('output-slice-set-select');
        if (!sel) return;
        sel.innerHTML = '';
        for (const g of groups) {
            const opt = document.createElement('option');
            opt.value = g.key;
            opt.textContent = g.label;
            sel.appendChild(opt);
        }
        sel.disabled = false;
    }

    function resetSliceSetSelector() {
        const sel = document.getElementById('output-slice-set-select');
        if (!sel) return;
        sel.innerHTML = '<option value="">No slice sets loaded</option>';
        sel.disabled = true;
        availableGroups = null;
    }

    /** Read a slice group's files and return the (stitched) dataset plus a
     *  display name. Shared by the Slice and Vismap modes. */
    async function datasetFromSliceGroup(group) {
        const items = group.items.slice().sort((a, b) => a.info.meshIndex - b.info.meshIndex);
        if (items.length === 1) {
            const buf = await items[0].file.arrayBuffer();
            const ds = FdsSliceReader.parse(buf);
            ds.sourceMeshIndex = items[0].info.meshIndex;
            return { dataset: ds, displayName: items[0].file.name };
        }
        const parts = [];
        for (const item of items) {
            const buf = await item.file.arrayBuffer();
            parts.push({
                meshIndex: item.info.meshIndex,
                fileName: item.file.name,
                dataset: FdsSliceReader.parse(buf),
            });
        }
        // Pass the mesh context so combineSliceDatasets can use physical mesh
        // extents (XB/IJK) to (a) deduplicate per-mesh boundary slices that
        // point at the same plane, and (b) pick the correct stitch layout
        // instead of guessing from dims.
        const ds = SliceFiles.combineSliceDatasets(parts, currentSliceContext());
        return { dataset: ds, displayName: ds.displayName };
    }

    async function loadSliceSet(viewer, group) {
        try {
            setStatus('Loading slice set ' + group.sliceIndex + '...');
            const { dataset, displayName } = await datasetFromSliceGroup(group);
            loadDatasetIntoOverlay(viewer, dataset, displayName);
        } catch (e) {
            console.error(e);
            setStatus(e.message, true);
        }
    }

    function setPlayIcons(playing) {
        const lbl = document.getElementById('output-play-label');
        if (lbl) lbl.textContent = playing ? 'Pause' : 'Play';
        const vpBtn = document.getElementById('output-vp-play-btn');
        if (vpBtn) vpBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
    }

    function stopPlayback() {
        if (playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = null;
            setPlayIcons(false);
        }
    }

    function startPlayback() {
        if (!currentDataset || !sliceOverlay) return;
        setPlayIcons(true);
        playbackTimer = setInterval(() => {
            const next = (sliceOverlay.frameIndex + 1) % currentDataset.frames.length;
            sliceOverlay.setFrame(next);
            syncAgents();
        }, 80);
    }

    // Single-folder picker shared across Soot / Slice / Boundary panels. The
    // user just points at the sim folder once and we scan it for every kind
    // of output present — .s3d (smoke), .sf (slices) and .bf (boundary
    // patches) — so switching modes afterwards "just works" without re-picking.
    // Each per-mode handler still owns its own UI population + status text;
    // failures in one mode don't block the others.
    async function handleSimulationFolder(viewer, files) {
        await refreshGeometryFromFolder(files);
        await Promise.allSettled([
            handleSmokeFolder(viewer, files),
            handleFolder(viewer, files),         // slice
            handleBoundaryFolder(viewer, files),
        ]);
        // Re-run the current mode's setup. The slice auto-load configured
        // the shared overlays (mesh visibility, play bar, colorbar) for
        // SLICE state regardless of which tab the user is on. Calling
        // applyMode(mode) re-asserts everything for the actual active mode:
        //   - hides the slice plane if user is on Soot/Boundary
        //   - hides the colorbar in Soot (no fixed numeric range)
        //   - default-disables the play bar unless THIS mode has frames
        // Cheaper than tracking down every shared piece of state by hand.
        if (typeof applyModeRef === 'function') applyModeRef(mode);
    }

    function wireSliceControls(viewer) {
        const folder = document.getElementById('output-slice-folder');
        if (folder) folder.addEventListener('change', (e) => {
            const fs = Array.from(e.target.files || []);
            if (fs.length) handleSimulationFolder(viewer, fs);
        });
        const setSel = document.getElementById('output-slice-set-select');
        if (setSel) setSel.addEventListener('change', () => {
            if (!availableGroups) return;
            const g = availableGroups.find(x => x.key === setSel.value);
            if (g) loadSliceSet(viewer, g);
        });

        // Sidebar frame slider
        const frameSlider = document.getElementById('output-frame-slider');
        if (frameSlider) frameSlider.addEventListener('input', () => {
            if (!sliceOverlay) return;
            sliceOverlay.setFrame((parseInt(frameSlider.value, 10) || 0));
            syncAgents();
        });

        // Overlay play bar slider — dispatches to whichever mode is active
        const vpSlider = document.getElementById('output-vp-slider');
        if (vpSlider) vpSlider.addEventListener('input', () => {
            if (mode === 'smoke') {
                if (!smokeOverlay) return;
                smokeOverlay.setFrame((parseInt(vpSlider.value, 10) || 0));
                const vpTime = document.getElementById('output-vp-time');
                if (vpTime) vpTime.textContent = smokeOverlay.currentTime().toFixed(3) + ' s';
                const smokeReadout = document.getElementById('output-smoke-frame-readout');
                const smokeSlider  = document.getElementById('output-smoke-frame-slider');
                if (smokeReadout) smokeReadout.textContent = smokeOverlay.currentTime().toFixed(3) + ' s';
                if (smokeSlider)  smokeSlider.value = vpSlider.value;
            } else if (mode === 'boundary') {
                if (!boundaryOverlay) return;
                boundaryOverlay.setFrame((parseInt(vpSlider.value, 10) || 0));
                const vpTime = document.getElementById('output-vp-time');
                if (vpTime) vpTime.textContent = boundaryOverlay.currentTime().toFixed(3) + ' s';
                const bReadout = document.getElementById('output-boundary-frame-readout');
                const bSlider  = document.getElementById('output-boundary-frame-slider');
                if (bReadout) bReadout.textContent = boundaryOverlay.currentTime().toFixed(3) + ' s';
                if (bSlider)  bSlider.value = vpSlider.value;
                refreshBoundaryColorbar();
            } else {
                if (!sliceOverlay) return;
                sliceOverlay.setFrame((parseInt(vpSlider.value, 10) || 0));
            }
            syncAgents();
        });

        // Sidebar play button
        const playBtn = document.getElementById('output-play-button');
        if (playBtn) playBtn.addEventListener('click', () => {
            if (playbackTimer) stopPlayback();
            else startPlayback();
        });

        // Overlay play button — dispatches to whichever mode is active
        const vpPlay = document.getElementById('output-vp-play-btn');
        if (vpPlay) vpPlay.addEventListener('click', () => {
            if (mode === 'smoke') {
                if (smokePlaybackTimer) stopSmokePlayback();
                else startSmokePlayback();
            } else if (mode === 'boundary') {
                if (boundaryPlaybackTimer) stopBoundaryPlayback();
                else startBoundaryPlayback();
            } else {
                if (playbackTimer) stopPlayback();
                else startPlayback();
            }
        });

        const colorSel = document.getElementById('output-color-map');
        if (colorSel) colorSel.addEventListener('change', () => {
            if (!sliceOverlay) return;
            sliceOverlay.setColorMap(colorSel.value);
            refreshColorbar();
        });

        // Slice rendering mode (Basic / Solid-aware) — same idea as the
        // smoke dropdown but for the slice plane.
        const sliceRenderSel = document.getElementById('output-slice-render');
        if (sliceRenderSel) sliceRenderSel.addEventListener('change', () => {
            if (sliceOverlay) sliceOverlay.setRenderMode(sliceRenderSel.value);
        });

        const minIn = document.getElementById('output-range-min');
        const maxIn = document.getElementById('output-range-max');
        const commitRange = () => {
            if (!sliceOverlay) return;
            const mn = parseFloat(minIn ? minIn.value : NaN);
            const mx = parseFloat(maxIn ? maxIn.value : NaN);
            if (Number.isFinite(mn) && Number.isFinite(mx)) {
                sliceOverlay.setManualRange(mn, mx);
                refreshColorbar();
            }
        };
        if (minIn) minIn.addEventListener('change', commitRange);
        if (maxIn) maxIn.addEventListener('change', commitRange);

        const resetRangeBtn = document.getElementById('output-reset-range');
        if (resetRangeBtn) resetRangeBtn.addEventListener('click', resetRangeToAuto);
        const rangeModeSel = document.getElementById('output-range-mode');
        if (rangeModeSel) rangeModeSel.addEventListener('change', resetRangeToAuto);

    }

    // ── Smoke3D loading + rendering ────────────────────────────────────────
    function setSmokeStatus(msg, isError) {
        const el = document.getElementById('output-smoke-status');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#e94560' : '';
    }

    function ensureSmokeOverlay(viewer) {
        if (!smokeOverlay)
            smokeOverlay = new Smoke3DOverlay(viewer.scene, viewer.camera, viewer.controls, viewer.renderer);
        if (!agentOverlay) agentOverlay = new AgentOverlay(viewer.scene);
        return smokeOverlay;
    }

    // The simulation time currently shown by the active smoke/slice/boundary overlay.
    function activeDisplayTime() {
        if (mode === 'smoke' && smokeOverlay && smokeOverlay.activeFrames.length) return smokeOverlay.currentTime();
        if (mode === 'boundary' && boundaryOverlay && boundaryOverlay.activeFrames.length) return boundaryOverlay.currentTime();
        if (mode === 'slice' && sliceOverlay && currentDataset && currentDataset.frames.length) {
            const fr = currentDataset.frames[sliceOverlay.frameIndex];
            return fr ? fr.time : 0;
        }
        return null;
    }

    // Keep agents on the same simulation second as the active overlay.
    function syncAgents() {
        if (!agentOverlay || !agentOverlay.dataset) return;
        const t = activeDisplayTime();
        if (t !== null) agentOverlay.setTime(t);
        const slider = document.getElementById('output-agents-frame-slider');
        const tlabel = document.getElementById('output-agents-time');
        if (slider) slider.value = agentOverlay.frameIndex;
        if (tlabel) tlabel.textContent = agentOverlay.currentTime().toFixed(3) + ' s';
    }

    // HRRPUV threshold helpers — convert between the slider's 0–255 byte
    // and the kW/m³ range stored in the .smv. Smokeview's default cutoff is
    // 200 kW/m³ (HRRPUVCUT).
    const SMOKEVIEW_HRR_CUTOFF = 200;
    function getHrrpuvRange() {
        if (!smokeOverlay || !smokeOverlay.smvContext) return null;
        for (const g of smokeOverlay.smvContext.groups.values()) {
            if (/^HRRPUV$/i.test(g.quantity) && g.scale && Array.isArray(g.scale)) {
                return [Number(g.scale[0]) || 0, Number(g.scale[1]) || 1];
            }
        }
        return null;
    }
    function hrrByteToKw(byte, range) {
        return range[0] + (byte / 255) * (range[1] - range[0]);
    }
    function hrrKwToByte(kw, range) {
        const span = range[1] - range[0];
        if (span <= 0) return 0;
        return Math.max(0, Math.min(255, Math.round(((kw - range[0]) / span) * 255)));
    }
    function refreshHrrKwReadout() {
        const kwEl = document.getElementById('output-smoke-hrr-thresh-kw');
        const smvBtn = document.getElementById('output-smoke-hrr-thresh-smv');
        const slider = document.getElementById('output-smoke-hrr-thresh');
        if (!kwEl || !slider) return;
        const range = getHrrpuvRange();
        if (!range) {
            kwEl.textContent = '—';
            if (smvBtn) smvBtn.disabled = true;
            return;
        }
        const kw = hrrByteToKw(parseInt(slider.value, 10) || 0, range);
        kwEl.textContent = (kw < 10 ? kw.toFixed(1) : Math.round(kw)) + ' kW/m³';
        if (smvBtn) smvBtn.disabled = false;
    }

    function updateSmokeMetadata() {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        const filesDetails = document.getElementById('output-smoke-files-details');
        const filesList = document.getElementById('output-smoke-files-list');
        if (!smokeOverlay || !smokeOverlay.smvContext) {
            set('output-smoke-meta-smv', '--');
            set('output-smoke-meta-meshes', '--');
            set('output-smoke-meta-soot', '--');
            set('output-smoke-meta-hrr', '--');
            if (filesDetails) filesDetails.style.display = 'none';
            if (filesList) filesList.innerHTML = '';
            refreshHrrKwReadout();
            return;
        }
        const ctx = smokeOverlay.smvContext;
        set('output-smoke-meta-smv', ctx.fileName);
        set('output-smoke-meta-meshes', smokeOverlay.meshContext.length);
        let sootCount = 0, hrrCount = 0;
        for (const g of ctx.groups.values()) {
            if (/SOOT/i.test(g.quantity)) sootCount = g.entries.length;
            if (/^HRRPUV$/i.test(g.quantity)) hrrCount = g.entries.length;
        }
        set('output-smoke-meta-soot', sootCount ? sootCount + ' files' : '--');
        set('output-smoke-meta-hrr', hrrCount ? hrrCount + ' files' : '--');

        // Flatten every .s3d file across every quantity group into a single
        // list so the user can verify exactly what the folder contributed.
        if (filesDetails && filesList) {
            filesList.innerHTML = '';
            const rows = [];
            for (const g of ctx.groups.values()) {
                const tag = /SOOT/i.test(g.quantity)
                    ? 'SOOT'
                    : (/^HRRPUV$/i.test(g.quantity) ? 'HRR' : g.shortName || g.quantity);
                for (const e of g.entries) rows.push({ tag, name: e.fileName });
            }
            rows.sort((a, b) => a.name.localeCompare(b.name));
            for (const r of rows) {
                const li = document.createElement('li');
                li.innerHTML = '<span class="file-tag">' + r.tag + '</span>' + r.name;
                filesList.appendChild(li);
            }
            filesDetails.style.display = rows.length ? '' : 'none';
        }
        // Update the kW/m³ readout next to the HRRPUV threshold slider now
        // that we know the data's HRRPUV_MINMAX range.
        refreshHrrKwReadout();
    }

    async function handleSmokeFolder(viewer, files) {
        try {
            stopSmokePlayback();
            setSmokeStatus('Scanning folder...');
            // Refresh greyscale geometry from any .fds in the folder
            await refreshGeometryFromFolder(files);
            const ov = ensureSmokeOverlay(viewer);
            const avail = await ov.loadFolder(files);
            updateSmokeMetadata();
            // Apply smoke-mesh bounds to the viewer FIRST, then initialise the
            // clip panel — otherwise initClipPanel reads stale/empty bounds
            // and the sliders never adapt to the new simulation extents.
            if (!viewer.getBoundsFDS()) {
                const sb = smokeOverlayBounds();
                if (sb) viewer.setBoundsFDSAndFit(sb.xmin, sb.xmax, sb.ymin, sb.ymax, sb.zmin, sb.zmax);
            }
            initClipPanel(viewer);

            // Populate quantity dropdown based on what's available
            const qSel = document.getElementById('output-smoke-quantity');
            if (qSel) {
                qSel.innerHTML = '';
                if (avail.soot && avail.hrr) addOpt(qSel, 'combined', 'Soot + HRRPUV');
                if (avail.soot)              addOpt(qSel, 'soot', 'SOOT DENSITY');
                if (avail.hrr)               addOpt(qSel, 'hrrpuv', 'HRRPUV');
                if (!qSel.options.length) {
                    addOpt(qSel, '', 'No SOOT DENSITY or HRRPUV found');
                    qSel.disabled = true;
                    const loadBtn = document.getElementById('output-smoke-load');
                    if (loadBtn) loadBtn.disabled = true;
                    setSmokeStatus('No SOOT DENSITY or HRRPUV groups in this folder.', true);
                    return;
                }
                qSel.disabled = false;
                const loadBtn = document.getElementById('output-smoke-load');
                if (loadBtn) loadBtn.disabled = false;
            }
            setSmokeStatus('Found Smoke3D groups. Choose a quantity and click Load selected data.');
        } catch (e) {
            console.error(e);
            setSmokeStatus(e.message, true);
        }
    }

    function addOpt(sel, value, label) {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        sel.appendChild(o);
    }

    async function handleSmokeLoad(viewer) {
        try {
            stopSmokePlayback();
            const ov = ensureSmokeOverlay(viewer);
            const qSel = document.getElementById('output-smoke-quantity');
            if (qSel) ov.quantityMode = qSel.value;
            const loadBtn = document.getElementById('output-smoke-load');
            if (loadBtn) loadBtn.disabled = true;
            const result = await ov.loadActiveQuantities(setSmokeStatus);
            if (loadBtn) loadBtn.disabled = false;
            configureSmokeFrameSlider(result.frameCount);
            showViewerOverlay(true, true); // show play bar, hide colorbar in smoke mode
            setSmokeStatus('Loaded. ' + (result.note || ('Frames: ' + result.frameCount)));
        } catch (e) {
            console.error(e);
            setSmokeStatus(e.message, true);
            const loadBtn = document.getElementById('output-smoke-load');
            if (loadBtn) loadBtn.disabled = false;
        }
    }

    function configureSmokeFrameSlider(frameCount) {
        const slider  = document.getElementById('output-smoke-frame-slider');
        const playBtn = document.getElementById('output-smoke-play');
        const readout = document.getElementById('output-smoke-frame-readout');
        const canPlay = frameCount > 1;
        if (slider)  { slider.min = 0; slider.max = Math.max(0, frameCount - 1); slider.value = 0; slider.disabled = !canPlay; }
        if (playBtn) playBtn.disabled = !canPlay;
        if (readout && smokeOverlay) readout.textContent = smokeOverlay.currentTime().toFixed(3) + ' s';

        // Sync overlay play bar
        const vpSlider = document.getElementById('output-vp-slider');
        const vpPlay   = document.getElementById('output-vp-play-btn');
        const vpTime   = document.getElementById('output-vp-time');
        if (vpSlider) { vpSlider.min = 0; vpSlider.max = Math.max(0, frameCount - 1); vpSlider.value = 0; vpSlider.disabled = !canPlay; }
        if (vpPlay)   vpPlay.disabled = !canPlay;
        if (vpTime && smokeOverlay) vpTime.textContent = smokeOverlay.currentTime().toFixed(3) + ' s';
    }

    function setSmokePlayIcons(playing) {
        const lbl   = document.getElementById('output-smoke-play-label');
        const vpBtn = document.getElementById('output-vp-play-btn');
        if (lbl) lbl.textContent = playing ? 'Pause' : 'Play';
        if (mode === 'smoke' && vpBtn) vpBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
    }

    function stopSmokePlayback() {
        if (smokePlaybackTimer) {
            clearInterval(smokePlaybackTimer);
            smokePlaybackTimer = null;
            setSmokePlayIcons(false);
        }
    }

    function startSmokePlayback() {
        if (!smokeOverlay || !smokeOverlay.activeFrames.length) return;
        setSmokePlayIcons(true);
        const slider  = document.getElementById('output-smoke-frame-slider');
        const readout = document.getElementById('output-smoke-frame-readout');
        const vpSlider = document.getElementById('output-vp-slider');
        const vpTime   = document.getElementById('output-vp-time');
        smokePlaybackTimer = setInterval(() => {
            const next = (smokeOverlay.frameIndex + 1) % smokeOverlay.activeFrames.length;
            smokeOverlay.setFrame(next);
            const timeStr = smokeOverlay.currentTime().toFixed(3) + ' s';
            if (slider)   slider.value       = next;
            if (readout)  readout.textContent = timeStr;
            if (vpSlider && mode === 'smoke') vpSlider.value       = next;
            if (vpTime   && mode === 'smoke') vpTime.textContent   = timeStr;
            syncAgents();
        }, 220);
    }

    function wireSmokeControls(viewer) {
        const folder = document.getElementById('output-smoke-folder');
        if (folder) folder.addEventListener('change', (e) => {
            const fs = Array.from(e.target.files || []);
            if (fs.length) handleSimulationFolder(viewer, fs);
        });

        const loadBtn = document.getElementById('output-smoke-load');
        if (loadBtn) loadBtn.addEventListener('click', () => handleSmokeLoad(viewer));

        const qSel = document.getElementById('output-smoke-quantity');
        if (qSel) qSel.addEventListener('change', () => {
            if (smokeOverlay) smokeOverlay.setQuantity(qSel.value);
        });

        // Rendering mode (basic vs solid-aware depth-sampling)
        const renderSel = document.getElementById('output-smoke-render');
        if (renderSel) renderSel.addEventListener('change', () => {
            viewer.setSmokeDepthEnabled(renderSel.value === 'depth');
        });

        const slider = document.getElementById('output-smoke-frame-slider');
        const readout = document.getElementById('output-smoke-frame-readout');
        if (slider) slider.addEventListener('input', () => {
            if (!smokeOverlay) return;
            smokeOverlay.setFrame(parseInt(slider.value, 10) || 0);
            if (readout) readout.textContent = smokeOverlay.currentTime().toFixed(3) + ' s';
            syncAgents();
        });

        const playBtn = document.getElementById('output-smoke-play');
        if (playBtn) playBtn.addEventListener('click', () => {
            if (smokePlaybackTimer) stopSmokePlayback();
            else startSmokePlayback();
        });

        const sample   = document.getElementById('output-smoke-sample');
        const sampleVal = document.getElementById('output-smoke-sample-val');
        // Step counts must mirror Smoke3DOverlay._volumeStepCount (single-mesh
        // values; multi-mesh Z-stack merges add a boost on top).
        const STEPS_PER_LEVEL = { 1: 200, 2: 120, 3: 60, 4: 24 };
        const updateSampleReadout = () => {
            if (!sampleVal || !sample) return;
            const n = STEPS_PER_LEVEL[parseInt(sample.value, 10)] || 160;
            sampleVal.textContent = n + ' steps/ray';
        };
        if (sample) sample.addEventListener('change', () => {
            if (smokeOverlay) smokeOverlay.setSampleStep(parseInt(sample.value, 10) || 1);
            updateSampleReadout();
        });
        updateSampleReadout();

        const smoothChk = document.getElementById('output-smoke-smooth');
        if (smoothChk) smoothChk.addEventListener('change', () => {
            if (smokeOverlay) smokeOverlay.setSmoothMotion(smoothChk.checked);
        });

        const sootThresh = document.getElementById('output-smoke-soot-thresh');
        if (sootThresh) sootThresh.addEventListener('input', () => {
            if (smokeOverlay) smokeOverlay.setSootThreshold(parseInt(sootThresh.value, 10) || 0);
        });
        const hrrThresh = document.getElementById('output-smoke-hrr-thresh');
        if (hrrThresh) hrrThresh.addEventListener('input', () => {
            if (smokeOverlay) smokeOverlay.setHrrThreshold(parseInt(hrrThresh.value, 10) || 0);
            refreshHrrKwReadout();
        });
        const hrrThreshSmv = document.getElementById('output-smoke-hrr-thresh-smv');
        if (hrrThreshSmv) hrrThreshSmv.addEventListener('click', () => {
            const range = getHrrpuvRange();
            if (!range || !hrrThresh) return;
            const byte = hrrKwToByte(SMOKEVIEW_HRR_CUTOFF, range);
            hrrThresh.value = String(byte);
            if (smokeOverlay) smokeOverlay.setHrrThreshold(byte);
            refreshHrrKwReadout();
        });
        const sootOp = document.getElementById('output-smoke-soot-op');
        if (sootOp) sootOp.addEventListener('input', () => {
            if (smokeOverlay) smokeOverlay.setSootOpacity(parseFloat(sootOp.value) || 0);
        });
        const hrrOp = document.getElementById('output-smoke-hrr-op');
        if (hrrOp) hrrOp.addEventListener('input', () => {
            if (smokeOverlay) smokeOverlay.setHrrOpacity(parseFloat(hrrOp.value) || 0);
        });

        // WebGL volume transfer controls
        const readoutEl = (id, elVal) => {
            const el = document.getElementById(id);
            if (el) el.textContent = parseFloat(elVal.value).toFixed(2);
        };
        const commitTransfer = () => {
            if (!smokeOverlay) return;
            const base = parseFloat(document.getElementById('output-smoke-vol-base')?.value || 0.2);
            const exp  = parseFloat(document.getElementById('output-smoke-vol-exp')?.value  || 0.82);
            const gain = parseFloat(document.getElementById('output-smoke-vol-gain')?.value || 7.2);
            smokeOverlay.setWebGlTransfer(base, exp, gain);
        };
        const volBase = document.getElementById('output-smoke-vol-base');
        const volExp  = document.getElementById('output-smoke-vol-exp');
        const volGain = document.getElementById('output-smoke-vol-gain');
        if (volBase) volBase.addEventListener('input', () => {
            readoutEl('output-smoke-vol-base-val', volBase); commitTransfer();
        });
        if (volExp) volExp.addEventListener('input', () => {
            readoutEl('output-smoke-vol-exp-val', volExp); commitTransfer();
        });
        if (volGain) volGain.addEventListener('input', () => {
            readoutEl('output-smoke-vol-gain-val', volGain); commitTransfer();
        });

        // Fire (HRRPUV) transfer-function sliders — same pattern as the soot
        // trio above. Defaults match the previously hard-coded shader values.
        const commitFireTransfer = () => {
            if (!smokeOverlay) return;
            const base = parseFloat(document.getElementById('output-smoke-fire-base')?.value || 0.12);
            const exp  = parseFloat(document.getElementById('output-smoke-fire-exp')?.value  || 1.10);
            const gain = parseFloat(document.getElementById('output-smoke-fire-gain')?.value || 5.4);
            smokeOverlay.setFireTransfer(base, exp, gain);
        };
        const fireBase = document.getElementById('output-smoke-fire-base');
        const fireExp  = document.getElementById('output-smoke-fire-exp');
        const fireGain = document.getElementById('output-smoke-fire-gain');
        if (fireBase) fireBase.addEventListener('input', () => {
            readoutEl('output-smoke-fire-base-val', fireBase); commitFireTransfer();
        });
        if (fireExp) fireExp.addEventListener('input', () => {
            readoutEl('output-smoke-fire-exp-val', fireExp); commitFireTransfer();
        });
        if (fireGain) fireGain.addEventListener('input', () => {
            readoutEl('output-smoke-fire-gain-val', fireGain); commitFireTransfer();
        });
    }

    // ── Boundary (BNDF) loading + rendering ────────────────────────────────
    function setBoundaryStatus(msg, isError) {
        const el = document.getElementById('output-boundary-status');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#e94560' : '';
    }

    function ensureBoundaryOverlay(viewer) {
        if (!boundaryOverlay) {
            boundaryOverlay = new BoundaryOverlay(viewer.scene, viewer.camera, viewer.controls, viewer.renderer);
            // Adopt whatever the dropdowns currently show so the first frame
            // loaded honours the user's choices instead of the constructor
            // defaults — matches how ensureOverlay seeds the slice overlay.
            const cmap = document.getElementById('output-boundary-colormap');
            if (cmap) boundaryOverlay.colorMap = cmap.value || 'diagnostic';
            const renderSel = document.getElementById('output-boundary-render');
            if (renderSel) boundaryOverlay.renderMode = renderSel.value === 'depth' ? 'depth' : 'basic';
        }
        return boundaryOverlay;
    }

    function updateBoundaryMetadata(info) {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        if (!info) {
            set('output-boundary-meta-smv', '--');
            set('output-boundary-meta-fds', '--');
            set('output-boundary-meta-meshes', '--');
            set('output-boundary-meta-objects', '--');
            set('output-boundary-meta-bndf', '--');
            return;
        }
        set('output-boundary-meta-smv', info.smvName);
        set('output-boundary-meta-fds', info.fdsName);
        set('output-boundary-meta-meshes', info.meshCount);
        set('output-boundary-meta-objects', info.objectCount + ' OBST, ' + info.ventCount + ' VENT');
        set('output-boundary-meta-bndf', info.groupKeys.length + ' quantity set(s)');
    }

    async function handleBoundaryFolder(viewer, files) {
        try {
            stopBoundaryPlayback();
            setBoundaryStatus('Scanning folder...');
            // Refresh greyscale geometry from the folder's .fds so OBST/VENT context shows
            await refreshGeometryFromFolder(files);
            const ov = ensureBoundaryOverlay(viewer);
            const info = await ov.loadFolder(files);
            updateBoundaryMetadata(info);

            // Frame camera to mesh bounds if no .fds geometry was loaded
            if (!viewer.getBoundsFDS()) {
                const b = ov.getBoundsFDS();
                if (b) viewer.setBoundsFDSAndFit(b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax);
            }

            // Populate quantity dropdown
            const setSel = document.getElementById('output-boundary-set');
            const loadBtn = document.getElementById('output-boundary-load');
            if (setSel) {
                setSel.innerHTML = '';
                for (const [key, group] of info.groups.entries()) {
                    const opt = document.createElement('option');
                    opt.value = key;
                    opt.textContent = group.quantity + ' (' + group.entries.length + ' file' + (group.entries.length === 1 ? '' : 's') + ')';
                    setSel.appendChild(opt);
                }
                if (!setSel.options.length) {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = 'No BNDF boundary data found';
                    setSel.appendChild(opt);
                    setSel.disabled = true;
                    if (loadBtn) loadBtn.disabled = true;
                    setBoundaryStatus('No BNDF data in this folder.', true);
                    return;
                }
                setSel.disabled = false;
                if (loadBtn) loadBtn.disabled = false;
            }
            setBoundaryStatus('Found boundary data. Choose a quantity and click Load selected data.');
        } catch (e) {
            console.error(e);
            setBoundaryStatus(e.message, true);
        }
    }

    async function handleBoundaryLoad(viewer) {
        try {
            stopBoundaryPlayback();
            const ov = ensureBoundaryOverlay(viewer);
            const setSel = document.getElementById('output-boundary-set');
            const loadBtn = document.getElementById('output-boundary-load');
            if (!setSel || !setSel.value) return;
            if (loadBtn) loadBtn.disabled = true;
            const result = await ov.loadSet(setSel.value, setBoundaryStatus);
            if (loadBtn) loadBtn.disabled = false;
            configureBoundaryFrameSlider(result.frameCount);
            showViewerOverlay(true, false); // show play bar AND colorbar
            refreshBoundaryColorbar();
            setBoundaryStatus('Loaded ' + result.quantity + '. ' + (result.note || ('Frames: ' + result.frameCount)));
        } catch (e) {
            console.error(e);
            setBoundaryStatus(e.message, true);
            const loadBtn = document.getElementById('output-boundary-load');
            if (loadBtn) loadBtn.disabled = false;
        }
    }

    function configureBoundaryFrameSlider(frameCount) {
        const slider  = document.getElementById('output-boundary-frame-slider');
        const playBtn = document.getElementById('output-boundary-play');
        const readout = document.getElementById('output-boundary-frame-readout');
        const canPlay = frameCount > 1;
        if (slider)  {
            slider.min = 0;
            slider.max = Math.max(0, frameCount - 1);
            slider.value = boundaryOverlay ? boundaryOverlay.frameIndex : 0;
            slider.disabled = !canPlay;
        }
        if (playBtn) playBtn.disabled = !canPlay;
        if (readout && boundaryOverlay) readout.textContent = boundaryOverlay.currentTime().toFixed(3) + ' s';

        // Sync viewport play bar
        const vpSlider = document.getElementById('output-vp-slider');
        const vpPlay   = document.getElementById('output-vp-play-btn');
        const vpTime   = document.getElementById('output-vp-time');
        if (vpSlider) {
            vpSlider.min = 0;
            vpSlider.max = Math.max(0, frameCount - 1);
            vpSlider.value = boundaryOverlay ? boundaryOverlay.frameIndex : 0;
            vpSlider.disabled = !canPlay;
        }
        if (vpPlay) vpPlay.disabled = !canPlay;
        if (vpTime && boundaryOverlay) vpTime.textContent = boundaryOverlay.currentTime().toFixed(3) + ' s';
    }

    function setBoundaryPlayIcons(playing) {
        const lbl   = document.getElementById('output-boundary-play-label');
        const vpBtn = document.getElementById('output-vp-play-btn');
        if (lbl) lbl.textContent = playing ? 'Pause' : 'Play';
        if (mode === 'boundary' && vpBtn) vpBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
    }

    function stopBoundaryPlayback() {
        if (boundaryPlaybackTimer) {
            clearInterval(boundaryPlaybackTimer);
            boundaryPlaybackTimer = null;
            setBoundaryPlayIcons(false);
        }
    }

    function startBoundaryPlayback() {
        if (!boundaryOverlay || !boundaryOverlay.activeFrames.length) return;
        setBoundaryPlayIcons(true);
        const slider  = document.getElementById('output-boundary-frame-slider');
        const readout = document.getElementById('output-boundary-frame-readout');
        const vpSlider = document.getElementById('output-vp-slider');
        const vpTime   = document.getElementById('output-vp-time');
        boundaryPlaybackTimer = setInterval(() => {
            const next = (boundaryOverlay.frameIndex + 1) % boundaryOverlay.activeFrames.length;
            boundaryOverlay.setFrame(next);
            const timeStr = boundaryOverlay.currentTime().toFixed(3) + ' s';
            if (slider)   slider.value       = next;
            if (readout)  readout.textContent = timeStr;
            if (vpSlider && mode === 'boundary') vpSlider.value       = next;
            if (vpTime   && mode === 'boundary') vpTime.textContent   = timeStr;
            refreshBoundaryColorbar();
            syncAgents();
        }, 220);
    }

    function wireBoundaryControls(viewer) {
        const folder = document.getElementById('output-boundary-folder');
        if (folder) folder.addEventListener('change', (e) => {
            const fs = Array.from(e.target.files || []);
            if (fs.length) handleSimulationFolder(viewer, fs);
        });

        const loadBtn = document.getElementById('output-boundary-load');
        if (loadBtn) loadBtn.addEventListener('click', () => handleBoundaryLoad(viewer));

        const setSel = document.getElementById('output-boundary-set');
        if (setSel) setSel.addEventListener('change', () => {
            if (boundaryOverlay && boundaryOverlay.loadedGroups.has(setSel.value)) {
                handleBoundaryLoad(viewer);
            }
        });

        const slider = document.getElementById('output-boundary-frame-slider');
        const readout = document.getElementById('output-boundary-frame-readout');
        if (slider) slider.addEventListener('input', () => {
            if (!boundaryOverlay) return;
            boundaryOverlay.setFrame(parseInt(slider.value, 10) || 0);
            if (readout) readout.textContent = boundaryOverlay.currentTime().toFixed(3) + ' s';
            refreshBoundaryColorbar(); // _resolveRange runs per frame, so the bar can shift
            syncAgents();
        });

        const playBtn = document.getElementById('output-boundary-play');
        if (playBtn) playBtn.addEventListener('click', () => {
            if (boundaryPlaybackTimer) stopBoundaryPlayback();
            else startBoundaryPlayback();
        });

        const cmap = document.getElementById('output-boundary-colormap');
        if (cmap) cmap.addEventListener('change', () => {
            if (boundaryOverlay) boundaryOverlay.setColorMap(cmap.value);
            refreshBoundaryColorbar();
        });

        // Boundary Rendering toggle (Basic / Solid-aware) — mirrors the slice
        // dropdown and lets OBSTs in front of the patch occlude it.
        const bRender = document.getElementById('output-boundary-render');
        if (bRender) bRender.addEventListener('change', () => {
            if (boundaryOverlay) boundaryOverlay.setRenderMode(bRender.value);
        });

        const opacity = document.getElementById('output-boundary-opacity');
        if (opacity) opacity.addEventListener('input', () => {
            if (boundaryOverlay) boundaryOverlay.setOpacity(parseFloat(opacity.value) || 0.88);
        });

        const auto = document.getElementById('output-boundary-auto');
        const minIn = document.getElementById('output-boundary-min');
        const maxIn = document.getElementById('output-boundary-max');
        if (auto) auto.addEventListener('change', () => {
            const enabled = !auto.checked;
            if (minIn) minIn.disabled = !enabled;
            if (maxIn) maxIn.disabled = !enabled;
            if (boundaryOverlay) boundaryOverlay.setAutoRange(auto.checked);
            refreshBoundaryColorbar();
        });
        const robust = document.getElementById('output-boundary-robust');
        if (robust) robust.addEventListener('change', () => {
            if (boundaryOverlay) boundaryOverlay.setRobustRange(robust.checked);
            refreshBoundaryColorbar();
        });
        const commitBoundaryRange = () => {
            if (!boundaryOverlay) return;
            const mn = parseFloat(minIn ? minIn.value : NaN);
            const mx = parseFloat(maxIn ? maxIn.value : NaN);
            if (Number.isFinite(mn) && Number.isFinite(mx) && mx > mn) {
                boundaryOverlay.setManualRange(mn, mx);
                refreshBoundaryColorbar();
            }
        };
        if (minIn) minIn.addEventListener('change', commitBoundaryRange);
        if (maxIn) maxIn.addEventListener('change', commitBoundaryRange);
    }

    function smokeOverlayBounds() {
        if (!smokeOverlay || !smokeOverlay.meshContext.length) return null;
        let xmin = Infinity, xmax = -Infinity;
        let ymin = Infinity, ymax = -Infinity;
        let zmin = Infinity, zmax = -Infinity;
        for (const m of smokeOverlay.meshContext) {
            xmin = Math.min(xmin, m.xb[0]); xmax = Math.max(xmax, m.xb[1]);
            ymin = Math.min(ymin, m.xb[2]); ymax = Math.max(ymax, m.xb[3]);
            zmin = Math.min(zmin, m.xb[4]); zmax = Math.max(zmax, m.xb[5]);
        }
        return Number.isFinite(xmin) ? { xmin, xmax, ymin, ymax, zmin, zmax } : null;
    }

    function initClipPanel(viewer) {
        const bounds = viewer.getBoundsFDS()
            || smokeOverlayBounds()
            || (boundaryOverlay ? boundaryOverlay.getBoundsFDS() : null);
        if (!bounds) return;
        const panel = document.getElementById('output-clip-panel');
        if (panel) panel.classList.add('visible');

        const axes = ['x', 'y', 'z'];
        const mins = [bounds.xmin, bounds.ymin, bounds.zmin];
        const maxs = [bounds.xmax, bounds.ymax, bounds.zmax];

        axes.forEach((ax, i) => {
            const mn = mins[i], mx = maxs[i];
            const step = Math.max(0.01, (mx - mn) / 200);
            const minSlider = document.getElementById('output-clip-' + ax + 'min');
            const maxSlider = document.getElementById('output-clip-' + ax + 'max');
            const minInput  = document.getElementById('output-clip-' + ax + 'min-val');
            const maxInput  = document.getElementById('output-clip-' + ax + 'max-val');
            if (!minSlider || !maxSlider || !minInput || !maxInput) return;
            [minSlider, maxSlider].forEach(s => { s.min = mn; s.max = mx; s.step = step; });
            minSlider.value = mn; maxSlider.value = mx;
            minInput.min = mn; minInput.max = mx; minInput.step = step; minInput.value = mn.toFixed(2);
            maxInput.min = mn; maxInput.max = mx; maxInput.step = step; maxInput.value = mx.toFixed(2);
        });

        viewer.resetClipPlanes();
        if (smokeOverlay) smokeOverlay.clearClipBoundsFDS();
    }

    function applyClip(viewer) {
        const bounds = viewer.getBoundsFDS();
        if (!bounds) return;
        const vals = {};
        ['x', 'y', 'z'].forEach(ax => {
            let mn = parseFloat(document.getElementById('output-clip-' + ax + 'min').value);
            let mx = parseFloat(document.getElementById('output-clip-' + ax + 'max').value);
            if (mn > mx) mn = mx;
            vals[ax] = { mn, mx };
        });
        const atFull = (
            vals.x.mn <= bounds.xmin && vals.x.mx >= bounds.xmax &&
            vals.y.mn <= bounds.ymin && vals.y.mx >= bounds.ymax &&
            vals.z.mn <= bounds.zmin && vals.z.mx >= bounds.zmax
        );
        if (atFull) {
            viewer.resetClipPlanes();
            if (smokeOverlay) smokeOverlay.clearClipBoundsFDS();
        } else {
            viewer.setClipPlanes(vals.x.mn, vals.x.mx, vals.y.mn, vals.y.mx, vals.z.mn, vals.z.mx);
            if (smokeOverlay) smokeOverlay.setClipBoundsFDS(vals.x.mn, vals.x.mx, vals.y.mn, vals.y.mx, vals.z.mn, vals.z.mx);
        }
    }

    // ── Agent trajectory overlay ──────────────────────────────────────────
    // ── Vismap (visibility maps, fdsvismap port) ──────────────────────────
    function setVismapStatus(msg, isError) {
        const el = document.getElementById('output-vismap-status');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#e94560' : '';
    }

    function ensureVismapOverlay(viewer) {
        if (!vismapOverlay) vismapOverlay = new VisMapOverlay(viewer.scene);
        return vismapOverlay;
    }

    // Populate the "Smoke data" dropdown from the folder's slice groups and
    // pre-select an extinction-coefficient slice (fall back to optical density).
    function refreshVismapQuantityOptions() {
        const sel = document.getElementById('output-vismap-quantity');
        if (!sel) return;
        sel.innerHTML = '';
        if (!availableGroups || availableGroups.length === 0) {
            sel.innerHTML = '<option value="">No slice data loaded</option>';
            sel.disabled = true;
            return;
        }
        let preferredKey = null, preferredIsExt = false;
        for (const g of availableGroups) {
            const opt = document.createElement('option');
            opt.value = g.key;
            opt.textContent = g.label;
            sel.appendChild(opt);
            const q = ((g.header && g.header.quantity) || '').toUpperCase();
            if (q.includes('EXTINCTION') && !preferredIsExt) { preferredKey = g.key; preferredIsExt = true; }
            else if (q.includes('OPTICAL DENSITY') && !preferredKey) { preferredKey = g.key; }
        }
        sel.disabled = false;
        if (preferredKey) sel.value = preferredKey;
        setVismapStatus(preferredKey
            ? 'Smoke data found. Add waypoints, then compute.'
            : 'No extinction/optical-density slice found — pick a quantity manually.', !preferredKey);
        const group = availableGroups.find(g => g.key === sel.value);
        if (group) fillVismapTimeDefaults(group);
    }

    // Prefill the Times inputs from the selected slice data: the full time
    // range of the simulation output and the finest step the data provides.
    // The user can still narrow the range or coarsen the step afterwards.
    async function fillVismapTimeDefaults(group) {
        try {
            if (!group || !group.items || group.items.length === 0) return;
            const buf = await group.items[0].file.arrayBuffer();
            const ds = FdsSliceReader.parse(buf);
            const times = ds.frames.map(f => f.time);
            if (times.length === 0) return;
            let minStep = Infinity;
            for (let i = 1; i < times.length; i++) {
                const d = times[i] - times[i - 1];
                if (d > 1e-9 && d < minStep) minStep = d;
            }
            const round = v => Math.round(v * 1000) / 1000;
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
            set('output-vismap-t0', round(times[0]));
            set('output-vismap-t1', round(times[times.length - 1]));
            set('output-vismap-dt', Number.isFinite(minStep) ? round(minStep) : 1);
        } catch (e) {
            console.warn('Could not read slice times for the vismap time defaults.', e);
        }
    }

    // Show the "nothing here yet" hints only while their list is empty.
    function updateVismapHints() {
        const pairs = [
            ['output-vismap-waypoints', 'output-vismap-wp-hint'],
            ['output-vismap-regions', 'output-vismap-region-hint'],
        ];
        for (const [containerId, hintId] of pairs) {
            const container = document.getElementById(containerId);
            const hint = document.getElementById(hintId);
            if (container && hint) hint.style.display = container.children.length ? 'none' : '';
        }
    }

    /** Card with a header (title + remove button) and a label/input grid,
     *  styled like the rest of the sidebar. `fields` = [{cls, label, title, value}]. */
    function addVismapCard(containerId, title, fields, onChange) {
        const container = document.getElementById(containerId);
        if (!container) return null;
        const card = document.createElement('div');
        card.className = 'vismap-card';

        const header = document.createElement('div');
        header.className = 'vismap-card-header';
        const heading = document.createElement('span');
        heading.className = 'vismap-card-title';
        heading.textContent = title;
        header.appendChild(heading);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'vismap-card-remove';
        remove.textContent = '✕ Remove';
        remove.addEventListener('click', () => { card.remove(); updateVismapHints(); onChange(); });
        header.appendChild(remove);
        card.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'vismap-grid';
        for (const field of fields) {
            const label = document.createElement('label');
            label.textContent = field.label;
            label.title = field.title;
            grid.appendChild(label);
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = 'any';
            inp.className = field.cls;
            inp.title = field.title;
            if (Number.isFinite(field.value)) inp.value = field.value;
            inp.addEventListener('change', onChange);
            grid.appendChild(inp);
        }
        card.appendChild(grid);
        container.appendChild(card);
        updateVismapHints();
        return card;
    }

    function addVismapWaypointRow(x, y, c, alpha) {
        const id = ++vismapWaypointSeq;
        const card = addVismapCard('output-vismap-waypoints', 'Waypoint ' + id, [
            { cls: 'vismap-wp-x', label: 'X / m', title: 'X coordinate in FDS coordinates', value: x },
            { cls: 'vismap-wp-y', label: 'Y / m', title: 'Y coordinate in FDS coordinates', value: y },
            { cls: 'vismap-wp-c', label: 'C', title: 'Contrast factor (Jin): 3 reflecting, 8 illuminated sign', value: c },
            { cls: 'vismap-wp-a', label: 'α / °', title: 'Sign orientation angle (0° faces +Y, 90° faces +X)', value: alpha },
        ], pushVismapWaypointsToEngine);
        if (!card) return null;
        card.classList.add('vismap-wp-row');
        card.dataset.wpId = id;
        return card;
    }

    /** Union of all mesh footprints — used to validate waypoint coordinates. */
    function vismapDomainBounds() {
        const ctx = currentSliceContext();
        if (!ctx || !ctx.meshes || ctx.meshes.length === 0) return null;
        const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        for (const m of ctx.meshes) {
            b.x0 = Math.min(b.x0, m.xb[0]); b.x1 = Math.max(b.x1, m.xb[1]);
            b.y0 = Math.min(b.y0, m.xb[2]); b.y1 = Math.max(b.y1, m.xb[3]);
        }
        return b;
    }

    function markVismapInput(row, cls, invalid) {
        const inp = row.querySelector('.' + cls);
        if (inp) inp.classList.toggle('vismap-invalid', !!invalid);
    }

    /**
     * Read and validate the waypoint rows. Every row must be complete and
     * valid — empty required fields are errors and get their inputs marked.
     * Returns { waypoints, errors }.
     */
    function readVismapWaypointRows() {
        const rows = document.querySelectorAll('#output-vismap-waypoints .vismap-wp-row');
        const bounds = vismapDomainBounds();
        const waypoints = [], errors = [];
        for (const row of rows) {
            const id = Number(row.dataset.wpId);
            const raw = cls => row.querySelector('.' + cls).value.trim();
            const num = cls => parseFloat(raw(cls));
            for (const cls of ['vismap-wp-x', 'vismap-wp-y', 'vismap-wp-c', 'vismap-wp-a']) markVismapInput(row, cls, false);

            const x = num('vismap-wp-x'), y = num('vismap-wp-y');
            let bad = false;
            if (!Number.isFinite(x)) { errors.push('Waypoint ' + id + ': X is required.'); markVismapInput(row, 'vismap-wp-x', true); bad = true; }
            if (!Number.isFinite(y)) { errors.push('Waypoint ' + id + ': Y is required.'); markVismapInput(row, 'vismap-wp-y', true); bad = true; }
            if (!bad && bounds) {
                if (x < bounds.x0 || x > bounds.x1) {
                    errors.push('Waypoint ' + id + ': X=' + x + ' is outside the domain (' + bounds.x0 + '…' + bounds.x1 + ').');
                    markVismapInput(row, 'vismap-wp-x', true); bad = true;
                }
                if (y < bounds.y0 || y > bounds.y1) {
                    errors.push('Waypoint ' + id + ': Y=' + y + ' is outside the domain (' + bounds.y0 + '…' + bounds.y1 + ').');
                    markVismapInput(row, 'vismap-wp-y', true); bad = true;
                }
            }
            const c = raw('vismap-wp-c') ? num('vismap-wp-c') : 3;
            if (!Number.isFinite(c) || c <= 0) {
                errors.push('Waypoint ' + id + ': contrast factor C must be a positive number (Jin: 3 or 8).');
                markVismapInput(row, 'vismap-wp-c', true); bad = true;
            }
            const alpha = num('vismap-wp-a');
            if (!Number.isFinite(alpha)) {
                errors.push('Waypoint ' + id + ': orientation angle α is required (degrees).');
                markVismapInput(row, 'vismap-wp-a', true); bad = true;
            }
            if (!bad) waypoints.push({ id, x, y, c, alpha });
        }
        return { waypoints, errors };
    }

    // ── Manual visual obstruction / hole regions ──
    let vismapRegionSeq = 0;

    function addVismapRegionRow(type) {
        const id = ++vismapRegionSeq;
        const title = (type === 'hole' ? 'Hole ' : 'Obstruction ') + id;
        const card = addVismapCard('output-vismap-regions', title, [
            { cls: 'vismap-rg-x1', label: 'X1 / m', title: 'Lower X corner', value: null },
            { cls: 'vismap-rg-x2', label: 'X2 / m', title: 'Upper X corner', value: null },
            { cls: 'vismap-rg-y1', label: 'Y1 / m', title: 'Lower Y corner', value: null },
            { cls: 'vismap-rg-y2', label: 'Y2 / m', title: 'Upper Y corner', value: null },
        ], pushVismapRegionsToOverlay);
        if (!card) return null;
        card.classList.add('vismap-region-row');
        card.dataset.regionType = type;
        card.dataset.regionId = id;
        return card;
    }

    /** Read and validate the region rows — every row must be complete, with a
     *  non-zero extent. Coordinates are normalized so x1<x2, y1<y2.
     *  Returns { regions, errors }. */
    function readVismapRegions() {
        const rows = document.querySelectorAll('#output-vismap-regions .vismap-region-row');
        const regions = [], errors = [];
        for (const row of rows) {
            const type = row.dataset.regionType === 'hole' ? 'hole' : 'obstruction';
            const name = (type === 'hole' ? 'Hole ' : 'Obstruction ') + row.dataset.regionId;
            const values = ['vismap-rg-x1', 'vismap-rg-x2', 'vismap-rg-y1', 'vismap-rg-y2']
                .map(cls => ({ cls, v: parseFloat(row.querySelector('.' + cls).value) }));
            let bad = false;
            for (const { cls, v } of values) {
                const invalid = !Number.isFinite(v);
                markVismapInput(row, cls, invalid);
                if (invalid) bad = true;
            }
            if (bad) {
                errors.push(name + ': all four coordinates (X1, X2, Y1, Y2) are required.');
                continue;
            }
            const [x1v, x2v, y1v, y2v] = values.map(o => o.v);
            const region = {
                type,
                x1: Math.min(x1v, x2v), x2: Math.max(x1v, x2v),
                y1: Math.min(y1v, y2v), y2: Math.max(y1v, y2v),
            };
            if (region.x1 === region.x2 || region.y1 === region.y2) {
                errors.push(name + ': the rectangle has zero extent.');
                continue;
            }
            regions.push(region);
        }
        return { regions, errors };
    }

    function pushVismapRegionsToOverlay() {
        if (!outputViewer) return;
        const overlay = ensureVismapOverlay(outputViewer);
        const { regions } = readVismapRegions();
        overlay.updateRegions(regions);
        overlay.setVisible(mode === 'vismap');
        if (vismapEngine && vismapEngine.computedTimes.length > 0) {
            setVismapStatus('Visual regions changed — recompute to update the maps.');
        }
    }

    // Live-update engine waypoints + 3D markers after edits. Computed maps
    // become stale (the engine invalidates them) until the next Compute.
    function pushVismapWaypointsToEngine() {
        if (!vismapEngine) return;
        const hadResults = vismapEngine.computedTimes.length > 0;
        vismapEngine.waypoints.clear();
        const { waypoints, errors } = readVismapWaypointRows();
        for (const wp of waypoints) {
            vismapEngine.setWaypoint(wp.id, wp.x, wp.y, wp.c, wp.alpha);
        }
        if (vismapOverlay) vismapOverlay.updateMarkers();
        if (errors.length) setVismapStatus(errors[0], true);
        else if (hadResults) setVismapStatus('Waypoints changed — recompute to update the maps.');
    }

    async function computeVismap(viewer) {
        try {
            stopVismapPlayback();
            if (!availableGroups || availableGroups.length === 0) {
                setVismapStatus('Open a simulation folder with slice data first.', true);
                return;
            }
            const qtySel = document.getElementById('output-vismap-quantity');
            const group = availableGroups.find(g => g.key === (qtySel && qtySel.value)) || availableGroups[0];
            const { waypoints, errors: wpErrors } = readVismapWaypointRows();
            const { regions, errors: regionErrors } = readVismapRegions();
            const errors = wpErrors.concat(regionErrors);
            if (errors.length) {
                setVismapStatus(errors.join(' '), true);
                return;
            }
            if (waypoints.length === 0) {
                setVismapStatus('Add at least one waypoint (X and Y required).', true);
                return;
            }

            setVismapStatus('Loading slice data...');
            const { dataset } = await datasetFromSliceGroup(group);
            const view = SliceUtil.buildPlaneView(dataset, 0, currentSliceContext());
            if (!view.physical) {
                setVismapStatus('No mesh geometry found (.smv or .fds in the folder) — cannot place the slice in space.', true);
                return;
            }
            const [nx, ny] = dataset.dims;
            const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => n > 1 ? a + (b - a) * i / (n - 1) : a);
            vismapEngine = new VisMapEngine({
                dataset,
                xCoords: linspace(view.physical.x0, view.physical.x1, nx),
                yCoords: linspace(view.physical.y0, view.physical.y1, ny),
                height: view.physical.slabOffset || 0,
            });
            vismapEngine.setObstructionsFromFds(lastData ? lastData.obsts : []);
            for (const r of regions) {
                if (r.type === 'hole') vismapEngine.addVisualHole(r.x1, r.x2, r.y1, r.y2);
                else vismapEngine.addVisualObstruction(r.x1, r.x2, r.y1, r.y2);
            }
            const num = (id, fallback) => {
                const v = parseFloat((document.getElementById(id) || {}).value);
                return Number.isFinite(v) ? v : fallback;
            };
            for (const wp of waypoints) vismapEngine.setWaypoint(wp.id, wp.x, wp.y, wp.c, wp.alpha);

            const tEndData = dataset.frames[dataset.frames.length - 1].time;
            const t0 = num('output-vismap-t0', 0);
            const t1 = num('output-vismap-t1', tEndData);
            const dt = num('output-vismap-dt', Math.max((t1 - t0) / 10, 1e-6));
            const times = [];
            for (let t = t0; t <= t1 + 1e-9 && times.length < 1000; t += dt) times.push(t);
            vismapEngine.setTimePoints(times);
            vismapEngine.setVisibilityBounds(num('output-vismap-minvis', 0), num('output-vismap-maxvis', 30));

            const overlay = ensureVismapOverlay(viewer);
            overlay.setEngine(vismapEngine);
            overlay.setSignsUpright(!!viewer.walkMode);
            overlay.updateMarkers();
            overlay.updateRegions(regions);
            overlay.setVisible(mode === 'vismap');

            await vismapEngine.computeAll({
                obstructions: !!(document.getElementById('output-vismap-obstructions') || {}).checked,
                viewAngle: !!(document.getElementById('output-vismap-viewangle') || {}).checked,
                onProgress: (done, total) => setVismapStatus('Computing… time step ' + done + ' / ' + total),
            });

            const slider = document.getElementById('output-vismap-time-slider');
            const mapSel = document.getElementById('output-vismap-mapmode');
            const playBtn = document.getElementById('output-vismap-play');
            const n = vismapEngine.computedTimes.length;
            if (slider) { slider.min = 0; slider.max = Math.max(n - 1, 0); slider.value = Math.max(n - 1, 0); }
            if (mapSel) mapSel.disabled = false;
            if (playBtn) playBtn.disabled = n <= 1;
            renderVismapMap();
            setVismapStatus('Computed ' + n + ' time step(s) for ' + waypoints.length + ' waypoint(s).');
        } catch (e) {
            console.error(e);
            setVismapStatus(e.message, true);
        }
    }

    function renderVismapMap(fromUser) {
        if (!vismapOverlay || !vismapEngine || vismapEngine.computedTimes.length === 0) {
            // Explain why nothing changes instead of silently ignoring the
            // interaction — results are cleared by any waypoint/region edit.
            if (fromUser) setVismapStatus('No computed maps — press "Compute visibility maps" first.', true);
            return;
        }
        const mapSel = document.getElementById('output-vismap-mapmode');
        const slider = document.getElementById('output-vismap-time-slider');
        const readout = document.getElementById('output-vismap-time-readout');
        const mapMode = mapSel ? mapSel.value : 'aggregated';
        const times = vismapEngine.computedTimes;
        const idx = Math.min(slider ? (parseInt(slider.value, 10) || 0) : times.length - 1, times.length - 1);
        // The time slider steps through the computed time points; it only
        // drives the 'At selected time' map, so it stays disabled elsewhere.
        if (slider) slider.disabled = mapMode !== 'time' || times.length <= 1;
        let legend;
        if (mapMode === 'time') {
            legend = vismapOverlay.showMap('time', times[idx]);
            if (readout) readout.textContent = times[idx].toFixed(1) + ' s';
        } else if (mapMode === 'aset') {
            legend = vismapOverlay.showMap('aset');
            if (readout) readout.textContent = 'up to ' + times[times.length - 1].toFixed(1) + ' s';
            if (times.length <= 1) {
                setVismapStatus('The ASET map needs several time points to show when visibility is lost — extend End or reduce Step, then recompute.', true);
            }
        } else {
            legend = vismapOverlay.showMap('aggregated');
            if (readout) readout.textContent = 'all times (green = always visible)';
        }
        updateVismapColorbar(legend);
    }

    // ── Vismap time playback (mirrors the slice Play button) ──
    let vismapPlaybackTimer = null;

    function setVismapPlayIcon(playing) {
        const lbl = document.getElementById('output-vismap-play-label');
        if (lbl) lbl.textContent = playing ? 'Pause' : 'Play';
    }

    function stopVismapPlayback() {
        if (vismapPlaybackTimer) {
            clearInterval(vismapPlaybackTimer);
            vismapPlaybackTimer = null;
            setVismapPlayIcon(false);
        }
    }

    function startVismapPlayback() {
        if (!vismapEngine || vismapEngine.computedTimes.length <= 1) return;
        // Playing steps through time points, which only the per-time map shows.
        const mapSel = document.getElementById('output-vismap-mapmode');
        if (mapSel && mapSel.value !== 'time') {
            mapSel.value = 'time';
        }
        setVismapPlayIcon(true);
        vismapPlaybackTimer = setInterval(() => {
            const slider = document.getElementById('output-vismap-time-slider');
            if (!slider || !vismapEngine) { stopVismapPlayback(); return; }
            const n = vismapEngine.computedTimes.length;
            slider.value = ((parseInt(slider.value, 10) || 0) + 1) % n;
            renderVismapMap();
        }, 250);
    }

    // The shared colorbar shows the ASET time scale; the boolean green/red
    // maps carry their meaning in the readout text, so the bar hides there.
    function updateVismapColorbar(legend) {
        if (mode !== 'vismap') return;
        const cb = document.getElementById('output-colorbar');
        if (!cb) return;
        if (!legend || legend.mode !== 'aset') { cb.style.display = 'none'; return; }
        cb.style.display = '';
        const label = document.getElementById('output-colorbar-label');
        const maxEl = document.getElementById('output-colorbar-max');
        const minEl = document.getElementById('output-colorbar-min');
        if (label) label.textContent = 'ASET (s)';
        if (maxEl) maxEl.textContent = legend.max.toFixed(0);
        if (minEl) minEl.textContent = legend.min.toFixed(0);
        const canvas = document.getElementById('output-colorbar-canvas');
        if (!canvas || typeof VisMapUtil === 'undefined') return;
        const ctx = canvas.getContext('2d');
        for (let y = 0; y < canvas.height; y++) {
            const t = 1 - y / (canvas.height - 1);
            const c = VisMapUtil.jetReversed(t);
            ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
            ctx.fillRect(0, y, canvas.width, 1);
        }
    }

    let vismapPicking = false;

    function wireVismapControls(viewer) {
        const folder = document.getElementById('output-vismap-folder');
        if (folder) folder.addEventListener('change', (e) => {
            const fs = Array.from(e.target.files || []);
            if (fs.length) handleSimulationFolder(viewer, fs);
        });

        // Switching the smoke-data quantity refreshes the time defaults.
        const qtySel = document.getElementById('output-vismap-quantity');
        if (qtySel) qtySel.addEventListener('change', () => {
            const group = availableGroups && availableGroups.find(g => g.key === qtySel.value);
            if (group) fillVismapTimeDefaults(group);
        });

        // Creating a new entry first validates the existing ones — no piling
        // up of incomplete rows.
        const addBtn = document.getElementById('output-vismap-add-wp');
        if (addBtn) addBtn.addEventListener('click', () => {
            const { errors } = readVismapWaypointRows();
            if (errors.length) {
                setVismapStatus('Complete the marked waypoint first: ' + errors[0], true);
                return;
            }
            addVismapWaypointRow(null, null, 3, 0);
            setVismapStatus('Fill in the new waypoint (X and Y required, C default 3, α default 0).');
        });

        const addRegion = (type) => {
            const { errors } = readVismapRegions();
            if (errors.length) {
                setVismapStatus('Complete the marked region first: ' + errors[0], true);
                return;
            }
            addVismapRegionRow(type);
            setVismapStatus('Fill in all four corners of the new ' + type + '.');
        };
        const addObstBtn = document.getElementById('output-vismap-add-obst');
        if (addObstBtn) addObstBtn.addEventListener('click', () => addRegion('obstruction'));
        const addHoleBtn = document.getElementById('output-vismap-add-hole');
        if (addHoleBtn) addHoleBtn.addEventListener('click', () => addRegion('hole'));

        const playBtn = document.getElementById('output-vismap-play');
        if (playBtn) playBtn.addEventListener('click', () => {
            if (vismapPlaybackTimer) stopVismapPlayback();
            else startVismapPlayback();
        });

        // Signs lie flat in the orbit view and stand upright in walk mode.
        const walkContainer = document.getElementById('output-viewer-container');
        if (walkContainer) walkContainer.addEventListener('walkModeChanged', () => {
            if (vismapOverlay) vismapOverlay.setSignsUpright(!!viewer.walkMode);
        });
        // enterWalkMode doesn't dispatch walkModeChanged — piggyback on the
        // toggle button (this listener runs after the one that flips the mode).
        const walkBtn = document.getElementById('output-walk-mode-btn');
        if (walkBtn) walkBtn.addEventListener('click', () => {
            if (vismapOverlay) vismapOverlay.setSignsUpright(!!viewer.walkMode);
        });

        const pickBtn = document.getElementById('output-vismap-pick-wp');
        if (pickBtn) pickBtn.addEventListener('click', () => {
            vismapPicking = !vismapPicking;
            pickBtn.classList.toggle('active', vismapPicking);
            if (vismapPicking) setVismapStatus('Click a position in the 3D view to place the waypoint.');
        });
        if (viewer && viewer.renderer) {
            viewer.renderer.domElement.addEventListener('pointerdown', (event) => {
                if (!vismapPicking || mode !== 'vismap') return;
                const rect = viewer.renderer.domElement.getBoundingClientRect();
                const ndc = new THREE.Vector2(
                    ((event.clientX - rect.left) / rect.width) * 2 - 1,
                    -((event.clientY - rect.top) / rect.height) * 2 + 1
                );
                const raycaster = new THREE.Raycaster();
                raycaster.setFromCamera(ndc, viewer.camera);
                // Horizontal plane at the evaluation height (scene Y = FDS Z)
                const planeY = vismapEngine ? vismapEngine.height : 2;
                const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
                const hit = new THREE.Vector3();
                if (raycaster.ray.intersectPlane(plane, hit)) {
                    const { errors } = readVismapWaypointRows();
                    if (errors.length) {
                        setVismapStatus('Complete the marked waypoint first: ' + errors[0], true);
                    } else {
                        addVismapWaypointRow(Math.round(hit.x * 100) / 100, Math.round(hit.z * 100) / 100, 3, 0);
                        pushVismapWaypointsToEngine();
                        setVismapStatus('Waypoint placed at X=' + hit.x.toFixed(2) + ', Y=' + hit.z.toFixed(2) + '.');
                    }
                }
                vismapPicking = false;
                pickBtn && pickBtn.classList.remove('active');
            });
        }

        const computeBtn = document.getElementById('output-vismap-compute');
        if (computeBtn) computeBtn.addEventListener('click', () => computeVismap(viewer));

        const mapSel = document.getElementById('output-vismap-mapmode');
        if (mapSel) mapSel.addEventListener('change', () => {
            if (mapSel.value !== 'time') stopVismapPlayback();
            renderVismapMap(true);
        });
        const slider = document.getElementById('output-vismap-time-slider');
        if (slider) slider.addEventListener('input', () => renderVismapMap(true));

        updateVismapHints();
    }

    function wireAgents(viewer) {
        const agentsFile = document.getElementById('output-agents-file');
        const agentsReload = document.getElementById('output-agents-reload');

        async function loadAgentTrajectory(file) {
            const status = document.getElementById('output-agents-status');
            if (status) status.textContent = 'Loading ' + file.name + '…';
            const buf = await file.arrayBuffer();
            const ds = await loadTrajectorySqlite(buf);
            if (!agentOverlay) agentOverlay = new AgentOverlay(viewer.scene);
            agentOverlay.load(ds);
            populateAgentColorby(ds);
            wireAgentControls(ds);
            const t = activeDisplayTime();
            if (t !== null) agentOverlay.setTime(t); else agentOverlay.setFrame(0);
            drawAgentColorbar();
            let maxAgents = 0;
            for (const f of ds.frames) if (f.count > maxAgents) maxAgents = f.count;
            if (status) status.textContent = file.name + ' — ' + ds.frames.length + ' frames, ' + maxAgents + ' agents max';
        }

        if (agentsFile) agentsFile.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            agentFile = file;
            try {
                await loadAgentTrajectory(file);
                if (agentsReload) agentsReload.disabled = false;
            } catch (err) {
                const status = document.getElementById('output-agents-status');
                if (status) status.textContent = 'Error: ' + err.message;
                if (typeof console !== 'undefined') console.error(err);
            }
        });

        if (agentsReload) agentsReload.addEventListener('click', async () => {
            if (!agentFile || agentsReload.disabled) return;
            agentsReload.disabled = true;
            agentsReload.textContent = 'Reloading…';
            try {
                await loadAgentTrajectory(agentFile);
                const status = document.getElementById('output-agents-status');
                if (status) status.textContent += ' · reloaded ' + new Date().toTimeString().slice(0, 8);
                agentsReload.textContent = 'Reloaded ✓';
                setTimeout(() => { agentsReload.textContent = 'Reload'; agentsReload.disabled = false; }, 1600);
            } catch (err) {
                const status = document.getElementById('output-agents-status');
                if (status) status.textContent = agentFile.name + ' could not be re-read (changed on disk?) — click Browse to re-select.';
                if (agentsFile) agentsFile.value = '';
                agentsReload.textContent = 'Reload';
                agentsReload.disabled = false;
                if (typeof console !== 'undefined') console.error(err);
            }
        });
    }

    function populateAgentColorby(ds) {
        const sel = document.getElementById('output-agents-colorby');
        if (!sel) return;
        const fedOpt = sel.querySelector('option[value="fed"]');
        if (fedOpt) fedOpt.disabled = ds.quantities.indexOf('fed') < 0;
        if (ds.quantities.indexOf(sel.value) < 0) sel.value = ds.quantities[0];
        agentOverlay.setQuantity(sel.value);
    }

    function wireAgentControls(ds) {
        const sel = document.getElementById('output-agents-colorby');
        if (sel && !sel._wired) {
            sel._wired = true;
            sel.addEventListener('change', () => { agentOverlay.setQuantity(sel.value); drawAgentColorbar(); });
        }
        const op = document.getElementById('output-agents-opacity');
        if (op && !op._wired) {
            op._wired = true;
            op.addEventListener('input', () => agentOverlay.setOpacity(parseFloat(op.value)));
        }
        const slider = document.getElementById('output-agents-frame-slider');
        const tlabel = document.getElementById('output-agents-time');
        if (slider) {
            slider.min = 0;
            slider.max = Math.max(0, ds.frames.length - 1);
            slider.value = agentOverlay.frameIndex;
            slider.disabled = ds.frames.length <= 1;
            if (!slider._wired) {
                slider._wired = true;
                slider.addEventListener('input', () => {
                    agentOverlay.setFrame(parseInt(slider.value, 10) || 0);
                    if (tlabel) tlabel.textContent = agentOverlay.currentTime().toFixed(3) + ' s';
                });
            }
        }
    }

    function drawAgentColorbar() {
        const cv = document.getElementById('output-agents-colorbar');
        if (!cv || !agentOverlay || !agentOverlay.dataset) return;
        const ctx = cv.getContext('2d');
        const q = agentOverlay.quantity;
        const range = (window.QUANTITY_RANGE && window.QUANTITY_RANGE[q]) || (q === 'fed' ? [0, 1] : [0, 1.5]);
        for (let px = 0; px < cv.width; px++) {
            const val = range[0] + (range[1] - range[0]) * (px / (cv.width - 1));
            const c = colorForValue(val, q);
            ctx.fillStyle = 'rgb(' + (c.r * 255 | 0) + ',' + (c.g * 255 | 0) + ',' + (c.b * 255 | 0) + ')';
            ctx.fillRect(px, 0, 1, cv.height);
        }
        const unit = (window.QUANTITY_UNIT && window.QUANTITY_UNIT[q]) || '';
        const minEl = document.getElementById('output-agents-cbar-min');
        const maxEl = document.getElementById('output-agents-cbar-max');
        if (minEl) minEl.textContent = String(range[0]);
        if (maxEl) {
            const maxSuffix = unit ? ' ' + unit : (q === 'fed' ? ' (incapacitation)' : '');
            maxEl.textContent = range[1] + maxSuffix;
        }
    }

    function wireClipPanel(viewer) {
        // Slider → number input + clip
        ['xmin','xmax','ymin','ymax','zmin','zmax'].forEach(id => {
            const slider = document.getElementById('output-clip-' + id);
            const numIn  = document.getElementById('output-clip-' + id + '-val');
            if (!slider || !numIn) return;
            slider.addEventListener('input', () => {
                numIn.value = parseFloat(slider.value).toFixed(2);
                applyClip(viewer);
            });
            slider.addEventListener('keydown', e => {
                if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
                    e.preventDefault(); slider.blur();
                }
            });
            const commitNumIn = () => {
                const v = parseFloat(numIn.value);
                if (!isNaN(v)) {
                    slider.value = Math.min(Math.max(v, parseFloat(slider.min)), parseFloat(slider.max));
                    numIn.value = parseFloat(slider.value).toFixed(2);
                    applyClip(viewer);
                }
            };
            numIn.addEventListener('change', commitNumIn);
            numIn.addEventListener('blur', commitNumIn);
            numIn.addEventListener('keydown', e => {
                e.stopPropagation();
                if (e.key === 'Enter') { commitNumIn(); numIn.blur(); }
            });
        });

        // Step buttons
        document.querySelectorAll('#output-clip-panel .clip-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const numIn = document.getElementById(btn.dataset.id);
                const axId  = btn.dataset.id.replace('-val', '');
                const slider = document.getElementById(axId);
                if (!slider || !numIn) return;
                const dir  = parseFloat(btn.dataset.dir);
                const step = parseFloat(slider.step) || 0.1;
                const v    = parseFloat(numIn.value) || 0;
                const newV = Math.min(Math.max(v + dir * step, parseFloat(slider.min)), parseFloat(slider.max));
                numIn.value  = newV.toFixed(2);
                slider.value = newV;
                applyClip(viewer);
            });
        });

        const resetBtn = document.getElementById('output-clip-reset-btn');
        if (resetBtn) resetBtn.addEventListener('click', () => initClipPanel(viewer));
    }
})();
