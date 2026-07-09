/**
 * FDS Visualization Tool - Main Application
 * Connects the parser and viewer, handles UI interactions
 */

document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('viewer-container');
    const viewer = new FDSViewer(container);
    const parser = new FDSParser();

    let currentData = null;
    let currentText = null;
    let currentFilename = null;

    // ── File Loading ──────────────────────────
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const loadSampleBtn = document.getElementById('load-sample');

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadFile(file);
    });

    // Drag and drop -- listen on the document so a user can drop a second
    // file onto the 3D viewer after the drop-zone overlay is hidden.
    const onDocDragOver = (e) => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        if (dropZone.style.display !== 'none') dropZone.classList.add('drag-over');
    };
    const onDocDragLeave = (e) => {
        // Only clear the highlight when leaving the window/document.
        if (e.relatedTarget == null) dropZone.classList.remove('drag-over');
    };
    const onDocDrop = (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        const csvFiles = files.filter(f => /\.csv$/i.test(f.name));
        const otherFiles = files.filter(f => !/\.csv$/i.test(f.name));
        if (csvFiles.length && typeof window.chartsPanelHandleFiles === 'function') {
            window.chartsPanelHandleFiles(csvFiles);
        }
        if (otherFiles.length) {
            loadFile(otherFiles[0]);
        }
    };
    document.addEventListener('dragover', onDocDragOver);
    document.addEventListener('dragleave', onDocDragLeave);
    document.addEventListener('drop', onDocDrop);

    // Also allow clicking the drop zone (but not its buttons)
    dropZone.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        fileInput.click();
    });

    function loadFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target.result;
            parseAndLoad(text, file.name);
        };
        reader.readAsText(file);
    }

    function parseAndLoad(text, filename) {
        try {
            currentText = text;
            currentFilename = filename || 'FDS Model';
            currentData = parser.parse(text);

            // Update filename display
            document.getElementById('filename-display').textContent = currentFilename;

            // Show the title from &HEAD (head may be absent on minimal files)
            const head = currentData.head || {};
            const title = head.TITLE || head.CHID || '';
            document.getElementById('model-title').textContent = title;

            // Hide drop zone, show viewer. The body.has-data class hides
            // the welcome footer-bar (credit + disclaimer) via CSS so it
            // doesn't reappear when switching pages.
            dropZone.style.display = 'none';
            container.style.display = 'block';
            document.getElementById('sidebar').classList.add('active');
            document.body.classList.add('has-data');
            activatePage('3d');

            viewer.loadData(currentData);
            updateStats();
            updateInfoPanel(null);
            initClipPanel();

            // Re-apply UI state that fresh scene reset to defaults.
            const opacityEl = document.getElementById('obst-opacity');
            if (opacityEl) viewer.setObstOpacity(parseFloat(opacityEl.value));
            const grayEl = document.getElementById('scene-grayscale');
            if (grayEl && grayEl.checked) viewer.setGrayscale(true);

            // Trigger resize after the 3D layout is visible
            viewer._onResize();

            // Build fire & combustion panel
            if (typeof buildFirePanel === 'function') {
                buildFirePanel(currentData);
            }

            // Build mesh analysis panel
            if (typeof buildMeshPanel === 'function') {
                buildMeshPanel(currentData);
            }

            // Build full FDS code panel
            if (typeof buildCodePanel === 'function') {
                buildCodePanel(currentText, currentFilename);
            }

            // Share data with the Output page (greyscale viewer + slice overlay)
            if (typeof window.outputPageSetData === 'function') {
                window.outputPageSetData(currentData);
            }

        } catch (err) {
            console.error('FDS parse failed for', filename, err);
            // Reset previously-shown content so the user isn't left looking
            // at stale stats from an earlier file.
            currentData = null;
            try { viewer.clearScene(); } catch (_) { /* viewer may not yet be ready */ }
            updateStats();
            // Re-show the drop zone + footer credit so the user can drop another file.
            dropZone.style.display = '';
            container.style.display = '';
            document.body.classList.remove('has-data');
            alert('Could not parse "' + (filename || 'file') + '":\n' + err.message);
        }
    }

    // Expose reload hook so fire-panel's "Apply & reload" can re-parse
    window._fdsReload = (newText, newFilename) => parseAndLoad(newText, newFilename || currentFilename);
    window._fdsEditMode = false;

    // Keep currentText in sync when the user saves edits without reloading
    document.addEventListener('fds-text-updated', (e) => { currentText = e.detail.text; });

    // ── URL Parameter Loading (?file=<server-relative path>) ──
    // Only works when served via HTTP (e.g. via serve.bat or GitHub Pages),
    // because fetch() over file:// is blocked by the browser.
    const urlParams = new URLSearchParams(window.location.search);
    const urlFile = urlParams.get('file');
    if (urlFile) {
        fetch(urlFile + '?t=' + Date.now())
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
                return r.text();
            })
            .then(text => parseAndLoad(text, urlFile.split('/').pop()))
            .catch(err => {
                console.error('URL-load failed for ' + urlFile, err);
                alert('Could not load ' + urlFile + '\n' + err.message +
                      '\n\nThis page must be served over HTTP for fetch() to work.\n' +
                      'Run a static server from the repo root, e.g.:\n' +
                      '    python -m http.server 8765\n' +
                      'then open http://localhost:8765/?file=' + urlFile);
            });
    }

    // ── Sample File ───────────────────────────
    // The sample is embedded as a JS string in js/sample-data.js (loaded
    // before this file), so the "Load Sample" button works offline — no
    // HTTP server required. The on-disk copy at examples/sample_room_fire.fds
    // is kept in sync for users who want to inspect or edit the .fds source.
    loadSampleBtn.addEventListener('click', () => {
        if (typeof SAMPLE_FDS_TEXT === 'string') {
            parseAndLoad(SAMPLE_FDS_TEXT, 'sample_room_fire.fds');
        } else {
            alert('Bundled sample is missing. Make sure js/sample-data.js is loaded.');
        }
    });

    // ── Visibility Toggles ─────────────────────
    document.querySelectorAll('.layer-toggle').forEach(toggle => {
        toggle.addEventListener('change', (e) => {
            const layer = e.target.dataset.layer;
            viewer.setVisibility(layer, e.target.checked);
        });
    });

    // ── Opacity Slider ─────────────────────────
    const opacitySlider = document.getElementById('obst-opacity');
    const opacityValue = document.getElementById('opacity-value');
    opacitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        opacityValue.textContent = Math.round(val * 100) + '%';
        viewer.setObstOpacity(val);
    });
    opacitySlider.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            opacitySlider.blur();
        }
    });

    // ── View Buttons ───────────────────────────
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            viewer.setView(btn.dataset.view);
        });
    });

    document.getElementById('reset-camera').addEventListener('click', () => {
        viewer.resetCamera();
    });

    // Projection toggle (bottom-right floating button)
    const projBtn = document.getElementById('proj-toggle');
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

    // ── Bulk layer show/hide ───────────────────
    function setAllLayers(visible) {
        document.querySelectorAll('.layer-toggle').forEach(toggle => {
            toggle.checked = visible;
            viewer.setVisibility(toggle.dataset.layer, visible);
        });
    }
    const showAllBtn = document.getElementById('layer-show-all');
    const hideAllBtn = document.getElementById('layer-hide-all');
    if (showAllBtn) showAllBtn.addEventListener('click', () => setAllLayers(true));
    if (hideAllBtn) hideAllBtn.addEventListener('click', () => setAllLayers(false));

    // ── OBST edge wireframe toggle ─────────────
    const obstEdgesIn = document.getElementById('show-obst-edges');
    if (obstEdgesIn) obstEdgesIn.addEventListener('change', () => {
        viewer.setShowObstEdges(obstEdgesIn.checked);
    });

    // ── Grayscale toggle ───────────────────────
    const grayChk = document.getElementById('scene-grayscale');
    if (grayChk) grayChk.addEventListener('change', () => {
        viewer.setGrayscale(grayChk.checked);
    });

    // ── Walk Mode (FPS) ────────────────────────
    const walkBtn = document.getElementById('walk-mode-btn');
    const walkEyeIn = document.getElementById('walk-eye-height');
    const walkEyeOut = document.getElementById('walk-eye-height-val');
    const walkSpdIn = document.getElementById('walk-speed');
    const walkSpdOut = document.getElementById('walk-speed-val');

    function syncWalkBtn() {
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
        if (!currentData) { alert('Load an FDS file first.'); return; }
        if (viewer.walkMode) viewer.exitWalkMode();
        else viewer.enterWalkMode();
        syncWalkBtn();
    });
    // Viewer dispatches this when walk mode auto-exits (Escape, scene cleared)
    document.getElementById('viewer-container').addEventListener('walkModeChanged', syncWalkBtn);

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

    // ── Page Tab Switching ─────────────────────
    function activatePage(page) {
        // Walk mode is bound to the page that started it — exit cleanly on
        // any switch so keyboard / pointer-lock state doesn't leak.
        if (page !== '3d' && viewer.walkMode) { viewer.exitWalkMode(); syncWalkBtn(); }
        if (page !== 'output' && typeof window.outputPageDeactivate === 'function') {
            window.outputPageDeactivate();
        }
        document.querySelectorAll('.page-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.page === page);
        });

        const appLayout    = document.getElementById('app-layout');
        const meshPanel    = document.getElementById('mesh-panel');
        const firePanel    = document.getElementById('fire-panel');
        const codePanel    = document.getElementById('fds-code-panel');
        const outputPanel  = document.getElementById('output-panel');
        const helpPanel    = document.getElementById('help-panel');
        const footerBar    = document.querySelector('.footer-bar');

        // Reset all
        appLayout.style.display = '';
        meshPanel.classList.remove('active');
        firePanel.classList.remove('active');
        codePanel.classList.remove('active');
        if (outputPanel)  outputPanel.classList.remove('active');
        if (helpPanel)    helpPanel.classList.remove('active');
        footerBar.style.display = '';

        if (page === 'mesh') {
            appLayout.style.display = 'none';
            meshPanel.classList.add('active');
            footerBar.style.display = 'none';
        } else if (page === 'fire') {
            appLayout.style.display = 'none';
            firePanel.classList.add('active');
            footerBar.style.display = 'none';
        } else if (page === 'code') {
            appLayout.style.display = 'none';
            codePanel.classList.add('active');
            footerBar.style.display = 'none';
        } else if (page === 'output') {
            appLayout.style.display = 'none';
            if (outputPanel) outputPanel.classList.add('active');
            footerBar.style.display = 'none';
            if (typeof window.outputPageActivate === 'function') {
                window.outputPageActivate();
            }
        } else if (page === 'help') {
            appLayout.style.display = 'none';
            if (helpPanel) helpPanel.classList.add('active');
            footerBar.style.display = 'none';
        }
    }

    document.querySelectorAll('.page-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (window._fdsEditMode) { _showTabGuard(); return; }
            activatePage(tab.dataset.page);
        });
    });

    function _showTabGuard() {
        let msg = document.getElementById('fp-tab-guard-toast');
        if (!msg) {
            msg = document.createElement('div');
            msg.id = 'fp-tab-guard-toast';
            msg.className = 'fp-tab-guard-toast';
            document.body.appendChild(msg);
        }
        msg.textContent = '⚠ Exit edit mode first — click View to return to read-only';
        msg.classList.add('visible');
        clearTimeout(msg._t);
        msg._t = setTimeout(() => msg.classList.remove('visible'), 2800);
    }

    // ── Background Toggle ──────────────────────
    const bgOptions = document.querySelectorAll('.bg-option');
    bgOptions.forEach(btn => {
        btn.addEventListener('click', () => {
            bgOptions.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            viewer.setBackground(btn.dataset.color);
        });
    });

    // ── Object Selection Info ──────────────────
    container.addEventListener('objectSelected', (e) => {
        updateInfoPanel(e.detail);
    });

    const infoPanel  = document.getElementById('object-info-panel');
    const infoTitle  = document.getElementById('object-info-title');

    document.getElementById('object-info-close').addEventListener('click', () => {
        infoPanel.classList.remove('visible');
        if (viewer.selectedObject && viewer.selectedObject._originalMaterial) {
            viewer.selectedObject.material = viewer.selectedObject._originalMaterial;
        }
        viewer.selectedObject = null;
    });

    function getRawFDS(detail) {
        if (!currentData) return null;
        const idx = detail.index;
        const byId = (arr, id) => arr && arr.find(x => x.id === id);
        const raw  = obj => obj && obj._params && obj._params._raw ? obj._params._raw : null;
        switch (detail.type) {
            case 'OBST':  return raw(idx != null ? currentData.obsts[idx] : byId(currentData.obsts, detail.id));
            case 'VENT':  return raw(idx != null ? currentData.vents[idx] : byId(currentData.vents, detail.id));
            case 'HOLE':  return raw(idx != null ? currentData.holes[idx] : byId(currentData.holes, detail.id));
            case 'MESH':  return raw(byId(currentData.meshes, detail.id));
            case 'DEVC':  return raw(byId(currentData.devcs,  detail.id));
            case 'GEOM':  return raw(byId(currentData.geoms,  detail.id));
            case 'HVAC':  return raw(byId(currentData.hvacs,  detail.id));
            case 'ZONE':  return raw(byId(currentData.zones,  detail.id));
            case 'SLCF':  return raw(byId(currentData.slcfs,  detail.id));
            case 'INIT':  return raw(byId(currentData.inits,  detail.id));
            case 'FIRE':
                if (detail.subtype === 'VENT_HRRPUA')  return raw(byId(currentData.vents, detail.id));
                if (detail.subtype === 'OBST_BURNING') return raw(byId(currentData.obsts, detail.id));
                return null;
            default: return null;
        }
    }

    function infoRow(label, value) {
        return `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`;
    }

    function updateInfoPanel(detail) {
        const panel = document.getElementById('object-info-content');

        if (!detail) {
            infoPanel.classList.remove('visible');
            return;
        }

        infoPanel.classList.add('visible');
        infoTitle.textContent = detail.type || 'Selected Object';

        let html = '';

        if (detail.id)       html += infoRow('ID',       detail.id);

        if (detail.xb) {
            html += `<div class="info-item"><span class="info-label">XB</span><code class="info-xb">${detail.xb.map(v => v.toFixed(3)).join(', ')}</code></div>`;
            const dx = Math.abs(detail.xb[1]-detail.xb[0]), dy = Math.abs(detail.xb[3]-detail.xb[2]), dz = Math.abs(detail.xb[5]-detail.xb[4]);
            html += infoRow('Size', `${dx.toFixed(3)} × ${dy.toFixed(3)} × ${dz.toFixed(3)} m`);
        }

        if (detail.ijk) {
            html += infoRow('IJK', detail.ijk.join(' × '));
            if (detail.xb) {
                const cs = [
                    (Math.abs(detail.xb[1]-detail.xb[0])/detail.ijk[0]).toFixed(4),
                    (Math.abs(detail.xb[3]-detail.xb[2])/detail.ijk[1]).toFixed(4),
                    (Math.abs(detail.xb[5]-detail.xb[4])/detail.ijk[2]).toFixed(4),
                ];
                html += infoRow('Cell', cs.join(' × ') + ' m');
            }
        }

        if (detail.xyz)          html += `<div class="info-item"><span class="info-label">XYZ</span><code class="info-xb">${detail.xyz.map(v=>v.toFixed(3)).join(', ')}</code></div>`;
        if (detail.surf_id)      html += infoRow('SURF_ID',  Array.isArray(detail.surf_id) ? detail.surf_id.join(', ') : detail.surf_id);
        if (detail.quantity)     html += infoRow('QUANTITY', detail.quantity);
        if (detail.prop_id)      html += infoRow('PROP_ID',  detail.prop_id);
        if (detail.part_id)      html += infoRow('PART_ID',  detail.part_id);
        if (detail.subtype)      html += infoRow('Subtype',  detail.subtype);
        if (detail.sphere_origin) html += `<div class="info-item"><span class="info-label">Origin</span><code class="info-xb">${detail.sphere_origin.map(v=>v.toFixed(3)).join(', ')}</code></div>`;
        if (detail.sphere_radius) html += infoRow('Radius',  detail.sphere_radius.toFixed(3) + ' m');
        if (detail.hrrpuv)       html += infoRow('HRRPUV',  detail.hrrpuv + ' kW/m³');
        if (detail.ambient != null) html += infoRow('Ambient', detail.ambient ? 'Yes' : 'No');
        if (detail.node_id)      html += infoRow('Nodes',   (Array.isArray(detail.node_id) ? detail.node_id : [detail.node_id]).join(' → '));
        if (detail.vent_id)      html += infoRow('VENT_ID', detail.vent_id);
        if (detail.pbx != null)  html += infoRow('PBX',     detail.pbx);
        if (detail.pby != null)  html += infoRow('PBY',     detail.pby);
        if (detail.pbz != null)  html += infoRow('PBZ',     detail.pbz);

        const raw = getRawFDS(detail);
        if (raw && typeof highlightFds === 'function') {
            html += `<details class="info-fds-code"><summary>FDS Code</summary><pre class="fp-code-block info-code-block">${highlightFds(raw)}</pre></details>`;
        }

        panel.innerHTML = html;
    }

    // ── Stats ──────────────────────────────────
    function updateStats() {
        const stats = viewer.getStats();
        document.getElementById('stat-meshes').textContent = stats.meshes;
        document.getElementById('stat-obsts').textContent = stats.obsts;
        document.getElementById('stat-vents').textContent = stats.vents;
        document.getElementById('stat-holes').textContent = stats.holes;
        document.getElementById('stat-devcs').textContent = stats.devcs;
        document.getElementById('stat-inits').textContent = stats.inits;
        document.getElementById('stat-geoms').textContent = stats.geoms;
        document.getElementById('stat-hvacs').textContent = stats.hvacs;
        document.getElementById('stat-zones').textContent = stats.zones;
        document.getElementById('stat-slcfs').textContent = stats.slcfs;
        document.getElementById('stat-fires').textContent = stats.fires;
    }

    // ── Load new file button ───────────────────
    document.getElementById('load-new').addEventListener('click', () => {
        fileInput.value = '';
        fileInput.click();
    });

    // ── Theme toggle (light/dark) ──────────────
    const themeBtn  = document.getElementById('toggle-theme');
    const themeIcon = document.getElementById('theme-icon');

    // SVGs: moon shown while in DARK mode (clicking → light); sun shown while in LIGHT mode (clicking → dark)
    const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    const SUN_SVG  = '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.05" y2="7.05"/><line x1="16.95" y1="16.95" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.05" y2="16.95"/><line x1="16.95" y1="7.05" x2="19.07" y2="4.93"/>';

    // Default scene backgrounds for each theme (match a swatch in the
    // sidebar's Background row so the 'active' indicator can follow).
    const THEME_BG = { dark: '#1a1a2e', light: '#e8e8e8' };

    function applyThemedSceneBackground(theme) {
        const bg = THEME_BG[theme] || THEME_BG.dark;
        // Main 3D viewer
        if (viewer && typeof viewer.setBackground === 'function') viewer.setBackground(bg);
        // Highlight the matching bg-option swatch in the 3D Geometry sidebar
        document.querySelectorAll('.bg-option').forEach(b => {
            b.classList.toggle('active', b.dataset.color === bg);
        });
        // Output viewer lives in its own module — let it apply via a window hook
        if (typeof window.outputPageSetSceneBackground === 'function') {
            window.outputPageSetSceneBackground(bg);
        }
    }

    function applyTheme(theme) {
        if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            themeIcon.innerHTML = SUN_SVG;
            themeBtn.title = 'Switch to dark theme';
        } else {
            document.documentElement.removeAttribute('data-theme');
            themeIcon.innerHTML = MOON_SVG;
            themeBtn.title = 'Switch to light theme';
        }
        applyThemedSceneBackground(theme === 'light' ? 'light' : 'dark');
    }

    // Initial: read saved preference, fall back to system preference, fall back to dark
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('fds-viewer-theme'); } catch (e) { /* private mode */ }
    if (!savedTheme) {
        savedTheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    applyTheme(savedTheme);

    themeBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const next = cur === 'light' ? 'dark' : 'light';
        applyTheme(next);
        try { localStorage.setItem('fds-viewer-theme', next); } catch (e) { /* private mode */ }
    });

    // ── Help guide page navigation ─────────────
    // Switches the right-hand pane between the "pages" of the user guide.
    document.querySelectorAll('.help-nav-link').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.helpPage;
            document.querySelectorAll('.help-nav-link').forEach(b => {
                b.classList.toggle('active', b.dataset.helpPage === target);
            });
            document.querySelectorAll('.help-page').forEach(p => {
                p.classList.toggle('active', p.dataset.helpPage === target);
            });
            // Scroll the article back to top whenever the page changes.
            const scrollHost = document.getElementById('help-panel');
            if (scrollHost) scrollHost.scrollTop = 0;
        });
    });

    // ── Licence modal ──────────────────────────
    const licenseModal = document.getElementById('license-modal');
    const licenseOpen  = document.getElementById('show-license');
    const licenseClose = document.getElementById('license-close');
    const licenseBack  = licenseModal && licenseModal.querySelector('.license-modal-backdrop');
    function openLicense()  { if (licenseModal) { licenseModal.style.display = 'flex'; licenseModal.setAttribute('aria-hidden', 'false'); } }
    function closeLicense() { if (licenseModal) { licenseModal.style.display = 'none';  licenseModal.setAttribute('aria-hidden', 'true'); } }
    if (licenseOpen)  licenseOpen.addEventListener('click', openLicense);
    if (licenseClose) licenseClose.addEventListener('click', closeLicense);
    if (licenseBack)  licenseBack.addEventListener('click', closeLicense);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && licenseModal && licenseModal.style.display === 'flex') closeLicense();
    });

    // ── Clip Panel ────────────────────────────
    function initClipPanel() {
        const bounds = viewer.getBoundsFDS();
        if (!bounds) return;

        document.getElementById('clip-panel').classList.add('visible');

        const axes = ['x', 'y', 'z'];
        const mins = [bounds.xmin, bounds.ymin, bounds.zmin];
        const maxs = [bounds.xmax, bounds.ymax, bounds.zmax];

        axes.forEach((ax, i) => {
            const mn = mins[i], mx = maxs[i];
            const step = Math.max(0.01, (mx - mn) / 200);

            const minSlider = document.getElementById('clip-' + ax + 'min');
            const maxSlider = document.getElementById('clip-' + ax + 'max');
            const minInput  = document.getElementById('clip-' + ax + 'min-val');
            const maxInput  = document.getElementById('clip-' + ax + 'max-val');

            [minSlider, maxSlider].forEach(s => { s.min = mn; s.max = mx; s.step = step; });
            minSlider.value = mn; maxSlider.value = mx;
            minInput.min = mn; minInput.max = mx; minInput.step = step; minInput.value = mn.toFixed(2);
            maxInput.min = mn; maxInput.max = mx; maxInput.step = step; maxInput.value = mx.toFixed(2);
        });

        viewer.resetClipPlanes();
    }

    function applyClip() {
        const bounds = viewer.getBoundsFDS();
        if (!bounds) return;

        const vals = {};
        ['x', 'y', 'z'].forEach(ax => {
            let mn = parseFloat(document.getElementById('clip-' + ax + 'min').value);
            let mx = parseFloat(document.getElementById('clip-' + ax + 'max').value);
            if (mn > mx) mn = mx;
            vals[ax] = { mn, mx };
        });

        const atFull = (
            vals.x.mn <= bounds.xmin && vals.x.mx >= bounds.xmax &&
            vals.y.mn <= bounds.ymin && vals.y.mx >= bounds.ymax &&
            vals.z.mn <= bounds.zmin && vals.z.mx >= bounds.zmax
        );

        if (atFull) viewer.resetClipPlanes();
        else viewer.setClipPlanes(vals.x.mn, vals.x.mx, vals.y.mn, vals.y.mx, vals.z.mn, vals.z.mx);
    }

    // Slider → number input + clip
    ['xmin','xmax','ymin','ymax','zmin','zmax'].forEach(id => {
        const slider = document.getElementById('clip-' + id);
        const numIn  = document.getElementById('clip-' + id + '-val');
        slider.addEventListener('input', () => {
            numIn.value = parseFloat(slider.value).toFixed(2);
            applyClip();
        });
        slider.addEventListener('keydown', e => {
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
                e.preventDefault(); slider.blur();
            }
        });
        // Text input → slider + clip (on Enter or blur)
        const commitNumIn = () => {
            const v = parseFloat(numIn.value);
            if (!isNaN(v)) {
                slider.value = Math.min(Math.max(v, parseFloat(slider.min)), parseFloat(slider.max));
                numIn.value = parseFloat(slider.value).toFixed(2);
                applyClip();
            }
        };
        numIn.addEventListener('change', commitNumIn);
        numIn.addEventListener('blur', commitNumIn);
        numIn.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') { commitNumIn(); numIn.blur(); }
        });
    });

    // Custom ▲▼ step buttons
    document.querySelectorAll('.clip-step').forEach(btn => {
        btn.addEventListener('click', () => {
            const numIn = document.getElementById(btn.dataset.id);
            const axId  = btn.dataset.id.replace('-val', '');
            const slider = document.getElementById(axId);
            const dir  = parseFloat(btn.dataset.dir);
            const step = parseFloat(slider.step) || 0.1;
            const v    = parseFloat(numIn.value) || 0;
            const newV = Math.min(Math.max(v + dir * step, parseFloat(slider.min)), parseFloat(slider.max));
            numIn.value  = newV.toFixed(2);
            slider.value = newV;
            applyClip();
        });
    });

    document.getElementById('clip-reset-btn').addEventListener('click', () => {
        initClipPanel();
    });

    // ── Keyboard shortcuts ─────────────────────
    document.addEventListener('keydown', (e) => {
        if (!currentData) return;
        // Don't hijack typing in form fields — only the clip inputs call
        // stopPropagation themselves; output-page numeric inputs don't.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

        switch (e.key) {
            case '1': viewer.setView('front'); break;
            case '2': viewer.setView('back'); break;
            case '3': viewer.setView('left'); break;
            case '4': viewer.setView('right'); break;
            case '5': viewer.setView('top'); break;
            case '6': viewer.setView('bottom'); break;
            case '0': viewer.setView('iso'); break;
            case 'r': viewer.resetCamera(); break;
        }
    });
});

// Sample FDS lives in examples/sample_room_fire.fds and is fetched on
// demand by the "Load Sample" button above.
