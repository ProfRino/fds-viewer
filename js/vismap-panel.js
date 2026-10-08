/**
 * Vismap panel of the Output page
 *
 * The sidebar of the Vismap mode: it collects what a fdsvismap script sets up
 * — smoke data, evaluation height, safety signs, routes of egress, manual
 * obstructions, time points and options — runs VisMap (vismap.js) on it and
 * shows the results through VisMapOverlay (vismap-overlay.js): the map at a
 * time, aggregated over time or as ASET map, for all signs, one route or one
 * sign, and the coverage of a route.
 *
 * Exposes (on window):
 *   VismapPanel  — wire(), setActive(), onSimulationFolder(),
 *                  onGeometryChanged(), displayTime(); called by output-page.js
 */

(function () {
    'use strict';

    let viewer = null;
    let host = null;            // { getParsedData(), openFolder(files), onTimeChange() } of output-page.js
    let overlay = null;
    let active = false;         // the Vismap mode is shown

    let sim = null;             // VisMapFds of the folder's .smv, null without one
    let folderFiles = new Map();  // slice File by name
    let vis = null;             // VisMap with computed maps; null while there are none for the current input
    let running = null;         // { cancelled } of the computation in progress
    let pick = null;            // what a click into the 3D view does: { kind: 'sign' | 'route', card }
    let playbackTimer = null;
    let keySeq = 0;

    // What the panel cannot compute on is said in the status line, as
    // fdsvismap's ValueError is.
    const InputError = VisMapUtil.ValueError;

    const el = id => document.getElementById(id);
    const format = (value, digits) => String(parseFloat(Number(value).toFixed(digits === undefined ? 2 : digits)));

    function setStatus(msg, isError) {
        const status = el('output-vismap-status');
        if (!status) return;
        status.textContent = msg;
        status.style.color = isError ? 'var(--red-text)' : '';
    }

    function numberOf(id, fallback) {
        const input = el(id);
        const value = input ? parseFloat(input.value) : NaN;
        return Number.isFinite(value) ? value : fallback;
    }

    function evaluationHeight() { return numberOf('output-vismap-height', 2.0); }

    function source() { return (el('output-vismap-source') || {}).value || 'uniform'; }

    // ── Domain ────────────────────────────────────────────────────────────
    // Meshes of the simulation: from the .smv of the folder, else from the .fds.
    function meshes() {
        if (sim && sim.meshes.some(m => m.xb)) return sim.meshes.filter(m => m.xb && m.ijk);
        const data = host && host.getParsedData();
        return data && data.meshes ? data.meshes.filter(m => m.xb && m.ijk) : [];
    }

    /** Footprint of all meshes as [x_min, x_max, y_min, y_max], null without a mesh. */
    function domainBounds() {
        const list = meshes();
        if (!list.length) return null;
        return [
            Math.min(...list.map(m => m.xb[0])), Math.max(...list.map(m => m.xb[1])),
            Math.min(...list.map(m => m.xb[2])), Math.max(...list.map(m => m.xb[3])),
        ];
    }

    function finestCellSize() {
        let size = Infinity;
        for (const m of meshes()) {
            size = Math.min(size, (m.xb[1] - m.xb[0]) / m.ijk[0], (m.xb[3] - m.xb[2]) / m.ijk[1]);
        }
        return Number.isFinite(size) ? size : null;
    }

    // ── Cards of signs, routes and manual obstructions ────────────────────
    // Show the "nothing here yet" hints only while their list is empty.
    function updateHints() {
        for (const [containerId, hintId] of [
            ['output-vismap-signs', 'output-vismap-sign-hint'],
            ['output-vismap-routes', 'output-vismap-route-hint'],
            ['output-vismap-regions', 'output-vismap-region-hint']]) {
            const container = el(containerId), hint = el(hintId);
            if (container && hint) hint.style.display = container.children.length ? 'none' : '';
        }
    }

    /** Card with a header (title + remove button) and a label/input grid,
     *  styled like the rest of the sidebar. `fields` = [{ cls, label, title,
     *  value, text, placeholder, wide }]. */
    function addCard(containerId, title, fields, onChange) {
        const container = el(containerId);
        if (!container) return null;
        const card = document.createElement('div');
        card.className = 'vismap-card';
        card.dataset.key = String(++keySeq);

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
        remove.addEventListener('click', () => {
            if (pick && pick.card === card) endPick();
            card.remove();
            updateHints();
            onChange();
        });
        header.appendChild(remove);
        card.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'vismap-grid';
        for (const field of fields) {
            const label = document.createElement('label');
            label.textContent = field.label;
            label.title = field.title;
            grid.appendChild(label);
            const input = document.createElement('input');
            input.type = field.text ? 'text' : 'number';
            if (!field.text) input.step = 'any';
            input.className = field.cls + (field.wide ? ' vismap-wide' : '');
            input.title = field.title;
            if (field.placeholder) input.placeholder = field.placeholder;
            if (field.text ? field.value !== undefined : Number.isFinite(field.value)) input.value = field.value;
            input.addEventListener('change', onChange);
            grid.appendChild(input);
        }
        card.appendChild(grid);
        container.appendChild(card);
        updateHints();
        return card;
    }

    // Marking is left out where the cards are only read to draw them: a
    // card that is still being filled in is no error yet.
    let marking = true;
    function markInput(card, cls, invalid) {
        const input = card.querySelector('.' + cls);
        if (input && marking) input.classList.toggle('vismap-invalid', !!invalid);
    }

    /** The complete cards as they are, without marking the incomplete ones. */
    function readQuietly() {
        marking = false;
        try {
            const { signs } = readSigns();
            return { signs, routes: readRoutes(signs).routes, regions: readRegions().regions };
        } finally {
            marking = true;
        }
    }

    // An ID that no card of the list uses yet: 1, 2, ... behind the prefix.
    function freeId(selector, prefix) {
        const used = new Set(Array.from(document.querySelectorAll(selector), input => input.value.trim()));
        for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
    }

    // ── Signs ─────────────────────────────────────────────────────────────
    function addSignCard(x, y, c, alpha) {
        const card = addCard('output-vismap-signs', 'Sign', [
            { cls: 'vismap-sg-id', label: 'ID', title: 'Name of the sign, e.g. 1 or NA-NO', value: freeId('.vismap-sg-id', ''), text: true },
            { cls: 'vismap-sg-c', label: 'C', title: 'Contrast factor (Jin): 3 reflecting, 8 light-emitting sign', value: c },
            { cls: 'vismap-sg-x', label: 'X / m', title: 'X coordinate in FDS coordinates', value: x },
            { cls: 'vismap-sg-y', label: 'Y / m', title: 'Y coordinate in FDS coordinates', value: y },
            { cls: 'vismap-sg-a', label: 'α / °', title: 'Viewing direction, clockwise from the positive y-axis (0° faces +Y, 90° faces +X). Empty: visible from all directions', value: alpha, placeholder: 'all' },
        ], onSignsChanged);
        if (card) card.classList.add('vismap-sign-row');
        refreshRouteSigns();
        return card;
    }

    /**
     * Read and validate the sign cards. Every card must be complete and
     * valid — empty required fields are errors and get their inputs marked.
     * Returns { signs: [{ key, id, x, y, c, alpha }], errors }.
     */
    function readSigns() {
        const bounds = domainBounds();
        const signs = [], errors = [], ids = new Set();
        for (const card of document.querySelectorAll('#output-vismap-signs .vismap-sign-row')) {
            const raw = cls => card.querySelector('.' + cls).value.trim();
            const num = cls => parseFloat(raw(cls));
            for (const cls of ['vismap-sg-id', 'vismap-sg-x', 'vismap-sg-y', 'vismap-sg-c', 'vismap-sg-a']) markInput(card, cls, false);
            let bad = false;
            const fail = (cls, message) => { errors.push(message); markInput(card, cls, true); bad = true; };
            const id = raw('vismap-sg-id'), name = 'Sign ' + (id || '?');
            if (!id) fail('vismap-sg-id', 'A sign needs an ID.');
            else if (ids.has(id)) fail('vismap-sg-id', 'The sign ID ' + id + ' is used twice.');
            ids.add(id);
            const x = num('vismap-sg-x'), y = num('vismap-sg-y');
            if (!Number.isFinite(x)) fail('vismap-sg-x', name + ': X is required.');
            else if (bounds && (x < bounds[0] || x > bounds[1])) {
                fail('vismap-sg-x', name + ': X=' + x + ' is outside the domain (' + bounds[0] + '…' + bounds[1] + ').');
            }
            if (!Number.isFinite(y)) fail('vismap-sg-y', name + ': Y is required.');
            else if (bounds && (y < bounds[2] || y > bounds[3])) {
                fail('vismap-sg-y', name + ': Y=' + y + ' is outside the domain (' + bounds[2] + '…' + bounds[3] + ').');
            }
            const c = raw('vismap-sg-c') ? num('vismap-sg-c') : 3;
            if (!Number.isFinite(c) || c <= 0) fail('vismap-sg-c', name + ': contrast factor C must be a positive number (Jin: 3 or 8).');
            // No angle is a sign that is visible from all directions
            const alpha = raw('vismap-sg-a') ? num('vismap-sg-a') : null;
            if (alpha !== null && !Number.isFinite(alpha)) fail('vismap-sg-a', name + ': viewing direction α must be an angle in degrees, or empty.');
            if (!bad) signs.push({ key: card.dataset.key, id, x, y, c, alpha });
        }
        return { signs, errors };
    }

    // An input of the maps has changed: they are dropped, and said so.
    function inputChanged(what, errors) {
        const message = errors.length ? errors[0]
            : vis ? what + ' changed — compute again to update the maps.' : 'Ready to compute.';
        invalidate(message, errors.length > 0);
    }

    function onSignsChanged() {
        refreshRouteSigns();
        inputChanged('Signs', readSigns().errors);
    }

    // ── Routes ────────────────────────────────────────────────────────────
    function addRouteCard() {
        const card = addCard('output-vismap-routes', 'Route', [
            { cls: 'vismap-rt-id', label: 'ID', title: 'Name of the route, e.g. B2', value: freeId('.vismap-rt-id', 'Route '), text: true, wide: true },
        ], onRoutesChanged);
        if (!card) return null;
        card.classList.add('vismap-route-row');

        const label = document.createElement('label');
        label.className = 'vismap-sub-label';
        label.textContent = 'Waypoints (x, y)';
        label.title = 'Waypoints of the route in FDS coordinates, one x, y pair per line, starting point first. ' +
            'A list pasted from a fdsvismap script such as [(1, 9), (4, 7)] is read as well.';
        card.appendChild(label);
        const points = document.createElement('textarea');
        points.className = 'vismap-rt-points';
        points.rows = 4;
        points.spellcheck = false;
        points.placeholder = '1, 9\n4, 7\n7, 5.5';
        points.title = label.title;
        points.addEventListener('change', onRoutesChanged);
        card.appendChild(points);

        const pickBtn = document.createElement('button');
        pickBtn.type = 'button';
        pickBtn.className = 'file-button vismap-rt-pick';
        pickBtn.textContent = '+ Waypoints by click';
        pickBtn.title = 'Add waypoints by clicking positions in the 3D view, one after the other';
        pickBtn.addEventListener('click', () => {
            if (pick && pick.card === card) { endPick(); return; }
            startPick({ kind: 'route', card, button: pickBtn },
                'Click the waypoints of the route in the 3D view, one after the other. Esc or the button ends it.');
        });
        card.appendChild(pickBtn);

        // The signs that guide along the route: all of them, or a choice
        const allRow = document.createElement('label');
        allRow.className = 'checkbox-row';
        allRow.title = 'A route does not have to pass its signs, it is enough to see them';
        const all = document.createElement('input');
        all.type = 'checkbox';
        all.className = 'vismap-rt-all';
        all.checked = true;
        const allText = document.createElement('span');
        allText.textContent = 'All signs guide along it';
        allRow.append(all, allText);
        card.appendChild(allRow);
        const choice = document.createElement('div');
        choice.className = 'vismap-rt-signs';
        choice.style.display = 'none';
        card.appendChild(choice);
        card._signKeys = null;  // keys of the chosen sign cards
        all.addEventListener('change', () => {
            // Start the choice from all signs, so that it is narrowed down
            if (!all.checked && !card._signKeys) {
                card._signKeys = new Set(Array.from(document.querySelectorAll('#output-vismap-signs .vismap-sign-row'), s => s.dataset.key));
            }
            refreshRouteSigns();
            onRoutesChanged();
        });
        return card;
    }

    // Rebuild the sign choice of every route from the sign cards.
    function refreshRouteSigns() {
        const signCards = Array.from(document.querySelectorAll('#output-vismap-signs .vismap-sign-row'));
        for (const card of document.querySelectorAll('#output-vismap-routes .vismap-route-row')) {
            const choice = card.querySelector('.vismap-rt-signs');
            const all = card.querySelector('.vismap-rt-all').checked;
            choice.style.display = all ? 'none' : '';
            choice.textContent = '';
            if (all) continue;
            if (!signCards.length) choice.textContent = 'No signs yet.';
            for (const signCard of signCards) {
                const row = document.createElement('label');
                row.className = 'checkbox-row';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = card._signKeys.has(signCard.dataset.key);
                box.addEventListener('change', () => {
                    if (box.checked) card._signKeys.add(signCard.dataset.key);
                    else card._signKeys.delete(signCard.dataset.key);
                    onRoutesChanged();
                });
                const text = document.createElement('span');
                text.textContent = 'Sign ' + (signCard.querySelector('.vismap-sg-id').value.trim() || '?');
                row.append(box, text);
                choice.appendChild(row);
            }
        }
    }

    /** Numbers of a waypoint list in any notation: "1, 9" per line as well
     *  as "[(1, 9), (4, 7)]" from a Python script. */
    function parseWaypoints(text) {
        const numbers = (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
        if (numbers.length % 2) return null;
        const pairs = [];
        for (let k = 0; k < numbers.length; k += 2) pairs.push([numbers[k], numbers[k + 1]]);
        return pairs;
    }

    /**
     * Read and validate the route cards.
     * Returns { routes: [{ id, waypoints, signs }], errors }; signs holds
     * the IDs of the chosen signs, or null for all signs.
     */
    function readRoutes(signs) {
        const bounds = domainBounds();
        const routes = [], errors = [], ids = new Set();
        for (const card of document.querySelectorAll('#output-vismap-routes .vismap-route-row')) {
            for (const cls of ['vismap-rt-id', 'vismap-rt-points']) markInput(card, cls, false);
            let bad = false;
            const fail = (cls, message) => { errors.push(message); markInput(card, cls, true); bad = true; };
            const id = card.querySelector('.vismap-rt-id').value.trim(), name = 'Route ' + (id || '?');
            if (!id) fail('vismap-rt-id', 'A route needs an ID.');
            else if (ids.has(id)) fail('vismap-rt-id', 'The route ID ' + id + ' is used twice.');
            ids.add(id);
            const waypoints = parseWaypoints(card.querySelector('.vismap-rt-points').value);
            if (!waypoints) fail('vismap-rt-points', name + ': the waypoints have to be x, y pairs.');
            else if (waypoints.length < 2) fail('vismap-rt-points', name + ': a route needs at least two waypoints.');
            else if (bounds && waypoints.some(p => p[0] < bounds[0] || p[0] > bounds[1] || p[1] < bounds[2] || p[1] > bounds[3])) {
                fail('vismap-rt-points', name + ': a waypoint is outside the domain (X ' + bounds[0] + '…' + bounds[1] +
                    ', Y ' + bounds[2] + '…' + bounds[3] + ').');
            }
            const chosen = card.querySelector('.vismap-rt-all').checked ? null
                : signs.filter(s => card._signKeys.has(s.key)).map(s => s.id);
            if (!bad) routes.push({ id, waypoints, signs: chosen });
        }
        return { routes, errors };
    }

    // A route is no input of the maps: it is handed to the computed VisMap
    // as it is, and only its coverage is evaluated again.
    function onRoutesChanged() {
        const { routes } = readRoutes(readSigns().signs);
        if (vis) {
            const known = routes.filter(r => !r.signs || r.signs.every(id => vis.allSignDict.has(id)));
            vis.allRouteDict.clear();
            for (const route of known) vis.addRoute(route.id, route.waypoints, route.signs || undefined);
            refreshScopes();
        }
        showInputState();
        render();
    }

    // The first thing that keeps the cards from being computed, or that
    // they are ready for it.
    function showInputState() {
        const signs = readSigns();
        const errors = signs.errors.concat(readRoutes(signs.signs).errors, readRegions().errors);
        if (errors.length) setStatus(errors[0], true);
        else if (!vis) setStatus('Ready to compute.');
    }

    // ── Manual visual obstruction / hole regions ──────────────────────────
    function addRegionCard(type) {
        const title = type === 'hole' ? 'Hole' : 'Obstruction';
        const card = addCard('output-vismap-regions', title, [
            { cls: 'vismap-rg-x1', label: 'X1 / m', title: 'Lower X corner', value: null },
            { cls: 'vismap-rg-x2', label: 'X2 / m', title: 'Upper X corner', value: null },
            { cls: 'vismap-rg-y1', label: 'Y1 / m', title: 'Lower Y corner', value: null },
            { cls: 'vismap-rg-y2', label: 'Y2 / m', title: 'Upper Y corner', value: null },
        ], onRegionsChanged);
        if (!card) return null;
        card.classList.add('vismap-region-row');
        card.dataset.regionType = type;
        return card;
    }

    /** Read and validate the region cards — every card must be complete, with
     *  a non-zero extent. Coordinates are normalized so x1<x2, y1<y2. They
     *  apply in the order of the cards: a hole after an obstruction opens it.
     *  Returns { regions, errors }. */
    function readRegions() {
        const regions = [], errors = [];
        for (const card of document.querySelectorAll('#output-vismap-regions .vismap-region-row')) {
            const type = card.dataset.regionType === 'hole' ? 'hole' : 'obstruction';
            const name = type === 'hole' ? 'Hole' : 'Obstruction';
            const values = ['vismap-rg-x1', 'vismap-rg-x2', 'vismap-rg-y1', 'vismap-rg-y2']
                .map(cls => ({ cls, v: parseFloat(card.querySelector('.' + cls).value) }));
            let bad = false;
            for (const { cls, v } of values) {
                markInput(card, cls, !Number.isFinite(v));
                if (!Number.isFinite(v)) bad = true;
            }
            if (bad) {
                errors.push(name + ': all four coordinates (X1, X2, Y1, Y2) are required.');
                continue;
            }
            const [x1, x2, y1, y2] = values.map(o => o.v);
            const region = { type, x1: Math.min(x1, x2), x2: Math.max(x1, x2), y1: Math.min(y1, y2), y2: Math.max(y1, y2) };
            if (region.x1 === region.x2 || region.y1 === region.y2) {
                errors.push(name + ': the rectangle has zero extent.');
                continue;
            }
            regions.push(region);
        }
        return { regions, errors };
    }

    function onRegionsChanged() {
        inputChanged('Visual obstructions', readRegions().errors);
    }

    // ── Smoke data ────────────────────────────────────────────────────────
    function setRowVisible(id, visible) {
        const input = el(id), label = document.querySelector('label[for="' + id + '"]');
        if (input) input.style.display = visible ? '' : 'none';
        if (label) label.style.display = visible ? '' : 'none';
    }

    // The sources a folder offers: the slice nearest to the height, each
    // horizontal slice by itself, or no smoke data at all.
    function refreshSources() {
        const select = el('output-vismap-source');
        if (!select) return;
        select.textContent = '';
        const add = (value, text) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        };
        const horizontal = sim ? sim.slices.filter(slc => slc.orientation === 3) : [];
        if (horizontal.length) add('auto', 'Slice nearest to the height');
        for (const slc of horizontal) add('slice:' + slc.index, VisMapFds.describeSlice(slc));
        add('uniform', 'Uniform extinction (no smoke data)');

        const quantity = el('output-vismap-quantity');
        const has = name => horizontal.some(slc => slc.quantity.toUpperCase() === name);
        if (quantity && !has('SOOT EXTINCTION COEFFICIENT') && has('SOOT OPTICAL DENSITY')) quantity.value = 'OD_C';
        select.value = has('SOOT EXTINCTION COEFFICIENT') || has('SOOT OPTICAL DENSITY') ? 'auto' : 'uniform';
        onSourceChanged();
    }

    /** The slice the current settings select, as VisMap.selectSlice. Throws
     *  what fdsvismap raises when there is none. */
    function selectedSlice() {
        const options = { fdsSlcHeight: evaluationHeight() };
        const choice = source();
        if (choice.startsWith('slice:')) options.fdsSlcIndex = Number(choice.slice(6));
        return { slc: VisMap.selectSlice(sim, el('output-vismap-quantity').value, options), options };
    }

    function onSourceChanged() {
        const uniform = source() === 'uniform';
        setRowVisible('output-vismap-quantity', !uniform);
        setRowVisible('output-vismap-extco', uniform);
        setRowVisible('output-vismap-cellsize', uniform);
        const times = el('output-vismap-times-section');
        if (times) times.style.display = uniform ? 'none' : '';
        const cell = el('output-vismap-cellsize');
        if (cell && !cell.value && finestCellSize()) cell.value = format(finestCellSize(), 4);

        if (uniform) {
            invalidate(domainBounds()
                ? 'Clear air or uniform smoke on the geometry of the model. Add signs, then compute.'
                : 'Load an FDS file or open a simulation folder first.');
            return;
        }
        try {
            const { slc } = selectedSlice();
            invalidate('Smoke data: ' + VisMapFds.describeSlice(slc) + '. Add signs, then compute.');
            fillTimeDefaults(slc);
        } catch (e) {
            invalidate(e.message.split('\n')[0] + ' Pick a slice under Smoke data.', true);
        }
    }

    // Parsed slice file of the folder, read once.
    async function sliceFile(name) {
        if (!sim.sliceFiles.has(name)) {
            const file = folderFiles.get(name);
            if (!file) throw new InputError('The slice file ' + name + ' is missing in the folder.');
            sim.addSliceFile(name, FdsSliceReader.parse(await file.arrayBuffer()));
        }
        return sim.sliceFiles.get(name);
    }

    // Prefill the Times inputs from the selected slice data: the full time
    // range of the simulation output and the finest step the data provides.
    // The user can still narrow the range or coarsen the step afterwards.
    async function fillTimeDefaults(slc) {
        try {
            const used = sim;
            const times = (await sliceFile(sim.filesOf(slc)[0])).frames.map(f => f.time);
            if (sim !== used || times.length === 0) return;
            let minStep = Infinity;
            for (let i = 1; i < times.length; i++) {
                const d = times[i] - times[i - 1];
                if (d > 1e-9 && d < minStep) minStep = d;
            }
            const round = v => Math.round(v * 1000) / 1000;
            el('output-vismap-t0').value = round(times[0]);
            el('output-vismap-t1').value = round(times[times.length - 1]);
            el('output-vismap-dt').value = Number.isFinite(minStep) ? round(minStep) : 1;
        } catch (e) {
            console.warn('Could not read slice times for the vismap time defaults.', e);
        }
    }

    // ── Computation ───────────────────────────────────────────────────────
    // Drop the maps, because their input has changed.
    function invalidate(message, isError) {
        if (running) running.cancelled = true;
        stopPlayback();
        vis = null;
        if (message) setStatus(message, isError);
        refreshScopes();
        render();
    }

    /** Grid over the footprint of the meshes for a scene without smoke data. */
    function uniformGrid(bounds) {
        const size = numberOf('output-vismap-cellsize', finestCellSize());
        if (!(size > 0)) throw new InputError('The cell size has to be a positive number.');
        const axis = (min, max) => {
            const count = Math.max(Math.round((max - min) / size), 2);
            const step = (max - min) / count;
            return Array.from({ length: count }, (_, i) => min + (i + 0.5) * step);
        };
        const x = axis(bounds[0], bounds[1]), y = axis(bounds[2], bounds[3]);
        if (x.length * y.length > 4e6) throw new InputError('A cell size of ' + size + ' m gives more than 4 million cells.');
        return { x, y };
    }

    // Set up a VisMap from the panel, as a fdsvismap script does.
    async function buildVisMap(input) {
        const map = new VisMap();
        const height = evaluationHeight();
        if (source() === 'uniform') {
            const bounds = domainBounds();
            if (!bounds) throw new InputError('Load an FDS file or open a simulation folder first.');
            const extco = numberOf('output-vismap-extco', 0);
            if (!(extco >= 0)) throw new InputError('The extinction coefficient K has to be 0 or higher.');
            const grid = uniformGrid(bounds);
            // The obstructions FDS wrote to the .smv; without a simulation
            // those of the input file, with its holes cut out at the height
            const data = host.getParsedData();
            map.obstructionsCollection = sim ? sim.obstructions : ((data && data.obsts) || []).filter(o => o.xb);
            map.setGrid(grid.x, grid.y, height);
            if (!sim && data) {
                for (const hole of data.holes || []) {
                    if (hole.xb && hole.xb[4] <= height && height <= hole.xb[5]) map.addVisualHole(...hole.xb.slice(0, 4));
                }
            }
            map.setUniformExtco(extco, [0]);
        } else {
            map.quantity = el('output-vismap-quantity').value;
            const { slc, options } = selectedSlice();
            setStatus('Loading slice data...');
            for (const name of sim.filesOf(slc)) await sliceFile(name);
            map.readFdsData(sim, options);
            const t0 = numberOf('output-vismap-t0', 0);
            const t1 = numberOf('output-vismap-t1', map.fdsTimePoints[map.fdsTimePoints.length - 1]);
            const dt = numberOf('output-vismap-dt', Math.max((t1 - t0) / 10, 1e-6));
            if (!(dt > 0)) throw new InputError('The time step has to be positive.');
            if (t1 < t0) throw new InputError('The end time lies before the start time.');
            if ((t1 - t0) / dt > 2000) throw new InputError('More than 2000 time points — raise Step or narrow the time range.');
            const times = [];
            for (let k = 0; t0 + k * dt <= t1 + 1e-9; k++) times.push(t0 + k * dt);
            map.setTimePoints(times);
        }
        for (const r of input.regions) {
            if (r.type === 'hole') map.addVisualHole(r.x1, r.x2, r.y1, r.y2);
            else map.addVisualObstruction(r.x1, r.x2, r.y1, r.y2);
        }
        for (const s of input.signs) map.addSign(s.id, s.x, s.y, s.c, s.alpha);
        for (const r of input.routes) map.addRoute(r.id, r.waypoints, r.signs || undefined);
        map.setVisibilityBounds(numberOf('output-vismap-minvis', 0), numberOf('output-vismap-maxvis', 30));
        return map;
    }

    function setComputing(on) {
        const button = el('output-vismap-compute');
        if (!button) return;
        button.textContent = on ? 'Cancel' : 'Compute visibility maps';
        button.classList.toggle('primary-file-button', !on);
    }

    async function compute() {
        if (running) { running.cancelled = true; return; }
        endPick();
        invalidate();  // the maps of the previous computation go when a new one starts
        const job = running = { cancelled: false };
        try {
            const signs = readSigns(), routes = readRoutes(signs.signs), regions = readRegions();
            const errors = signs.errors.concat(routes.errors, regions.errors);
            if (errors.length) throw new InputError(errors.join(' '));
            if (signs.signs.length === 0) throw new InputError('Add at least one sign (X and Y required).');
            if (source() !== 'uniform' && !sim) throw new InputError('Open a simulation folder with slice data first.');

            setComputing(true);
            const map = await buildVisMap({ signs: signs.signs, routes: routes.routes, regions: regions.regions });
            if (job.cancelled) return;
            // One bit per sign, cell and time point is kept: one to four bytes per cell and time point
            const [cellsX, cellsY] = map.fdsGridShape, count = signs.signs.length;
            const bytes = map.vismapTimePoints.length * cellsX * cellsY * (count <= 8 ? 1 : count <= 16 ? 2 : 4 * Math.ceil(count / 32));
            if (bytes > 1.5e9) {
                throw new InputError(map.vismapTimePoints.length + ' time points on ' + cellsX + ' × ' + cellsY + ' cells need about ' +
                    format(bytes / 1e9, 1) + ' GB of memory — raise Step or narrow the time range.');
            }
            const checked = id => !!(el(id) || {}).checked;
            const finished = await map.computeAllAsync({
                obstructions: checked('output-vismap-obstructions'),
                viewAngle: checked('output-vismap-viewangle'),
                aa: checked('output-vismap-aa'),
                cancelled: () => job.cancelled,
                progress: step => setStatus(step.phase === 'signs'
                    ? 'Preparing sign ' + step.done + ' / ' + step.total + '…'
                    : 'Computing… ' + Math.round(100 * step.done / step.total) + ' % (' + format(step.time, 1) + ' s)'),
            });
            if (!finished || job.cancelled) {
                if (running === job) setStatus('Computation cancelled.');
                return;
            }
            vis = map;
            const times = vis.vismapTimePoints.length;
            const slider = el('output-vismap-time-slider');
            if (slider) { slider.min = 0; slider.max = times - 1; slider.value = times - 1; }
            refreshScopes(true);
            // A sign on the face of a wall may come to lie in the cell of the wall
            const walled = signs.signs.filter(sign => vis.obstructionsArray[
                VisMapUtil.closestIndex(vis.allXCoords, sign.x) + cellsX * VisMapUtil.closestIndex(vis.allYCoords, sign.y)]);
            setStatus('Computed ' + times + ' time point' + (times === 1 ? '' : 's') + ' for ' + count +
                ' sign' + (count === 1 ? '' : 's') + ' on ' + cellsX + ' × ' + cellsY + ' cells' +
                (vis.slc ? ' of ' + VisMapFds.describeSlice(vis.slc) : '') + '.' +
                (walled.length ? ' Sign ' + walled.map(sign => sign.id).join(', ') + ' lies in an obstructed cell and is seen from nowhere — move it off the obstruction.' : ''),
                walled.length > 0);
            render();
        } catch (e) {
            if (!(e instanceof InputError || e instanceof VisMapUtil.StateError)) console.error(e);
            if (running === job) setStatus(e.message.split('\n')[0], true);
        } finally {
            if (running === job) {
                running = null;
                setComputing(false);
            }
        }
    }

    // ── Results ───────────────────────────────────────────────────────────
    // Entries of the "Signs" select: all signs, each route, each sign.
    function refreshScopes(preferRoute) {
        const select = el('output-vismap-scope'), mapSel = el('output-vismap-mapmode');
        if (!select) return;
        const previous = select.value;
        select.textContent = '';
        const add = (value, text) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        };
        add('all', 'All signs');
        if (vis) {
            for (const id of vis.allRouteDict.keys()) add('route:' + id, 'Route ' + id);
            for (const id of vis.allSignDict.keys()) add('sign:' + id, 'Sign ' + id);
        }
        const routes = vis ? Array.from(vis.allRouteDict.keys()) : [];
        if (preferRoute && routes.length === 1) select.value = 'route:' + routes[0];
        else if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
        select.disabled = !vis;
        if (mapSel) mapSel.disabled = !vis;
    }

    function currentScope() {
        const value = (el('output-vismap-scope') || {}).value || 'all';
        if (vis && value.startsWith('route:') && vis.allRouteDict.has(value.slice(6))) return { route: value.slice(6) };
        if (vis && value.startsWith('sign:') && vis.allSignDict.has(value.slice(5))) return { sign: value.slice(5) };
        return {};
    }

    function selectedTime() {
        const times = vis.vismapTimePoints, slider = el('output-vismap-time-slider');
        const index = Math.min(slider ? (parseInt(slider.value, 10) || 0) : times.length - 1, times.length - 1);
        return times[index];
    }

    // Draw the current state: before a computation the signs and routes as
    // they are entered (fdsvismap's plot_routes), afterwards the chosen map.
    function render() {
        if (!viewer) return;
        if (!overlay) overlay = new VisMapOverlay(viewer.scene);
        overlay.setVisible(active);
        overlay.setSignsUpright(!!viewer.walkMode);
        const height = vis ? vis.fdsSlcHeight : evaluationHeight();
        const bounds = vis ? vis.getDomainExtent() : domainBounds();
        if (bounds) overlay.setMarkerSize(bounds);
        const input = readQuietly();
        overlay.setRegions(input.regions, height);

        const slider = el('output-vismap-time-slider'), playBtn = el('output-vismap-play'), readout = el('output-vismap-time-readout');
        if (!vis) {
            overlay.clearMap();
            overlay.setSigns(input.signs, height);
            overlay.setRoutes(input.routes, height);
            if (slider) slider.disabled = true;
            if (playBtn) playBtn.disabled = true;
            if (readout) readout.textContent = '-- s';
            showLegend(null);
            showSummary('');
            showColorbar(null);
            return;
        }

        const scope = currentScope();
        // A single sign has a map at a time only, as in fdsvismap
        const mapSel = el('output-vismap-mapmode');
        for (const option of mapSel.options) {
            if (option.value === 'agg' || option.value === 'aset') option.disabled = scope.sign !== undefined;
        }
        if (mapSel.selectedOptions[0].disabled) mapSel.value = 'time';
        const mapMode = mapSel.value;
        const times = vis.vismapTimePoints, time = selectedTime();
        if (slider) slider.disabled = mapMode === 'none' || times.length <= 1;
        if (playBtn) playBtn.disabled = times.length <= 1;

        const map = { extent: vis.getDomainExtent(), shape: vis.fdsGridShape, height };
        if ((el('output-vismap-show-obst') || {}).checked) map.obstructions = vis.obstructionsArray;
        let coverage = null, when = '';
        if (mapMode === 'time') {
            map.vismap = scope.sign !== undefined ? vis.getSignVismap(scope.sign, time) : vis.getAggVismap(time, scope.route);
            coverage = map.vismap;
            if (readout) readout.textContent = format(time, 1) + ' s';
            when = ' at ' + format(time, 1) + ' s';
        } else if (mapMode === 'agg') {
            map.vismap = vis.getTimeAggVismap(time, scope.route);
            coverage = map.vismap;
            if (readout) readout.textContent = time === times[times.length - 1] ? 'all times' : 'up to ' + format(time, 1) + ' s';
            when = ' at all times up to ' + format(time, 1) + ' s';
        } else if (mapMode === 'aset') {
            map.aset = vis.getAsetMap(time, scope.route);
            map.maxTime = time;
            // Cells without a sign at any time point have no ASET to show
            map.neverVisible = new Uint8Array(map.aset.length).fill(1);
            for (const t of times) {
                if (t > time) break;
                const seen = vis.getAggVismap(t, scope.route);
                for (let idx = 0; idx < seen.length; idx++) if (seen[idx]) map.neverVisible[idx] = 0;
            }
            if (readout) readout.textContent = 'up to ' + format(time, 1) + ' s';
            if (times.length <= 1) {
                setStatus('The ASET map needs several time points to show when visibility is lost — extend End or reduce Step, then compute again.', true);
            }
        } else if (readout) {
            readout.textContent = '-- s';
        }
        overlay.showMap(map);

        // The signs and routes of the scope: a route with its coverage on a
        // vismap, dashed otherwise; all routes dashed beside all signs
        const signIds = scope.sign !== undefined ? [scope.sign]
            : scope.route !== undefined ? vis.allRouteDict.get(scope.route).signs : Array.from(vis.allSignDict.keys());
        overlay.setSigns(signIds.map(id => Object.assign({ id }, vis.allSignDict.get(id))), height);
        const routeIds = scope.route !== undefined ? [scope.route] : scope.sign !== undefined ? [] : Array.from(vis.allRouteDict.keys());
        let covered = null;
        overlay.setRoutes(routeIds.map(id => {
            const route = { id, waypoints: vis.allRouteDict.get(id).waypoints };
            if (scope.route !== undefined && coverage) {
                route.points = vis.getRoutePoints(id);
                route.coverage = covered = vis.coverageFromVismap(id, coverage);
            }
            return route;
        }), height);

        if (scope.route === undefined) showSummary('');
        else if (mapMode === 'aset') {
            const aset = vis.getRouteAset(scope.route, time);
            const first = aset.reduce((a, b) => Math.min(a, b)), last = aset.reduce((a, b) => Math.max(a, b));
            showSummary('Route ' + scope.route + ': the first section loses its sign after ' + format(first, 1) +
                ' s, the last one ' + (last >= time ? 'keeps it up to ' : 'after ') + format(last, 1) + ' s.');
        } else if (covered) {
            // A section is covered if a sign is visible from both of its ends
            let sections = 0;
            for (let k = 0; k + 1 < covered.length; k++) if (covered[k] && covered[k + 1]) sections++;
            const share = covered.length > 1 ? 100 * sections / (covered.length - 1) : 0;
            showSummary('Route ' + scope.route + ': a sign is visible from ' + format(share, 1) + ' % of its ' +
                format(vis.allRouteDict.get(scope.route).length, 1) + ' m' + when + '.');
        } else showSummary('');
        showLegend({ mapMode, scope, signIds, coverage: !!covered });
        showColorbar(mapMode === 'aset' ? time : null);
    }

    function showSummary(text) {
        const summary = el('output-vismap-summary');
        if (!summary) return;
        summary.textContent = text;
        summary.style.display = text ? '' : 'none';
    }

    // The colors of the map and the signs with their parameters, as the
    // legend beside a fdsvismap plot.
    function showLegend(state) {
        const legend = el('output-vismap-legend');
        if (!legend) return;
        legend.textContent = '';
        if (!state) return;
        const style = vis.style;
        const row = (color, text, kind) => {
            const item = document.createElement('div');
            item.className = 'vismap-legend-row';
            const swatch = document.createElement('span');
            swatch.className = 'vismap-swatch' + (kind ? ' vismap-swatch-' + kind : '');
            swatch.style.background = color;
            const label = document.createElement('span');
            label.textContent = text;
            item.append(swatch, label);
            legend.appendChild(item);
        };
        const title = document.createElement('div');
        title.className = 'vismap-legend-title';
        title.textContent = state.scope.route !== undefined ? 'Route: ' + state.scope.route : 'Signs';
        legend.appendChild(title);
        if (state.mapMode === 'time' || state.mapMode === 'agg') {
            row(style.notVisible, 'not visible');
            row(style.visible, 'visible');
        } else if (state.mapMode === 'aset') {
            row(style.neverVisible, 'no sign visible at any time');
        }
        if ((el('output-vismap-show-obst') || {}).checked) row(style.obstruction, 'obstructed cell');
        if (state.coverage) {
            row(style.routeCovered, 'route, a sign is visible', 'line');
            row(style.routeUncovered, 'route, no sign is visible', 'line');
        }
        for (const id of state.signIds) {
            const sign = vis.allSignDict.get(id);
            const routes = state.scope.route !== undefined ? []
                : Array.from(vis.allRouteDict.entries()).filter(([, route]) => route.signs.includes(id)).map(([routeId]) => routeId);
            const item = document.createElement('div');
            item.className = 'vismap-legend-row';
            const badge = document.createElement('span');
            badge.className = 'vismap-sign-badge';
            badge.style.color = badge.style.borderColor = style.sign;
            badge.textContent = id;
            const label = document.createElement('span');
            label.textContent = 'C = ' + sign.c + (sign.alpha !== null ? ', α = ' + sign.alpha + '°' : '') +
                (routes.length ? ' (' + routes.join(', ') + ')' : '');
            item.append(badge, label);
            legend.appendChild(item);
        }
    }

    // The shared colorbar shows the time scale of the ASET map; the boolean
    // maps carry their meaning in the legend, so the bar hides there.
    function showColorbar(maxTime) {
        if (!active) return;
        const bar = el('output-colorbar');
        if (!bar) return;
        if (maxTime === null) { bar.style.display = 'none'; return; }
        bar.style.display = '';
        el('output-colorbar-label').textContent = 'ASET (s)';
        el('output-colorbar-max').textContent = format(maxTime, 1);
        el('output-colorbar-min').textContent = '0';
        const canvas = el('output-colorbar-canvas');
        const ctx = canvas.getContext('2d');
        for (let y = 0; y < canvas.height; y++) {
            const c = VisMapUtil.viridis(1 - y / (canvas.height - 1));
            ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
            ctx.fillRect(0, y, canvas.width, 1);
        }
    }

    // ── Time playback (mirrors the slice Play button) ─────────────────────
    function setPlayIcon(playing) {
        const label = el('output-vismap-play-label');
        if (label) label.textContent = playing ? 'Pause' : 'Play';
    }

    function stopPlayback() {
        if (!playbackTimer) return;
        clearInterval(playbackTimer);
        playbackTimer = null;
        setPlayIcon(false);
    }

    function startPlayback() {
        if (!vis || vis.vismapTimePoints.length <= 1) return;
        // Playing steps through time points, which only the per-time map shows.
        const mapSel = el('output-vismap-mapmode');
        if (mapSel && mapSel.value !== 'time') mapSel.value = 'time';
        setPlayIcon(true);
        playbackTimer = setInterval(() => {
            const slider = el('output-vismap-time-slider');
            if (!slider || !vis) { stopPlayback(); return; }
            slider.value = ((parseInt(slider.value, 10) || 0) + 1) % vis.vismapTimePoints.length;
            render();
            host.onTimeChange();
        }, 250);
    }

    // ── Clicks into the 3D view ───────────────────────────────────────────
    function startPick(next, message) {
        endPick();
        pick = next;
        if (pick.button) pick.button.classList.add('active');
        setStatus(message);
    }

    function endPick() {
        if (pick && pick.button) pick.button.classList.remove('active');
        pick = null;
    }

    // Position of a click on the plane at the evaluation height, in FDS
    // coordinates rounded to the centimetre (scene Y = FDS Z, scene Z = FDS -Y).
    function planePoint(event) {
        const rect = viewer.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, viewer.camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(vis ? vis.fdsSlcHeight : evaluationHeight()));
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(plane, hit)) return null;
        return [Math.round(hit.x * 100) / 100, Math.round(-hit.z * 100) / 100];
    }

    function onPick(point) {
        const [x, y] = point;
        const bounds = domainBounds();
        if (bounds && (x < bounds[0] || x > bounds[1] || y < bounds[2] || y > bounds[3])) {
            setStatus('X=' + format(x) + ', Y=' + format(y) + ' lies outside the domain — click a position inside it.', true);
            return;
        }
        if (pick.kind === 'sign') {
            const { errors } = readSigns();
            if (errors.length) {
                setStatus('Complete the marked sign first: ' + errors[0], true);
            } else {
                addSignCard(x, y, 3, 0);
                onSignsChanged();
                setStatus('Sign placed at X=' + format(x) + ', Y=' + format(y) + '. Set its viewing direction α.');
            }
            endPick();
        } else if (pick.kind === 'route') {
            const points = pick.card.querySelector('.vismap-rt-points');
            points.value = (points.value.trim() ? points.value.trim() + '\n' : '') + format(x) + ', ' + format(y);
            onRoutesChanged();
            setStatus('Waypoint added at X=' + format(x) + ', Y=' + format(y) + '. Click the next one, Esc ends.');
        }
    }

    // ── Wiring ────────────────────────────────────────────────────────────
    function wire(outputViewer, outputHost) {
        viewer = outputViewer;
        host = outputHost;

        const folder = el('output-vismap-folder');
        if (folder) folder.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length) host.openFolder(files);
        });

        const sourceSel = el('output-vismap-source');
        if (sourceSel) sourceSel.addEventListener('change', () => {
            // A slice chosen by itself is taken for what its name says, unless
            // the quantity is set otherwise afterwards
            const slc = sim && sourceSel.value.startsWith('slice:') ? sim.slices[Number(sourceSel.value.slice(6))] : null;
            if (slc && /OPTICAL DENSITY/i.test(slc.quantity)) el('output-vismap-quantity').value = 'OD_C';
            else if (slc && /EXTINCTION/i.test(slc.quantity)) el('output-vismap-quantity').value = 'ext_coef_C';
            onSourceChanged();
        });
        for (const id of ['output-vismap-quantity', 'output-vismap-height']) {
            if (el(id)) el(id).addEventListener('change', onSourceChanged);
        }
        // Everything else that enters the maps discards them when it changes
        for (const id of ['output-vismap-extco', 'output-vismap-cellsize', 'output-vismap-t0', 'output-vismap-t1',
            'output-vismap-dt', 'output-vismap-minvis', 'output-vismap-maxvis', 'output-vismap-obstructions',
            'output-vismap-viewangle', 'output-vismap-aa']) {
            if (el(id)) el(id).addEventListener('change', () => { if (vis) invalidate('Settings changed — compute again to update the maps.'); });
        }

        // Creating a new entry first validates the existing ones — no piling
        // up of incomplete cards.
        const addSign = el('output-vismap-add-sign');
        if (addSign) addSign.addEventListener('click', () => {
            const { errors } = readSigns();
            if (errors.length) { setStatus('Complete the marked sign first: ' + errors[0], true); return; }
            addSignCard(null, null, 3, 0);
            setStatus('Fill in the new sign (X and Y required, C default 3, α empty for all directions).');
        });
        const pickSign = el('output-vismap-pick-sign');
        if (pickSign) pickSign.addEventListener('click', () => {
            if (pick && pick.kind === 'sign') { endPick(); return; }
            startPick({ kind: 'sign', button: pickSign }, 'Click a position in the 3D view to place the sign.');
        });
        const addRoute = el('output-vismap-add-route');
        if (addRoute) addRoute.addEventListener('click', () => {
            const { errors } = readRoutes(readSigns().signs);
            if (errors.length) { setStatus('Complete the marked route first: ' + errors[0], true); return; }
            addRouteCard();
            setStatus('Enter the waypoints of the new route, or click them in the 3D view.');
        });
        const addRegion = (type) => {
            const { errors } = readRegions();
            if (errors.length) { setStatus('Complete the marked region first: ' + errors[0], true); return; }
            addRegionCard(type);
            setStatus('Fill in all four corners of the new ' + type + '.');
        };
        if (el('output-vismap-add-obst')) el('output-vismap-add-obst').addEventListener('click', () => addRegion('obstruction'));
        if (el('output-vismap-add-hole')) el('output-vismap-add-hole').addEventListener('click', () => addRegion('hole'));

        if (el('output-vismap-compute')) el('output-vismap-compute').addEventListener('click', compute);

        const mapSel = el('output-vismap-mapmode');
        if (mapSel) mapSel.addEventListener('change', () => {
            if (mapSel.value !== 'time') stopPlayback();
            render();
            host.onTimeChange();
        });
        if (el('output-vismap-scope')) el('output-vismap-scope').addEventListener('change', render);
        if (el('output-vismap-show-obst')) el('output-vismap-show-obst').addEventListener('change', render);
        const slider = el('output-vismap-time-slider');
        if (slider) slider.addEventListener('input', () => { render(); host.onTimeChange(); });
        const playBtn = el('output-vismap-play');
        if (playBtn) playBtn.addEventListener('click', () => {
            if (playbackTimer) stopPlayback();
            else startPlayback();
        });
        const opacity = el('output-vismap-opacity');
        if (opacity) opacity.addEventListener('input', () => {
            if (overlay) overlay.setOpacity(parseFloat(opacity.value));
        });

        // Signs lie flat in the orbit view and stand upright in walk mode.
        const container = el('output-viewer-container');
        if (container) container.addEventListener('walkModeChanged', () => {
            if (overlay) overlay.setSignsUpright(!!viewer.walkMode);
        });
        // enterWalkMode doesn't dispatch walkModeChanged — piggyback on the
        // toggle button (this listener runs after the one that flips the mode).
        const walkBtn = el('output-walk-mode-btn');
        if (walkBtn) walkBtn.addEventListener('click', () => {
            if (overlay) overlay.setSignsUpright(!!viewer.walkMode);
        });

        // A click picks a position; a drag still turns the view
        if (viewer.renderer) {
            const dom = viewer.renderer.domElement;
            let down = null;
            dom.addEventListener('pointerdown', (event) => {
                down = pick && active && !viewer.walkMode ? [event.clientX, event.clientY] : null;
            });
            dom.addEventListener('pointerup', (event) => {
                if (!down || !pick) return;
                const moved = Math.hypot(event.clientX - down[0], event.clientY - down[1]);
                down = null;
                if (moved > 4) return;
                const point = planePoint(event);
                if (point) onPick(point);
            });
        }
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && pick) {
                endPick();
                setStatus('Ready');
                showInputState();
            }
        });

        const fromStyle = new VisMapStyle();
        if (opacity) opacity.value = fromStyle.mapAlpha;
        updateHints();
        refreshSources();
    }

    /** Show or hide the overlay with the Vismap mode. */
    function setActive(on) {
        active = !!on;
        if (!active) {
            stopPlayback();
            endPick();
            if (overlay) overlay.setVisible(false);
            return;
        }
        render();
    }

    /** A simulation folder was opened: its .smv lists the slices, meshes
     *  and obstructions, the slice files are read when they are needed. */
    async function onSimulationFolder(files) {
        try {
            const smvFile = files.find(f => /\.smv$/i.test(f.name));
            sim = smvFile ? VisMapFds.fromSmv(await smvFile.text(), smvFile.name.split(/[\\/]/).pop()) : null;
            folderFiles = new Map(files.filter(f => /\.sf$/i.test(f.name)).map(f => [f.name.split(/[\\/]/).pop(), f]));
            const cell = el('output-vismap-cellsize');
            if (cell) cell.value = '';
            refreshSources();
            // Say why a folder with slice files offers no smoke data
            if (!sim && folderFiles.size) {
                setStatus('The folder holds slice files but no .smv file, which describes them — only uniform extinction can be evaluated.', true);
            } else if (sim && !sim.slices.some(slc => slc.orientation === 3)) {
                setStatus(sim.name + ' lists no horizontal slice — only uniform extinction can be evaluated.', true);
            }
        } catch (e) {
            console.error(e);
            setStatus(e.message, true);
        }
    }

    /** Another FDS file was loaded: the folder of the previous one no longer belongs to it. */
    function onGeometryChanged() {
        if (!host) return;
        sim = null;
        folderFiles = new Map();
        const cell = el('output-vismap-cellsize');
        if (cell) cell.value = '';
        refreshSources();
    }

    /** Simulation time the map shows, for overlays that follow it; null if none. */
    function displayTime() {
        const mapSel = el('output-vismap-mapmode');
        return vis && mapSel && mapSel.value === 'time' ? selectedTime() : null;
    }

    window.VismapPanel = { wire, setActive, onSimulationFolder, onGeometryChanged, displayTime };
})();
