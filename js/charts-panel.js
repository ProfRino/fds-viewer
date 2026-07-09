/**
 * Charts Panel — FDS CSV time-series plotter
 * v20260608A
 *
 * FDS CSV format (two header rows):
 *   Row 0 — units:    s,  °C,  kW, …
 *   Row 1 — headers: Time, TC_001, HRR, …
 *   Row 2+ — numeric data
 *
 * Exposed globals:
 *   buildChartsPanel()            — initialise / show the panel
 *   chartsPanelHandleFiles(files) — load an array of File objects
 */
(function () {
    'use strict';

    const PALETTE = [
        '#e94560', '#4488ff', '#4caf50', '#ff9800', '#e040fb',
        '#00bcd4', '#ffb300', '#8bc34a', '#f06292', '#26c6da',
        '#ff5722', '#9c27b0', '#03a9f4', '#795548', '#607d8b',
    ];

    const FONT = "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";

    // ── State ──────────────────────────────────────────────────────────────────
    let datasets      = [];
    let selectedKeys  = new Set();
    let colorMap      = {};
    let lineStyleMap  = {};  // key -> 'solid' | 'dashed' | 'dotted' | 'dashdot'
    let lineWidthMap  = {};  // key -> number (line thickness in CSS px)
    let colorCounter  = 0;
    let _initialized  = false;
    let _ccpEl        = null;
    let _activeKey    = null;

    function defaultOpt() {
        return {
            decimalSep: '.',      // '.' | ','
            showGrid:   true,
            gridStyle:  'dashed', // 'dashed' | 'solid'
            xLabel:     '',       // '' = auto "Time (s)"
            yLabel:     '',       // '' = auto from left-axis units
            yLabel2:    '',       // '' = auto from right-axis units
            watermark:  true,
        };
    }

    // ── CSV Parser ─────────────────────────────────────────────────────────────
    function parseCSVData(text, opts) {
        const colSep   = opts.decimalSep === ',' ? ';' : ',';
        const decComma = opts.decimalSep === ',';
        const lines    = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const rows     = lines.filter(l => l.trim() !== '');
        if (rows.length < 3) return null;

        function splitRow(l) {
            const cols = []; let cur = '', inQ = false;
            for (let i = 0; i < l.length; i++) {
                const c = l[i];
                if (c === '"') { inQ = !inQ; continue; }
                if (c === colSep && !inQ) { cols.push(cur.trim()); cur = ''; }
                else cur += c;
            }
            cols.push(cur.trim());
            return cols;
        }

        const unitRow   = splitRow(rows[0]);
        const headerRow = splitRow(rows[1]);
        const n = Math.min(unitRow.length, headerRow.length);
        if (n < 2) return null;

        const columns = Array.from({ length: n }, () => []);
        for (let r = 2; r < rows.length; r++) {
            const cells = splitRow(rows[r]);
            for (let c = 0; c < n; c++) {
                let raw = (cells[c] || '').trim();
                if (decComma) raw = raw.replace(/,/g, '.');
                const v = parseFloat(raw);
                columns[c].push(isFinite(v) ? v : NaN);
            }
        }
        if (!columns[0].length || !isFinite(columns[0][0])) return null;

        return {
            units:   unitRow.slice(0, n),
            headers: headerRow.slice(0, n),
            columns,
        };
    }

    function parseCSV(text, filename, opts) {
        const data = parseCSVData(text, opts);
        if (!data) return null;
        return {
            id:      filename + '_' + Date.now(),
            filename,
            rawText: text,
            title:   '',
            opt:     opts,
            units:   data.units,
            headers: data.headers,
            columns: data.columns,
            canvas:  null, ctx: null, tipEl: null, ro: null, _pending: false,
        };
    }

    function reparse(ds) {
        const data = parseCSVData(ds.rawText, ds.opt);
        if (data) {
            ds.units   = data.units;
            ds.headers = data.headers;
            ds.columns = data.columns;
        }
    }

    // ── Dataset Management ─────────────────────────────────────────────────────
    function addDataset(ds) {
        const old = datasets.find(d => d.filename === ds.filename);
        if (old) removeDataset(old.id);
        datasets.push(ds);
        let n = 0;
        for (let i = 1; i < ds.headers.length; i++) {
            const key = ds.id + '::' + i;
            if (!colorMap[key])     { colorMap[key]     = PALETTE[colorCounter % PALETTE.length]; colorCounter++; }
            if (!lineStyleMap[key]) lineStyleMap[key]   = 'solid';
            if (!lineWidthMap[key]) lineWidthMap[key]   = 2;
            if (n < 10) { selectedKeys.add(key); n++; }
        }
        buildDatasetCard(ds);
    }

    function removeDataset(id) {
        const ds = datasets.find(d => d.id === id);
        if (ds) {
            if (ds.ro) ds.ro.disconnect();
            document.querySelectorAll('.chart-card').forEach(c => { if (c.dataset.id === id) c.remove(); });
            for (let i = 1; i < ds.headers.length; i++) {
                const key = ds.id + '::' + i;
                selectedKeys.delete(key);
                delete colorMap[key];
                delete lineStyleMap[key];
                delete lineWidthMap[key];
            }
        }
        datasets = datasets.filter(d => d.id !== id);
    }

    // ── Axis helpers ───────────────────────────────────────────────────────────
    function niceNum(range, round) {
        if (range <= 0) return 1;
        const exp = Math.floor(Math.log10(Math.abs(range)));
        const f   = range / Math.pow(10, exp);
        let nf;
        if (round) { nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; }
        else       { nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; }
        return nf * Math.pow(10, exp);
    }

    function niceScale(min, max, nticks) {
        if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, step: 0.25 };
        if (min === max) { const v = min || 0; return { min: v - 1, max: v + 1, step: 0.5 }; }
        const range = niceNum(max - min, false);
        const step  = niceNum(range / (nticks - 1), true);
        return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
    }

    // ── Line style helpers ─────────────────────────────────────────────────────
    function getDash(style) {
        if (style === 'dashed')  return [6, 4];
        if (style === 'dotted')  return [2, 3];
        if (style === 'dashdot') return [6, 3, 2, 3];
        return [];
    }
    function getSVGDash(style) {
        if (style === 'dashed')  return '6,4';
        if (style === 'dotted')  return '2,3';
        if (style === 'dashdot') return '6,3,2,3';
        return '';
    }

    function fmtTick(v) {
        const a = Math.abs(v);
        if (a >= 1e6 || (a < 1e-3 && a !== 0)) return v.toExponential(1);
        if (a >= 1e3) return v.toFixed(0);
        if (a >= 100) return v.toFixed(1);
        if (a >= 10)  return v.toFixed(2);
        return (v.toFixed(3)).replace(/\.?0+$/, '') || '0';
    }

    // ── Active series ──────────────────────────────────────────────────────────
    function getActiveSeries(ds) {
        const out = [];
        for (let i = 1; i < ds.headers.length; i++) {
            const key = ds.id + '::' + i;
            if (!selectedKeys.has(key)) continue;
            out.push({ key,
                       color:     colorMap[key]     || '#888',
                       lineStyle: lineStyleMap[key] || 'solid',
                       lineWidth: lineWidthMap[key] || 2,
                       label:     ds.headers[i],
                       unit:      ds.units[i] || '',
                       time:      ds.columns[0],
                       values:    ds.columns[i] });
        }
        return out;
    }

    // Split into left-axis group (first unit) and right-axis group (all other units)
    function getActiveSeriesGrouped(ds) {
        const series = getActiveSeries(ds);
        if (series.length === 0) return { left: [], right: [] };
        const firstUnit = series[0].unit;
        return {
            left:  series.filter(s => s.unit === firstUnit),
            right: series.filter(s => s.unit !== firstUnit),
        };
    }

    // ── Layout ─────────────────────────────────────────────────────────────────
    function mkLayout(allSeries, W, H, hasRight, hasTitle) {
        const lc = allSeries.length > 0 ? Math.min(allSeries.length, 3) : 1;
        const lr = allSeries.length > 0 ? Math.ceil(allSeries.length / lc) : 0;
        const ML = 72, MR = hasRight ? 68 : 20;
        const MT = hasTitle ? 44 : 24;
        const MB = 48 + lr * 20;
        return { ML, MR, MT, MB, W: W - ML - MR, H: H - MT - MB, lc, lr };
    }

    // ── Canvas rendering ───────────────────────────────────────────────────────
    function renderDataset(ds) {
        ds._pending = false;
        if (!ds.canvas || !ds.ctx) return;

        const wrap = ds.canvas.parentElement;
        if (!wrap) return;
        const dpr = window.devicePixelRatio || 1;
        const W   = wrap.clientWidth;
        const H   = wrap.clientHeight;
        if (W < 40 || H < 40) return;

        const bw = Math.round(W * dpr);
        const bh = Math.round(H * dpr);
        if (ds.canvas.width !== bw || ds.canvas.height !== bh) {
            ds.canvas.width  = bw;
            ds.canvas.height = bh;
        }

        const light = document.documentElement.getAttribute('data-theme') === 'light';
        const bg    = light ? '#ffffff'           : '#16213e';
        const fg    = light ? '#1a1a2e'           : '#c8cce0';
        const gc    = light ? 'rgba(0,0,0,0.08)'  : 'rgba(255,255,255,0.07)';
        const ac    = light ? 'rgba(0,0,0,0.25)'  : 'rgba(255,255,255,0.2)';
        const wmC   = light ? 'rgba(0,0,0,0.16)'  : 'rgba(255,255,255,0.10)';

        const ctx = ds.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const { left: leftS, right: rightS } = getActiveSeriesGrouped(ds);
        const allSeries = leftS.concat(rightS);
        const hasRight  = rightS.length > 0;
        const hasTitle  = !!ds.title;

        // Update mixed-units warning badge
        const rightUnits = [...new Set(rightS.map(s => s.unit).filter(Boolean))];
        const hasMixedRight = hasRight && rightUnits.length > 1;
        const _wrap2 = ds.canvas ? ds.canvas.parentElement : null;
        const _card  = _wrap2 && _wrap2.closest ? _wrap2.closest('.chart-card') : null;
        const _warnEl = _card ? _card.querySelector('.chart-mixed-warn') : null;
        if (_warnEl) _warnEl.style.display = hasMixedRight ? '' : 'none';

        if (allSeries.length === 0) {
            ctx.fillStyle = fg; ctx.font = `13px ${FONT}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('Select channels in the sidebar', W / 2, H / 2);
            return;
        }

        // Data extents
        let tMin = Infinity, tMax = -Infinity;
        let yMin = Infinity, yMax = -Infinity;
        let y2Min = Infinity, y2Max = -Infinity;
        for (const s of allSeries) {
            for (const v of s.time) { if (isFinite(v)) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); } }
        }
        for (const s of leftS) {
            for (const v of s.values) { if (isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }
        }
        if (hasRight) {
            for (const s of rightS) {
                for (const v of s.values) { if (isFinite(v)) { y2Min = Math.min(y2Min, v); y2Max = Math.max(y2Max, v); } }
            }
        }
        if (!isFinite(tMin) || !isFinite(yMin)) return;

        const L   = mkLayout(allSeries, W, H, hasRight, hasTitle);
        if (L.W < 40 || L.H < 40) return;

        const xs  = niceScale(tMin, tMax, 7);
        const ys  = niceScale(yMin, yMax, 7);
        const ys2 = hasRight ? niceScale(y2Min, y2Max, 7) : null;

        const tx  = t => L.ML + (t - xs.min)  / (xs.max  - xs.min)  * L.W;
        const ty  = v => L.MT + L.H - (v - ys.min)  / (ys.max  - ys.min)  * L.H;
        const ty2 = ys2 ? (v => L.MT + L.H - (v - ys2.min) / (ys2.max - ys2.min) * L.H) : null;

        // Chart title
        if (hasTitle) {
            ctx.font = `bold 14px ${FONT}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillStyle = fg;
            ctx.fillText(ds.title, L.ML + L.W / 2, 8);
        }

        // Grid
        if (ds.opt.showGrid) {
            ctx.strokeStyle = gc; ctx.lineWidth = 1;
            if (ds.opt.gridStyle === 'dashed') ctx.setLineDash([3, 4]);
            for (let y = ys.min; y <= ys.max + ys.step * 0.01; y = +(y + ys.step).toPrecision(10)) {
                const py = ty(y);
                if (py < L.MT - 2 || py > L.MT + L.H + 2) continue;
                ctx.beginPath(); ctx.moveTo(L.ML, py); ctx.lineTo(L.ML + L.W, py); ctx.stroke();
            }
            for (let x = xs.min; x <= xs.max + xs.step * 0.01; x = +(x + xs.step).toPrecision(10)) {
                const px = tx(x);
                if (px < L.ML - 2 || px > L.ML + L.W + 2) continue;
                ctx.beginPath(); ctx.moveTo(px, L.MT); ctx.lineTo(px, L.MT + L.H); ctx.stroke();
            }
            ctx.setLineDash([]);
        }

        // Axes
        ctx.strokeStyle = ac; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(L.ML,     L.MT);       ctx.lineTo(L.ML,        L.MT + L.H + 1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(L.ML - 1, L.MT + L.H); ctx.lineTo(L.ML + L.W,  L.MT + L.H);    ctx.stroke();
        if (hasRight) {
            ctx.beginPath(); ctx.moveTo(L.ML + L.W, L.MT); ctx.lineTo(L.ML + L.W, L.MT + L.H + 1); ctx.stroke();
        }

        ctx.fillStyle = fg; ctx.font = `11px ${FONT}`;

        // Left Y tick labels
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (let y = ys.min; y <= ys.max + ys.step * 0.01; y = +(y + ys.step).toPrecision(10)) {
            const py = ty(y);
            if (py < L.MT - 8 || py > L.MT + L.H + 8) continue;
            ctx.fillText(fmtTick(y), L.ML - 8, py);
        }

        // Right Y tick labels
        if (hasRight && ys2) {
            ctx.textAlign = 'left';
            for (let y = ys2.min; y <= ys2.max + ys2.step * 0.01; y = +(y + ys2.step).toPrecision(10)) {
                const py = ty2(y);
                if (py < L.MT - 8 || py > L.MT + L.H + 8) continue;
                ctx.fillText(fmtTick(y), L.ML + L.W + 8, py);
            }
        }

        // X tick labels
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let x = xs.min; x <= xs.max + xs.step * 0.01; x = +(x + xs.step).toPrecision(10)) {
            const px = tx(x);
            if (px < L.ML - 4 || px > L.ML + L.W + 4) continue;
            ctx.fillText(fmtTick(x), px, L.MT + L.H + 6);
        }

        ctx.font = `bold 13px ${FONT}`; ctx.fillStyle = fg;

        // X axis label
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(ds.opt.xLabel || 'Time (s)', L.ML + L.W / 2, H - 6);

        // Left Y axis label
        const uSetL = [...new Set(leftS.map(s => s.unit).filter(Boolean))];
        const yLblL = ds.opt.yLabel || (uSetL.length === 1 ? uSetL[0] : uSetL.length === 0 ? 'Value' : 'Value (mixed)');
        ctx.save();
        ctx.translate(13, L.MT + L.H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(yLblL, 0, 0);
        ctx.restore();

        // Right Y axis label
        if (hasRight) {
            const uSetR = [...new Set(rightS.map(s => s.unit).filter(Boolean))];
            const yLblR = ds.opt.yLabel2 || (uSetR.length === 1 ? uSetR[0] : uSetR.length === 0 ? 'Value' : 'Value (mixed)');
            ctx.save();
            ctx.translate(W - 13, L.MT + L.H / 2);
            ctx.rotate(Math.PI / 2);
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText(yLblR, 0, 0);
            ctx.restore();
        }

        // Series lines (clipped to plot area)
        ctx.save();
        ctx.beginPath(); ctx.rect(L.ML, L.MT, L.W, L.H); ctx.clip();

        for (const s of leftS) {
            ctx.beginPath();
            ctx.strokeStyle = s.color;
            ctx.lineWidth   = s.lineWidth;
            ctx.setLineDash(getDash(s.lineStyle));
            let first = true;
            const n = Math.min(s.time.length, s.values.length);
            const st = Math.max(1, Math.ceil(n / 5000));
            for (let i = 0; i < n; i += st) {
                if (!isFinite(s.time[i]) || !isFinite(s.values[i])) { first = true; continue; }
                const px = tx(s.time[i]), py = ty(s.values[i]);
                if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        if (hasRight && ty2) {
            for (const s of rightS) {
                ctx.beginPath();
                ctx.strokeStyle = s.color;
                ctx.lineWidth   = s.lineWidth;
                ctx.setLineDash(getDash(s.lineStyle));
                let first = true;
                const n = Math.min(s.time.length, s.values.length);
                const st = Math.max(1, Math.ceil(n / 5000));
                for (let i = 0; i < n; i += st) {
                    if (!isFinite(s.time[i]) || !isFinite(s.values[i])) { first = true; continue; }
                    const px = tx(s.time[i]), py = ty2(s.values[i]);
                    if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }
        }
        ctx.setLineDash([]);
        ctx.restore();

        // Legend — draw a styled line segment as the marker
        const colW = L.W / L.lc;
        const legY = L.MT + L.H + 28;
        ctx.font = `11px ${FONT}`;
        allSeries.forEach((s, i) => {
            const row = Math.floor(i / L.lc), col = i % L.lc;
            const lx = L.ML + col * colW, ly = legY + row * 20;
            ctx.save();
            ctx.strokeStyle = s.color;
            ctx.lineWidth   = Math.max(1, s.lineWidth);
            ctx.setLineDash(getDash(s.lineStyle));
            ctx.beginPath(); ctx.moveTo(lx, ly + 4.5); ctx.lineTo(lx + 18, ly + 4.5); ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
            ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            const labelText = s.unit ? `${s.label} (${s.unit})` : s.label;
            ctx.fillText(labelText, lx + 24, ly + 4.5, colW - 30);
        });

        // Plot border
        ctx.strokeStyle = ac; ctx.lineWidth = 1;
        ctx.strokeRect(L.ML, L.MT, L.W, L.H);

        // Watermark
        if (ds.opt.watermark) {
            ctx.save();
            ctx.font = `9px ${FONT}`;
            ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
            ctx.fillStyle = wmC;
            ctx.fillText('FDS Viewer', L.ML + L.W - 4, L.MT + L.H - 4);
            ctx.restore();
        }
    }

    function scheduleRender(ds) {
        if (ds._pending) return;
        ds._pending = true;
        requestAnimationFrame(() => renderDataset(ds));
    }

    function scheduleAll() { for (const ds of datasets) scheduleRender(ds); }

    // ── Build per-dataset card ─────────────────────────────────────────────────
    function buildDatasetCard(ds) {
        const list = document.getElementById('charts-cards-list');
        if (!list) return;
        const ph = list.querySelector('.charts-empty-cards-msg');
        if (ph) ph.remove();

        // Unique name for radio group so multiple cards don't interfere
        const radName = 'dec-' + ds.id.replace(/[^a-zA-Z0-9]/g, '_');

        const card = document.createElement('div');
        card.className  = 'chart-card';
        card.dataset.id = ds.id;
        card.innerHTML =
            '<div class="chart-card-header">' +
                '<div class="chart-card-title-area">' +
                    '<span class="chart-card-filename" title="' + esc(ds.filename) + '">' + esc(ds.filename) + '</span>' +
                    '<input type="text" class="chart-title-input" placeholder="Chart title…" value="">' +
                '</div>' +
                '<div class="chart-card-actions">' +
                    '<button class="fp-copy-btn chart-opts-toggle" title="Options">&#x2699;</button>' +
                    '<button class="fp-copy-btn chart-export-btn" data-fmt="png">&#x2193; PNG</button>' +
                    '<button class="fp-copy-btn chart-export-btn" data-fmt="svg">&#x2193; SVG</button>' +
                    '<button class="fp-copy-btn chart-export-btn" data-fmt="pdf">&#x2193; PDF</button>' +
                '</div>' +
            '</div>' +
            '<div class="chart-card-opts" style="display:none;">' +
                '<div class="chart-opts-inner">' +
                    '<div class="chart-opt-group">' +
                        '<span class="chart-opts-label">Decimal</span>' +
                        '<label><input type="radio" name="' + radName + '" class="opt-decimal" value="."> . Period</label>' +
                        '<label><input type="radio" name="' + radName + '" class="opt-decimal" value=","> , Comma</label>' +
                    '</div>' +
                    '<div class="chart-opt-group">' +
                        '<label><input type="checkbox" class="opt-grid" checked> Grid</label>' +
                        '<select class="opt-grid-style">' +
                            '<option value="dashed">Dashed</option>' +
                            '<option value="solid">Solid</option>' +
                        '</select>' +
                    '</div>' +
                    '<div class="chart-opt-group">' +
                        '<span class="chart-opts-label">X label</span>' +
                        '<input type="text" class="opt-xlabel opt-text-input" placeholder="Time (s)">' +
                    '</div>' +
                    '<div class="chart-opt-group">' +
                        '<span class="chart-opts-label">Y label</span>' +
                        '<input type="text" class="opt-ylabel opt-text-input" placeholder="auto">' +
                    '</div>' +
                    '<div class="chart-opt-group">' +
                        '<span class="chart-opts-label">Y₂ label</span>' +
                        '<input type="text" class="opt-ylabel2 opt-text-input" placeholder="auto">' +
                    '</div>' +
                    '<div class="chart-opt-group">' +
                        '<label><input type="checkbox" class="opt-watermark" checked> Watermark</label>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="chart-mixed-warn" style="display:none;">' +
                '&#9888; Right Y-axis shows mixed units &mdash; channels share one scale' +
            '</div>' +
            '<div class="chart-canvas-wrap">' +
                '<canvas></canvas>' +
                '<div class="chart-tooltip" style="display:none;"></div>' +
            '</div>';

        list.appendChild(card);

        const wrap = card.querySelector('.chart-canvas-wrap');
        ds.canvas  = wrap.querySelector('canvas');
        ds.ctx     = ds.canvas.getContext('2d');
        ds.tipEl   = wrap.querySelector('.chart-tooltip');

        // Set initial decimal radio to match ds.opt
        card.querySelectorAll('.opt-decimal').forEach(r => {
            if (r.value === ds.opt.decimalSep) r.checked = true;
        });

        wireCardOptions(ds, card);

        if (typeof ResizeObserver !== 'undefined') {
            ds.ro = new ResizeObserver(() => scheduleRender(ds));
            ds.ro.observe(wrap);
        }
        requestAnimationFrame(() => scheduleRender(ds));

        ds.canvas.addEventListener('mousemove',  e => tooltip(e, ds));
        ds.canvas.addEventListener('mouseleave', () => { if (ds.tipEl) ds.tipEl.style.display = 'none'; });

        card.querySelectorAll('.chart-export-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.fmt === 'png') exportPNG(ds);
                else if (btn.dataset.fmt === 'svg') exportSVG(ds);
                else if (btn.dataset.fmt === 'pdf') exportPDF(ds);
            });
        });
    }

    function wireCardOptions(ds, card) {
        // Title input
        const titleIn = card.querySelector('.chart-title-input');
        titleIn.addEventListener('input', () => { ds.title = titleIn.value; scheduleRender(ds); });

        // Options panel toggle
        const optsPanel = card.querySelector('.chart-card-opts');
        const toggleBtn = card.querySelector('.chart-opts-toggle');
        toggleBtn.addEventListener('click', () => {
            const open = optsPanel.style.display === 'block';
            optsPanel.style.display = open ? 'none' : 'block';
            toggleBtn.classList.toggle('chart-opts-active', !open);
        });

        // Decimal separator — re-parses on change
        card.querySelectorAll('.opt-decimal').forEach(r => {
            r.addEventListener('change', () => {
                ds.opt.decimalSep = r.value;
                reparse(ds);
                rebuildChannelList();
                scheduleRender(ds);
            });
        });

        // Grid
        const gridCb = card.querySelector('.opt-grid');
        gridCb.addEventListener('change', () => { ds.opt.showGrid = gridCb.checked; scheduleRender(ds); });

        const gridSt = card.querySelector('.opt-grid-style');
        gridSt.addEventListener('change', () => { ds.opt.gridStyle = gridSt.value; scheduleRender(ds); });

        // Axis labels
        const xl  = card.querySelector('.opt-xlabel');
        xl.addEventListener('input', () => { ds.opt.xLabel = xl.value.trim(); scheduleRender(ds); });

        const yl  = card.querySelector('.opt-ylabel');
        yl.addEventListener('input', () => { ds.opt.yLabel = yl.value.trim(); scheduleRender(ds); });

        const yl2 = card.querySelector('.opt-ylabel2');
        yl2.addEventListener('input', () => { ds.opt.yLabel2 = yl2.value.trim(); scheduleRender(ds); });

        // Watermark
        const wmCb = card.querySelector('.opt-watermark');
        wmCb.addEventListener('change', () => { ds.opt.watermark = wmCb.checked; scheduleRender(ds); });
    }

    // ── Tooltip ────────────────────────────────────────────────────────────────
    function tooltip(e, ds) {
        if (!ds.tipEl) return;
        const { left: leftS, right: rightS } = getActiveSeriesGrouped(ds);
        const allSeries = leftS.concat(rightS);
        if (!allSeries.length) { ds.tipEl.style.display = 'none'; return; }

        const rect = ds.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const W  = rect.width;
        const H  = rect.height;

        let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (const s of allSeries) {
            for (const v of s.time)   { if (isFinite(v)) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); } }
            for (const v of s.values) { if (isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }
        }
        if (!isFinite(tMin)) { ds.tipEl.style.display = 'none'; return; }

        const L = mkLayout(allSeries, W, H, rightS.length > 0, !!ds.title);
        if (mx < L.ML || mx > L.ML + L.W || my < L.MT || my > L.MT + L.H) {
            ds.tipEl.style.display = 'none'; return;
        }

        const xs = niceScale(tMin, tMax, 7);
        const t  = xs.min + (mx - L.ML) / L.W * (xs.max - xs.min);
        const ref = allSeries[0];
        let bi = 0, bd = Infinity;
        for (let i = 0; i < ref.time.length; i++) {
            const d = Math.abs(ref.time[i] - t);
            if (d < bd) { bd = d; bi = i; }
        }

        let html = '<div class="chart-tip-time">t = ' + ref.time[bi].toFixed(3) + ' s</div>';
        for (const s of allSeries) {
            const v  = s.values[bi];
            const vs = isFinite(v) ? (+v.toPrecision(5)).toString() : '—';
            html += '<div class="chart-tip-row">' +
                '<span class="chart-tip-dot" style="background:' + s.color + '"></span>' +
                '<span class="chart-tip-label">' + esc(s.label) + ':</span> ' +
                '<span class="chart-tip-val">' + vs + '</span>' +
                (s.unit ? ' <span class="chart-tip-unit">' + esc(s.unit) + '</span>' : '') +
                '</div>';
        }
        ds.tipEl.innerHTML = html;
        ds.tipEl.style.display = 'block';

        const tw = 180, th = ds.tipEl.offsetHeight || 80;
        let ttx = mx + 14, tty = my - 10;
        if (ttx + tw > W - 4) ttx = mx - tw - 8;
        if (tty + th > H - 4) tty = H - th - 4;
        if (tty < 4) tty = 4;
        ds.tipEl.style.left = ttx + 'px';
        ds.tipEl.style.top  = tty + 'px';
    }

    // ── SVG builder ────────────────────────────────────────────────────────────
    function buildSVG(ds, svgW, svgH) {
        const { left: leftS, right: rightS } = getActiveSeriesGrouped(ds);
        const allSeries = leftS.concat(rightS);
        const hasRight  = rightS.length > 0;
        const hasTitle  = !!ds.title;
        const L  = mkLayout(allSeries, svgW, svgH, hasRight, hasTitle);
        const bg = '#ffffff', fg = '#1a1a2e', gc = '#dddddd', ac = '#aaaaaa';
        const ff = "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";

        let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">`;
        o += `<rect width="${svgW}" height="${svgH}" fill="${bg}"/>`;

        if (allSeries.length === 0) {
            return o + `<text x="${svgW/2}" y="${svgH/2}" text-anchor="middle" dominant-baseline="middle"` +
                ` font-family="${ff}" font-size="13" fill="${fg}">No channels selected</text></svg>`;
        }

        if (hasTitle) {
            o += `<text x="${(L.ML + L.W / 2).toFixed(1)}" y="24" text-anchor="middle"` +
                ` font-family="${ff}" font-size="14" font-weight="bold" fill="${fg}">${esc(ds.title)}</text>`;
        }

        let tMin = Infinity, tMax = -Infinity;
        let yMin = Infinity, yMax = -Infinity;
        let y2Min = Infinity, y2Max = -Infinity;
        for (const s of allSeries) {
            for (const v of s.time) { if (isFinite(v)) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); } }
        }
        for (const s of leftS) {
            for (const v of s.values) { if (isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }
        }
        if (hasRight) {
            for (const s of rightS) {
                for (const v of s.values) { if (isFinite(v)) { y2Min = Math.min(y2Min, v); y2Max = Math.max(y2Max, v); } }
            }
        }

        const xs  = niceScale(tMin, tMax, 7);
        const ys  = niceScale(yMin, yMax, 7);
        const ys2 = hasRight ? niceScale(y2Min, y2Max, 7) : null;
        const tx  = t => L.ML + (t  - xs.min)  / (xs.max  - xs.min)  * L.W;
        const ty  = v => L.MT + L.H - (v - ys.min)  / (ys.max  - ys.min)  * L.H;
        const ty2 = ys2 ? (v => L.MT + L.H - (v - ys2.min) / (ys2.max - ys2.min) * L.H) : null;

        // Grid
        if (ds.opt.showGrid) {
            const da = ds.opt.gridStyle === 'dashed' ? ' stroke-dasharray="3,4"' : '';
            for (let y = ys.min; y <= ys.max + ys.step * 0.01; y = +(y + ys.step).toPrecision(10)) {
                const py = ty(y).toFixed(1);
                o += `<line x1="${L.ML}" y1="${py}" x2="${L.ML+L.W}" y2="${py}" stroke="${gc}" stroke-width="1"${da}/>`;
            }
            for (let x = xs.min; x <= xs.max + xs.step * 0.01; x = +(x + xs.step).toPrecision(10)) {
                const px = tx(x).toFixed(1);
                o += `<line x1="${px}" y1="${L.MT}" x2="${px}" y2="${L.MT+L.H}" stroke="${gc}" stroke-width="1"${da}/>`;
            }
        }

        // Axes
        o += `<line x1="${L.ML}" y1="${L.MT}" x2="${L.ML}" y2="${L.MT+L.H}" stroke="${ac}" stroke-width="1.5"/>`;
        o += `<line x1="${L.ML}" y1="${L.MT+L.H}" x2="${L.ML+L.W}" y2="${L.MT+L.H}" stroke="${ac}" stroke-width="1.5"/>`;
        if (hasRight) {
            o += `<line x1="${L.ML+L.W}" y1="${L.MT}" x2="${L.ML+L.W}" y2="${L.MT+L.H}" stroke="${ac}" stroke-width="1.5"/>`;
        }

        // Left Y ticks
        for (let y = ys.min; y <= ys.max + ys.step * 0.01; y = +(y + ys.step).toPrecision(10)) {
            const py = ty(y).toFixed(1);
            o += `<text x="${L.ML-8}" y="${py}" text-anchor="end" dominant-baseline="middle"` +
                ` font-family="${ff}" font-size="11" fill="${fg}">${esc(fmtTick(y))}</text>`;
        }
        // Right Y ticks
        if (hasRight && ys2 && ty2) {
            for (let y = ys2.min; y <= ys2.max + ys2.step * 0.01; y = +(y + ys2.step).toPrecision(10)) {
                const py = ty2(y).toFixed(1);
                o += `<text x="${L.ML+L.W+8}" y="${py}" text-anchor="start" dominant-baseline="middle"` +
                    ` font-family="${ff}" font-size="11" fill="${fg}">${esc(fmtTick(y))}</text>`;
            }
        }
        // X ticks
        for (let x = xs.min; x <= xs.max + xs.step * 0.01; x = +(x + xs.step).toPrecision(10)) {
            const px = tx(x).toFixed(1);
            o += `<text x="${px}" y="${L.MT+L.H+16}" text-anchor="middle"` +
                ` font-family="${ff}" font-size="11" fill="${fg}">${esc(fmtTick(x))}</text>`;
        }

        // X label
        o += `<text x="${(L.ML+L.W/2).toFixed(1)}" y="${svgH-6}" text-anchor="middle"` +
            ` font-family="${ff}" font-size="13" font-weight="bold" fill="${fg}">${esc(ds.opt.xLabel || 'Time (s)')}</text>`;

        // Left Y label
        const uSetL = [...new Set(leftS.map(s => s.unit).filter(Boolean))];
        const yLblL = ds.opt.yLabel || (uSetL.length === 1 ? uSetL[0] : uSetL.length === 0 ? 'Value' : 'Value (mixed)');
        o += `<text transform="translate(13,${(L.MT+L.H/2).toFixed(1)}) rotate(-90)" text-anchor="middle"` +
            ` font-family="${ff}" font-size="13" font-weight="bold" fill="${fg}">${esc(yLblL)}</text>`;

        // Right Y label
        if (hasRight) {
            const uSetR = [...new Set(rightS.map(s => s.unit).filter(Boolean))];
            const yLblR = ds.opt.yLabel2 || (uSetR.length === 1 ? uSetR[0] : uSetR.length === 0 ? 'Value' : 'Value (mixed)');
            o += `<text transform="translate(${svgW-13},${(L.MT+L.H/2).toFixed(1)}) rotate(90)" text-anchor="middle"` +
                ` font-family="${ff}" font-size="13" font-weight="bold" fill="${fg}">${esc(yLblR)}</text>`;
        }

        o += `<clipPath id="cc"><rect x="${L.ML}" y="${L.MT}" width="${L.W}" height="${L.H}"/></clipPath>`;

        // Left series
        for (const s of leftS) {
            let d = '', first = true;
            const n = Math.min(s.time.length, s.values.length);
            const st = Math.max(1, Math.ceil(n / 5000));
            for (let i = 0; i < n; i += st) {
                if (!isFinite(s.time[i]) || !isFinite(s.values[i])) { first = true; continue; }
                const px = tx(s.time[i]).toFixed(2), py = ty(s.values[i]).toFixed(2);
                d += first ? `M ${px},${py}` : ` L ${px},${py}`;
                first = false;
            }
            if (d) {
                const dash = getSVGDash(s.lineStyle);
                const daAttr = dash ? ` stroke-dasharray="${dash}"` : '';
                o += `<path d="${d}" stroke="${s.color}" stroke-width="${s.lineWidth}" fill="none" clip-path="url(#cc)"${daAttr}/>`;
            }
        }
        // Right series
        if (hasRight && ty2) {
            for (const s of rightS) {
                let d = '', first = true;
                const n = Math.min(s.time.length, s.values.length);
                const st = Math.max(1, Math.ceil(n / 5000));
                for (let i = 0; i < n; i += st) {
                    if (!isFinite(s.time[i]) || !isFinite(s.values[i])) { first = true; continue; }
                    const px = tx(s.time[i]).toFixed(2), py = ty2(s.values[i]).toFixed(2);
                    d += first ? `M ${px},${py}` : ` L ${px},${py}`;
                    first = false;
                }
                if (d) {
                    const dash = getSVGDash(s.lineStyle);
                    const daAttr = dash ? ` stroke-dasharray="${dash}"` : '';
                    o += `<path d="${d}" stroke="${s.color}" stroke-width="${s.lineWidth}" fill="none" clip-path="url(#cc)"${daAttr}/>`;
                }
            }
        }

        o += `<rect x="${L.ML}" y="${L.MT}" width="${L.W}" height="${L.H}" fill="none" stroke="${ac}" stroke-width="1"/>`;

        // Legend
        const colW = L.W / L.lc;
        const legY = L.MT + L.H + 28;
        allSeries.forEach((s, i) => {
            const row = Math.floor(i / L.lc), col = i % L.lc;
            const lx = L.ML + col * colW, ly = legY + row * 20;
            const dash = getSVGDash(s.lineStyle);
            const daAttr = dash ? ` stroke-dasharray="${dash}"` : '';
            o += `<line x1="${lx.toFixed(1)}" y1="${(ly+4.5).toFixed(1)}" x2="${(lx+18).toFixed(1)}" y2="${(ly+4.5).toFixed(1)}"` +
                ` stroke="${s.color}" stroke-width="${Math.max(1, s.lineWidth)}"${daAttr}/>`;
            const labelText = s.unit ? `${s.label} (${s.unit})` : s.label;
            o += `<text x="${(lx+24).toFixed(1)}" y="${(ly+4.5).toFixed(1)}" dominant-baseline="middle"` +
                ` font-family="${ff}" font-size="11" fill="${fg}">${esc(labelText)}</text>`;
        });

        // Watermark
        if (ds.opt.watermark) {
            o += `<text x="${(L.ML+L.W-4).toFixed(1)}" y="${(L.MT+L.H-4).toFixed(1)}"` +
                ` text-anchor="end" dominant-baseline="auto"` +
                ` font-family="${ff}" font-size="9" fill="rgba(0,0,0,0.18)">FDS Viewer</text>`;
        }

        return o + '</svg>';
    }

    // ── Export ─────────────────────────────────────────────────────────────────
    function exportPNG(ds) {
        if (!ds.canvas) return;
        const a = document.createElement('a');
        a.href = ds.canvas.toDataURL('image/png');
        a.download = ds.filename.replace(/\.csv$/i, '') + '.png';
        a.click();
    }

    function exportSVG(ds) {
        const blob = new Blob([buildSVG(ds, 1000, 600)], { type: 'image/svg+xml' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = ds.filename.replace(/\.csv$/i, '') + '.svg'; a.click();
        URL.revokeObjectURL(url);
    }

    function exportPDF(ds) {
        const svg = buildSVG(ds, 1122, 794);
        const win = window.open('', '_blank');
        if (!win) { alert('Please allow pop-ups to export PDF.'); return; }
        win.document.write('<!DOCTYPE html><html><head><style>' +
            '@page{size:A4 landscape;margin:8mm}body{margin:0}svg{width:100%;height:auto;display:block}' +
            '</style></head><body>' + svg + '</body></html>');
        win.document.close(); win.focus();
        setTimeout(() => win.print(), 400);
    }

    // ── Color picker ───────────────────────────────────────────────────────────
    function initColorPicker() {
        const panel = document.getElementById('charts-panel');
        if (!panel || _ccpEl) return;

        const el = document.createElement('div');
        el.id = 'chart-color-picker'; el.className = 'chart-color-picker'; el.style.display = 'none';

        let sw = '<div class="ccp-swatches">';
        for (const c of PALETTE) sw += `<span class="ccp-preset" style="background:${c}" data-color="${c}" title="${c}"></span>`;
        sw += '</div>';

        el.innerHTML = sw +
            '<input type="color" id="ccp-native" class="ccp-native">' +
            '<div class="ccp-hex-row">' +
                '<span class="ccp-hash">#</span>' +
                '<input type="text" id="ccp-hex-input" class="ccp-hex-input" maxlength="6" placeholder="rrggbb">' +
            '</div>';

        panel.appendChild(el);
        _ccpEl = el;

        el.querySelectorAll('.ccp-preset').forEach(s => {
            s.addEventListener('click', e => { e.stopPropagation(); applyColor(s.dataset.color); });
        });
        const ni = el.querySelector('#ccp-native');
        ni.addEventListener('input', () => applyColor(ni.value));
        const hi = el.querySelector('#ccp-hex-input');
        hi.addEventListener('input', () => {
            const v = hi.value.replace(/[^0-9a-fA-F]/g, '');
            if (v.length === 6) applyColor('#' + v);
        });
        document.addEventListener('click', e => {
            if (_ccpEl && _ccpEl.style.display !== 'none' &&
                !_ccpEl.contains(e.target) && !e.target.classList.contains('charts-ch-swatch')) {
                _ccpEl.style.display = 'none'; _activeKey = null;
            }
        });
    }

    function applyColor(color) {
        if (!_activeKey) return;
        colorMap[_activeKey] = color;
        document.querySelectorAll('.charts-ch-swatch[data-key="' + _activeKey + '"]')
            .forEach(sw => { sw.style.background = color; });
        if (_ccpEl && /^#[0-9a-fA-F]{6}$/.test(color)) {
            const ni = _ccpEl.querySelector('#ccp-native');
            const hi = _ccpEl.querySelector('#ccp-hex-input');
            if (ni) ni.value = color;
            if (hi && document.activeElement !== hi) hi.value = color.slice(1);
        }
        scheduleAll();
    }

    function openColorPicker(key, swatchEl) {
        if (!_ccpEl) return;
        _activeKey = key;
        const color = colorMap[key] || '#888888';
        const ni = _ccpEl.querySelector('#ccp-native');
        const hi = _ccpEl.querySelector('#ccp-hex-input');
        if (ni && /^#[0-9a-fA-F]{6}$/.test(color)) ni.value = color;
        if (hi) hi.value = color.replace('#', '');
        _ccpEl.style.display = 'block';
        const pr = document.getElementById('charts-panel').getBoundingClientRect();
        const sr = swatchEl.getBoundingClientRect();
        const pw = _ccpEl.offsetWidth || 184;
        _ccpEl.style.top  = (sr.bottom - pr.top + 4) + 'px';
        _ccpEl.style.left = Math.min(Math.max(4, sr.left - pr.left), pr.width - pw - 8) + 'px';
    }

    // ── Channel list ───────────────────────────────────────────────────────────
    function rebuildChannelList() {
        const box = document.getElementById('charts-channel-list');
        if (!box) return;
        if (datasets.length === 0) {
            box.innerHTML = '<p class="charts-empty-msg">Open a CSV file to see channels.</p>';
            return;
        }
        let html = '';
        for (const ds of datasets) {
            html += '<div class="charts-ds-group">' +
                '<div class="charts-ds-header">' +
                    '<span class="charts-ds-name" title="' + esc(ds.filename) + '">' + esc(ds.filename) + '</span>' +
                    '<button class="charts-ds-remove" data-id="' + esc(ds.id) + '" title="Remove">&#x2715;</button>' +
                '</div>' +
                '<div class="charts-ds-bulk">' +
                    '<button class="charts-bulk-btn" data-id="' + esc(ds.id) + '" data-action="all">All</button>' +
                    '<button class="charts-bulk-btn" data-id="' + esc(ds.id) + '" data-action="none">None</button>' +
                '</div>';
            for (let i = 1; i < ds.headers.length; i++) {
                const key   = ds.id + '::' + i;
                const style = lineStyleMap[key] || 'solid';
                const width = lineWidthMap[key] || 2;
                const selOpts = [
                    ['solid',   '———'],   // ———
                    ['dashed',  '- - -'],
                    ['dotted',  '\xB7\xB7\xB7\xB7\xB7'], // ·····
                    ['dashdot', '-\xB7-\xB7-'],           // -·-·-
                ].map(([v, lbl]) =>
                    '<option value="' + v + '"' + (style === v ? ' selected' : '') + '>' + lbl + '</option>'
                ).join('');
                const widthOpts = [1, 2, 3, 4, 5].map(v =>
                    '<option value="' + v + '"' + (width === v ? ' selected' : '') + '>' + v + '</option>'
                ).join('');
                html += '<div class="charts-ch-item">' +
                    '<input type="checkbox" class="charts-ch-check" data-key="' + key + '" ' + (selectedKeys.has(key) ? 'checked' : '') + '>' +
                    '<span class="charts-ch-swatch" data-key="' + key + '" style="background:' + (colorMap[key] || '#888') + '" title="Click to change colour"></span>' +
                    '<select class="charts-ch-style" data-key="' + key + '">' + selOpts + '</select>' +
                    '<select class="charts-ch-width" data-key="' + key + '" title="Line width">' + widthOpts + '</select>' +
                    '<span class="charts-ch-label">' + esc(ds.headers[i]) + '</span>' +
                    (ds.units[i] ? '<span class="charts-ch-unit">' + esc(ds.units[i]) + '</span>' : '') +
                    '</div>';
            }
            html += '</div>';
        }
        box.innerHTML = html;

        box.querySelectorAll('.charts-ch-check').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) selectedKeys.add(cb.dataset.key); else selectedKeys.delete(cb.dataset.key);
                scheduleAll();
            });
        });
        box.querySelectorAll('.charts-ch-swatch').forEach(sw => {
            sw.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openColorPicker(sw.dataset.key, sw); });
        });
        box.querySelectorAll('.charts-ch-style').forEach(sel => {
            sel.addEventListener('change', () => {
                lineStyleMap[sel.dataset.key] = sel.value;
                scheduleAll();
            });
        });
        box.querySelectorAll('.charts-ch-width').forEach(sel => {
            sel.addEventListener('change', () => {
                lineWidthMap[sel.dataset.key] = parseFloat(sel.value);
                scheduleAll();
            });
        });
        box.querySelectorAll('.charts-ds-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                removeDataset(btn.dataset.id);
                rebuildChannelList();
                if (datasets.length === 0) {
                    const listEl = document.getElementById('charts-cards-list');
                    if (listEl && !listEl.querySelector('.charts-empty-cards-msg')) {
                        const p = document.createElement('p');
                        p.className = 'charts-empty-cards-msg';
                        p.textContent = 'Open a CSV file to plot data.';
                        listEl.appendChild(p);
                    }
                }
            });
        });
        box.querySelectorAll('.charts-bulk-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const ds = datasets.find(d => d.id === btn.dataset.id);
                if (!ds) return;
                const all = btn.dataset.action === 'all';
                for (let i = 1; i < ds.headers.length; i++) {
                    const key = ds.id + '::' + i;
                    if (all) {
                        selectedKeys.add(key);
                        if (!colorMap[key])     { colorMap[key]     = PALETTE[colorCounter % PALETTE.length]; colorCounter++; }
                        if (!lineStyleMap[key]) lineStyleMap[key]   = 'solid';
                        if (!lineWidthMap[key]) lineWidthMap[key]   = 2;
                    } else selectedKeys.delete(key);
                }
                rebuildChannelList();
                scheduleAll();
            });
        });
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Re-render all charts when the app theme changes
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(() => scheduleAll())
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    window.buildChartsPanel = function () {
        if (!_initialized) {
            const fi = document.getElementById('charts-file-input');
            if (fi) fi.addEventListener('change', e => {
                window.chartsPanelHandleFiles(Array.from(e.target.files || []));
                fi.value = '';
            });
            initColorPicker();
            _initialized = true;
        }
        rebuildChannelList();
        requestAnimationFrame(() => scheduleAll());
    };

    window.chartsPanelHandleFiles = function (files) {
        for (const f of files) {
            if (!/\.csv$/i.test(f.name)) continue;
            const reader = new FileReader();
            reader.onload = e => {
                const opts = defaultOpt();
                const ds   = parseCSV(e.target.result, f.name, opts);
                if (ds) { addDataset(ds); rebuildChannelList(); }
            };
            reader.readAsText(f);
        }
    };
})();
