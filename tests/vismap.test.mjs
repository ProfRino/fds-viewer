/**
 * Visibility maps (js/vismap.js), the port of fdsvismap.
 *
 * Two kinds of tests:
 *   - reference results: the scenes of tests/fixtures/vismap-golden.json were
 *     evaluated with the Python package (see make-vismap-golden.py next to
 *     it); every map has to come out the same, cell by cell
 *   - behaviour: the tests of fdsvismap itself (tests/test_synthetic_scene.py,
 *     test_slice_selection.py, test_vismap_example.py), as far as they do not
 *     concern matplotlib
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { buildExampleSim, buildSliceFileWith, temperatureAt, TIMES } from './make-test-sim.mjs';

// Load the non-module globals into a sandbox scope.
const sandbox = {};
new Function('window', fs.readFileSync(new URL('../js/vismap.js', import.meta.url), 'utf8'))(sandbox);
const { VisMap, VisMapRoute, VisMapFds, VisMapUtil } = sandbox;

const readerSrc = fs.readFileSync(new URL('../js/slice-reader.js', import.meta.url), 'utf8');
const { FdsSliceReader } = new Function(readerSrc + '\nreturn { FdsSliceReader };')();

const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/vismap-golden.json', import.meta.url), 'utf8'));

// ── Helpers ──────────────────────────────────────────────────────────────
const valueError = { name: 'VisMapValueError' };  // ValueError in fdsvismap
const stateError = { name: 'VisMapStateError' };  // RuntimeError in fdsvismap

const sum = array => array.reduce((a, b) => a + b, 0);
const axis = (first, step, count) => Array.from({ length: count }, (_, index) => first + index * step);
const or = (a, b) => a.map((v, i) => v | b[i]);
const and = (a, b) => a.map((v, i) => v & b[i]);

/** Number of positions at which two arrays differ, NaN being equal to NaN. */
function differing(actual, expected) {
    let n = Math.abs(actual.length - expected.length);
    for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
        if (actual[i] !== expected[i] && !(Number.isNaN(actual[i]) && Number.isNaN(expected[i]))) n++;
    }
    return n;
}

function assertSame(actual, expected, what) {
    assert.strictEqual(differing(actual, expected), 0, what + ': differs in ' + differing(actual, expected) +
        ' of ' + expected.length + ' values');
}

// The encodings of make-vismap-golden.py
const unruns = text => text.replace(/(.)\{(\d+)\}/g, (_, char, count) => char.repeat(Number(count)));
function unpack(text, count) {
    const hex = unruns(text), out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const byte = parseInt(hex.substr((i >> 3) * 2, 2), 16);
        out[i] = (byte >> (7 - (i & 7))) & 1;
    }
    return out;
}
const digits = (text, timePoints) => Array.from(unruns(text), char => timePoints[parseInt(char, 36)]);

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c;
});
/** zlib.crc32 over the cells (r, c) of a line as little-endian int32. */
function crcOfCells(crc, rr, cc, count) {
    crc = ~crc;
    for (let k = 0; k < count; k++) {
        for (const value of [rr[k], cc[k]]) {
            for (let b = 0; b < 4; b++) crc = CRC_TABLE[(crc ^ (value >> (8 * b))) & 0xFF] ^ (crc >>> 8);
        }
    }
    return ~crc >>> 0;
}

/** Extinction coefficient of cell (i, j) at time index t, as field_value() of make-vismap-golden.py. */
const fieldValue = (i, j, t, a, b) => t * ((a * i + b * j) % 32) / 256 + ((7 * i + 13 * j + 3 * t) % 11) / 64;

/** A VisMap whose extinction field is given per time point instead of read from a slice. */
class FieldVisMap extends VisMap {
    setField(times, a, b, nanBlock) {
        const [nx, ny] = this.fdsGridShape;
        this.fieldTimes = Float64Array.from(times);
        this.fieldFrames = Array.from(times, (_, t) => {
            const frame = new Float64Array(nx * ny);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) frame[i + nx * j] = fieldValue(i, j, t, a, b);
            if (nanBlock) {
                const [i0, i1, j0, j1] = nanBlock;
                for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) frame[i + nx * j] = NaN;
            }
            return frame;
        });
    }

    getExtcoArrayAtTime(time) {
        if (!this.fieldFrames) return super.getExtcoArrayAtTime(time);
        return this.fieldFrames[VisMapUtil.closestIndex(this.fieldTimes, time)];
    }
}

// ── Line rasterisers of scikit-image ─────────────────────────────────────
{
    const rr = new Int32Array(64), cc = new Int32Array(64);
    const cells = (fn, ...ends) => { const n = fn(...ends, rr, cc); return Array.from({ length: n }, (_, k) => [rr[k], cc[k]]); };
    assert.deepStrictEqual(cells(VisMapUtil.line, 0, 0, 2, 1), [[0, 0], [1, 1], [2, 1]]);
    assert.deepStrictEqual(cells(VisMapUtil.line, 0, 0, 1, 2), [[0, 0], [1, 1], [1, 2]]);
    assert.deepStrictEqual(cells(VisMapUtil.line, 3, 3, 3, 3), [[3, 3]]);
    assert.deepStrictEqual(cells(VisMapUtil.lineAA, 2, 2, 2, 2), [[2, 2]]);
    // The anti-aliased line carries the cells beside it
    assert.deepStrictEqual(cells(VisMapUtil.lineAA, 0, 0, 3, 7), [
        [0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2], [1, 3], [2, 3],
        [1, 4], [2, 4], [2, 5], [3, 5], [2, 6], [3, 6], [2, 7], [3, 7]]);

    // Every line between the cells of a small grid, and a sample of long ones
    const size = golden.lines.size;
    let plain = 0, antiAliased = 0;
    for (let r0 = 0; r0 < size; r0++) for (let c0 = 0; c0 < size; c0++) {
        for (let r1 = 0; r1 < size; r1++) for (let c1 = 0; c1 < size; c1++) {
            plain = crcOfCells(plain, rr, cc, VisMapUtil.line(r0, c0, r1, c1, rr, cc));
            antiAliased = crcOfCells(antiAliased, rr, cc, VisMapUtil.lineAA(r0, c0, r1, c1, rr, cc));
        }
    }
    assert.strictEqual(plain, golden.lines.line, 'skimage.draw.line on a ' + size + ' x ' + size + ' grid');
    assert.strictEqual(antiAliased, golden.lines.lineAA, 'skimage.draw.line_aa on a ' + size + ' x ' + size + ' grid');

    const longR = new Int32Array(40000), longC = new Int32Array(40000);
    plain = 0;
    antiAliased = 0;
    for (const [r0, c0, r1, c1] of golden.longLines.ends) {
        plain = crcOfCells(plain, longR, longC, VisMapUtil.line(r0, c0, r1, c1, longR, longC));
        antiAliased = crcOfCells(antiAliased, longR, longC, VisMapUtil.lineAA(r0, c0, r1, c1, longR, longC));
    }
    assert.strictEqual(plain, golden.longLines.line, 'skimage.draw.line, long lines');
    assert.strictEqual(antiAliased, golden.longLines.lineAA, 'skimage.draw.line_aa, long lines');

    // The sight line is the plain line in (x, y), as flat cell indices
    const flat = new Int32Array(64), nx = 13;
    for (const [x0, y0, x1, y1] of [[0, 0, 12, 5], [12, 5, 0, 0], [3, 9, 4, 0], [6, 6, 6, 6], [0, 7, 9, 7]]) {
        const n = VisMapUtil.rayCells(x0, y0, x1, y1, nx, flat, 0);
        assert.deepStrictEqual(Array.from(flat.slice(0, n)), cells(VisMapUtil.line, x0, y0, x1, y1).map(([x, y]) => x + nx * y));
    }
    console.log('ok: line and line_aa rasterise as scikit-image does');
}

// ── Summation of numpy ───────────────────────────────────────────────────
{
    // np.add.reduceat over runs of every length up to 300: the extinction
    // along a sight line is summed in blocks of eight and pairwise, and the
    // last bit of the sum decides cells exactly on the visibility threshold.
    const value = index => ((index * 2654435761) % 2 ** 32) / 2 ** 20 + ((index * 40503) % 2 ** 16) / 2 ** 36;
    let offset = 0;
    golden.reduceat.lengths.forEach((length, k) => {
        const run = Float64Array.from({ length }, (_, i) => value(offset + i));
        const total = length > 1 ? run[0] + VisMapUtil.pairwiseSum(run, 1, length - 1) : run[0];
        assert.strictEqual(total, golden.reduceat.sums[k], 'sum of a run of ' + length + ' values');
        offset += length;
    });
    console.log('ok: sight lines are summed as np.add.reduceat does');
}

// ── Reference results of fdsvismap ───────────────────────────────────────
function buildScene(scene) {
    const vis = new FieldVisMap();
    vis.setGrid(axis(...scene.x), axis(...scene.y), scene.height === undefined ? 2.0 : scene.height);
    if (scene.single) {
        vis.allXCoords = Float32Array.from(vis.allXCoords);
        vis.allYCoords = Float32Array.from(vis.allYCoords);
    }
    for (const [kind, x1, x2, y1, y2] of scene.visual) {
        if (kind === 'obstruction') vis.addVisualObstruction(x1, x2, y1, y2);
        else vis.addVisualHole(x1, x2, y1, y2);
    }
    for (const sign of scene.signs) vis.addSign(...sign);
    for (const [routeId, waypoints, signs] of scene.routes) vis.addRoute(routeId, waypoints, signs);
    if (scene.field) {
        vis.setTimePoints(scene.times);
        vis.setField(vis.vismapTimePoints, scene.field.a, scene.field.b, scene.field.nan_block);
    } else {
        vis.setUniformExtco(scene.extco, scene.times);
    }
    if (scene.bounds) vis.setVisibilityBounds(...scene.bounds);
    return vis;
}

function computeOptions(scene) {
    const c = scene.compute || {};
    return { tMax: c.t_max, viewAngle: c.view_angle, obstructions: c.obstructions, aa: c.aa };
}

function assertSceneEqualsReference(vis, scene) {
    const e = scene.expected, name = scene.name;
    const [nx, ny] = vis.fdsGridShape, cells = nx * ny;
    const signIds = Array.from(vis.allSignDict.keys());
    const scopes = [null, ...vis.allRouteDict.keys()], limits = [null, ...(scene.limits || [])];

    assertSame(Array.from(vis.vismapTimePoints), e.timePoints, name + ', time points');
    assertSame(vis.obstructionsArray, unpack(e.obstructions, cells), name + ', obstructions');
    e.computedTimes.forEach((time, t) => {
        signIds.forEach((signId, s) => assertSame(vis.getSignVismap(signId, time),
            unpack(e.signVismaps[t][s], cells), name + ', vismap of sign ' + signId + ' at ' + time + ' s'));
        scopes.forEach((scope, s) => assertSame(vis.getAggVismap(time, scope),
            unpack(e.aggVismaps[t][s], cells), name + ', vismap of ' + (scope || 'all signs') + ' at ' + time + ' s'));
    });
    limits.forEach((limit, l) => scopes.forEach((scope, s) => {
        const of = ' of ' + (scope || 'all signs') + ' up to ' + limit;
        assertSame(vis.getTimeAggVismap(limit, scope), unpack(e.timeAggVismaps[l][s], cells), name + ', time aggregated vismap' + of);
        assertSame(Array.from(vis.getAsetMap(limit, scope)), digits(e.asetMaps[l][s], e.timePoints), name + ', ASET map' + of);
    }));
    for (const [routeId, expected] of Object.entries(e.routes)) {
        const points = vis.getRoutePoints(routeId), of = ' of route ' + routeId;
        assert.strictEqual(vis.allRouteDict.get(routeId).length, expected.length, name + ', length' + of);
        assert.strictEqual(points.length, expected.points.count, name + ', number of points' + of);
        assertSame(points.filter((_, k) => k % expected.points.every === 0).flat(), expected.points.points.flat(), name + ', points' + of);
        e.computedTimes.forEach((time, t) => assertSame(Array.from(vis.getRouteCoverage(routeId, time)),
            Array.from(unruns(expected.coverage[t]), Number), name + ', coverage' + of + ' at ' + time + ' s'));
        limits.forEach((limit, l) => assertSame(Array.from(vis.getRouteAset(routeId, limit)),
            digits(expected.aset[l], e.timePoints), name + ', ASET' + of + ' up to ' + limit));
    }
    for (const [time, x, y, signId, visible, distance, visibilityToSign, localVisibility] of e.probes) {
        const at = name + ', sign ' + signId + ' from (' + x + ', ' + y + ') at ' + time + ' s';
        assert.strictEqual(vis.signIsVisible(time, x, y, signId), visible, at);
        assert.strictEqual(vis.getDistanceToSign(x, y, signId), distance, at);
        // Sine and cosine of the viewing direction may differ in their last
        // bit between platforms, which shows where their terms nearly cancel:
        // the visibilities in m are compared to a nanometre
        for (const [actual, expected] of [
            [vis.getVisibilityToSign(time, x, y, signId), visibilityToSign],
            [vis.getLocalVisibility(time, x, y, vis.allSignDict.get(signId).c), localVisibility]]) {
            if (expected === null) assert.ok(Number.isNaN(actual), at);
            else assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(expected), 1), at + ': ' + actual + ' instead of ' + expected);
        }
    }
}

assert.strictEqual(golden.fdsvismap, VisMap.FDSVISMAP_VERSION, 'reference results of the ported fdsvismap release');
for (const scene of golden.scenes) {
    const vis = buildScene(scene);
    vis.computeAll(computeOptions(scene));
    assertSceneEqualsReference(vis, scene);

    // Sight lines that are traced again at every time step instead of being kept
    const traced = buildScene(scene);
    traced.rayCacheLimit = 0;
    traced.computeAll(computeOptions(scene));
    assertSceneEqualsReference(traced, scene);
    console.log('ok: equals fdsvismap ' + golden.fdsvismap + ' - ' + scene.name);
}

// ── Scene without an FDS simulation (tests/test_synthetic_scene.py) ──────
const X = axis(0.25, 0.5, 40);  // np.arange(0.25, 20.0, 0.5)
const Y = axis(0.25, 0.5, 20);  // np.arange(0.25, 10.0, 0.5)
const SIGN = [10.0, 5.0];

/** A 20 x 10 m room with one sign at the centre and no fire. */
function room(extco = 0.0, alpha = null, c = 3.0) {
    const vis = new VisMap();
    vis.setGrid(X, Y);
    vis.setUniformExtco(extco);
    vis.setTimePoints([0.0]);
    vis.addSign(0, SIGN[0], SIGN[1], c, alpha);
    return vis;
}

function computed(vis) {
    vis.computeAll({ viewAngle: true, obstructions: true, aa: true });
    return vis;
}

{
    // The grid matches the shape readFdsData would build
    let vis = room();
    assert.deepStrictEqual(vis.fdsGridShape, [X.length, Y.length]);
    assert.ok(Math.abs(vis.cellSize[0] - 0.5) < 1e-12 && Math.abs(vis.cellSize[1] - 0.5) < 1e-12);
    // extent is the outer envelope of the cells, not the cell centres
    assert.ok(Math.abs(vis.extent[0][0] - (X[0] - 0.25)) < 1e-12);
    assert.ok(Math.abs(vis.extent[0][1] - (X[X.length - 1] + 0.25)) < 1e-12);
    assert.deepStrictEqual(vis.getDomainExtent(), [0, 20, 0, 10]);

    // Obstructions can be added straight after setGrid
    vis.addVisualObstruction(9.5, 10.5, 0.0, 4.0);
    assert.strictEqual(vis.obstructionsArray.length, X.length * Y.length);
    assert.strictEqual(sum(vis.obstructionsArray), 16);

    // A rebuild keeps the obstructions, although there is no simulation to rasterise
    const expected = vis.obstructionsArray.slice();
    vis.buildObstructionsArray();
    assertSame(vis.obstructionsArray, expected, 'obstructions after a rebuild');

    // A finer grid rasterises the obstructions again
    vis.setGrid(axis(0.125, 0.25, 80), axis(0.125, 0.25, 40));
    assert.strictEqual(vis.obstructionsArray.length, 80 * 40);
    assert.strictEqual(sum(vis.obstructionsArray), 4 * 16);

    // A new grid discards the maps, they do not fit it
    vis = computed(room());
    assert.ok(sum(vis.getSignVismap(0, 0.0)) > 0);
    vis.setGrid(axis(0.25, 0.5, 20), Y);
    for (const call of [() => vis.getSignVismap(0, 0.0), () => vis.getAggVismap(0.0), () => vis.getAsetMap()]) {
        assert.throws(call, stateError);
    }
    vis.setUniformExtco(0.0);
    computed(vis);
    assert.strictEqual(vis.getSignVismap(0, 0.0).length, Y.length * 20);

    assert.throws(() => new VisMap().setGrid([1.0], [1.0, 2.0]), { ...valueError, message: /at least two coordinates/ });
    // A descending axis would give a negative cell size and silently place
    // obstructions on the wrong cells
    assert.throws(() => new VisMap().setGrid([10.0, 9.0, 8.0], [0.0, 1.0]), { ...valueError, message: /ascending/ });
    assert.throws(() => new VisMap().setGrid([0.0, 1.0, 5.0, 6.0], [0.0, 1.0]), { ...valueError, message: /uniformly spaced/ });
    assert.throws(() => new VisMap().setUniformExtco(-1.0), { ...valueError, message: />= 0/ });
    assert.throws(() => new VisMap().getExtcoArrayAtTime(0.0), { ...stateError, message: /setGrid/ });
    assert.throws(() => new VisMap().addVisualObstruction(0, 1, 0, 1), { ...stateError, message: /setGrid/ });
    console.log('ok: setGrid defines the grid of a scene without a simulation');
}

{
    // One call is enough to set the evaluation times
    let vis = new VisMap();
    vis.setGrid(X, Y);
    vis.setUniformExtco(0.0, [0.0, 10.0]);
    assert.deepStrictEqual(Array.from(vis.vismapTimePoints), [0.0, 10.0]);
    vis.addSign(0, ...SIGN, 3.0, null);
    computed(vis);
    assert.ok(vis.getVisibilityToSign(10.0, 12.0, 5.0, 0) > 0.0);

    // The field keeps the times that were set, it does not take them away
    vis = new VisMap();
    vis.setGrid(X, Y);
    vis.setTimePoints([0.0, 60.0, 120.0]);
    vis.setUniformExtco(0.5);
    assert.deepStrictEqual(Array.from(vis.vismapTimePoints), [0.0, 60.0, 120.0]);
    assert.deepStrictEqual(Array.from(vis.fdsTimePoints), [0.0, 60.0, 120.0]);
    // An explicit argument still wins, and without any times one is supplied
    vis.setUniformExtco(0.5, [0.0, 10.0]);
    assert.deepStrictEqual(Array.from(vis.vismapTimePoints), [0.0, 10.0]);
    const fresh = new VisMap();
    fresh.setGrid(X, Y);
    fresh.setUniformExtco(0.5);
    assert.deepStrictEqual(Array.from(fresh.vismapTimePoints), [0.0]);

    // A new field discards the maps: it is an input of them, as a slice is
    vis = computed(room(1.0));
    assert.ok(sum(vis.getAggVismap(0.0)) > 0);
    vis.setUniformExtco(0.0);
    assert.throws(() => vis.getAggVismap(0.0), stateError);
    console.log('ok: setUniformExtco defines the smoke of a scene without a simulation');
}

{
    // An unobstructed sight line in clear air gives maxVis
    let vis = computed(room(0.0));
    assert.strictEqual(vis.getVisibilityToSign(0.0, 12.0, 5.0, 0), vis.maxVis);

    // A wall from y = 0 to y = 4 blocks what passes through it, not over it.
    // The sign sits east of the wall so both sight lines actually reach it.
    vis = new VisMap();
    vis.setGrid(X, Y);
    vis.setUniformExtco(0.0);
    vis.setTimePoints([0.0]);
    vis.addSign(0, 18.0, 5.0, 3.0, null);
    vis.addVisualObstruction(9.5, 10.5, 0.0, 4.0);
    computed(vis);
    assert.strictEqual(vis.getVisibilityToSign(0.0, 5.0, 1.0, 0), 0.0);  // crosses the wall at y ~ 2.4
    assert.ok(vis.getVisibilityToSign(0.0, 5.0, 6.0, 0) > 0.0);          // passes over it at y ~ 5.7

    // Uniform smoke follows the Jin relation S = C / K, limited to maxVis
    for (const extco of [0.1, 0.3, 1.0, 3.0]) {
        vis = computed(room(extco));
        const expected = Math.min(vis.maxVis, 3.0 / extco);
        assert.ok(Math.abs(vis.getVisibilityToSign(0.0, 12.0, 5.0, 0) - expected) <= 1e-3 * expected);
        assert.ok(Math.abs(vis.getLocalVisibility(0.0, 12.0, 5.0, 3.0) - expected) <= 1e-3 * expected);
    }

    // A light-emitting sign (C = 8) is legible further than a reflecting one
    assert.ok(computed(room(1.0, null, 8.0)).getVisibilityToSign(0.0, 12.0, 5.0, 0) >
        computed(room(1.0, null, 3.0)).getVisibilityToSign(0.0, 12.0, 5.0, 0));
    console.log('ok: visibility in clear air and in uniform smoke');
}

{
    // getVisibilityToSign and signIsVisible apply the same factors: a
    // directional sign is dark from behind (alpha = 90 is readable from the east)
    let vis = computed(room(0.0, 90));
    assert.ok(vis.getVisibilityToSign(0.0, 15.0, 5.0, 0) > 0.0);
    assert.strictEqual(vis.getVisibilityToSign(0.0, 5.0, 5.0, 0), 0.0);
    for (const x of [5.0, 8.0, 12.0, 15.0]) {
        const distance = Math.hypot(x - SIGN[0], 5.0 - SIGN[1]);
        assert.strictEqual(vis.getVisibilityToSign(0.0, x, 5.0, 0) >= distance, vis.signIsVisible(0.0, x, 5.0, 0));
    }

    // Any query time is valid on a static field, it resolves to the computed point
    vis = computed(room(0.0));
    assert.ok(vis.signIsVisible(1.0, 12.0, 5.0, 0));
    assert.strictEqual(vis.getVisibilityToSign(3600.0, 12.0, 5.0, 0), vis.getVisibilityToSign(0.0, 12.0, 5.0, 0));

    // An omnidirectional sign is readable from both sides
    vis = computed(room(0.0, null));
    assert.ok(vis.getVisibilityToSign(0.0, 15.0, 5.0, 0) > 0.0);
    assert.ok(vis.getVisibilityToSign(0.0, 5.0, 5.0, 0) > 0.0);

    // 'omni' and null both make a sign without a viewing direction
    vis = new VisMap();
    vis.addSign(1, 1, 1, 3, 'omni');
    vis.addSign(2, 2, 2, 3, null);
    assert.strictEqual(vis.allSignDict.get(1).alpha, null);
    assert.strictEqual(vis.allSignDict.get(2).alpha, null);
    console.log('ok: the viewing direction of a sign');
}

// ── Signs and routes (tests/test_vismap_example.py) ──────────────────────
/** Two walls with a door, three named signs and two routes that share one of them, in thickening smoke. */
function routeMap(timePoints = [0, 100, 200, 300, 400]) {
    const vis = new FieldVisMap();
    vis.setGrid(axis(0.1, 0.2, 100), axis(0.1, 0.2, 50));
    vis.addVisualObstruction(9.8, 10.0, 0.0, 10.0);
    vis.addVisualHole(9.8, 10.0, 3.4, 4.4);
    vis.addVisualObstruction(0.0, 9.8, 4.6, 4.8);
    vis.addVisualHole(8.0, 8.8, 4.6, 4.8);
    vis.addSign('door', 8.4, 4.8, 3, 0);
    vis.addSign('hall', 9.8, 4, 3, 270);
    vis.addSign('exit', 17, 10, 3, 180);
    vis.addRoute('west', [[1, 9], [8.4, 6], [9.8, 4.5]], ['door', 'hall']);
    vis.addRoute('east', [[15, 2], [17, 5], [17, 9.5]], ['exit', 'hall']);
    vis.setTimePoints(timePoints);
    vis.setField(vis.vismapTimePoints, 3, 1);
    return vis;
}

{
    const vis = routeMap();
    vis.computeAll();

    // Signs and routes are stored with their IDs and parameters
    assert.deepStrictEqual(Array.from(vis.allSignDict.keys()), ['door', 'hall', 'exit']);
    assert.strictEqual(vis.allSignDict.get('hall').alpha, 270);
    assert.deepStrictEqual(vis.allRouteDict.get('west').signs, ['door', 'hall']);
    assert.deepStrictEqual(vis.allRouteDict.get('west').waypoints, [[1, 9], [8.4, 6], [9.8, 4.5]]);
    assert.ok(Math.abs(vis.allRouteDict.get('west').length - (Math.hypot(7.4, 3) + Math.hypot(1.4, 1.5))) < 1e-12);

    // A route needs a line of (x, y) pairs and signs that exist
    assert.throws(() => vis.addRoute('invalid', [[1, 1]], ['door']), valueError);
    assert.throws(() => vis.addRoute('invalid', [1, 2, 3], ['door']), valueError);
    assert.throws(() => vis.addRoute('invalid', [[1, 1], [2, 2]], ['nowhere']), valueError);
    assert.strictEqual(vis.allRouteDict.has('invalid'), false);
    // Without signs given, all signs added so far belong to a route
    vis.addRoute('all', [[1, 1], [2, 2]]);
    assert.deepStrictEqual(vis.allRouteDict.get('all').signs, ['door', 'hall', 'exit']);
    // A route is no input of the maps, adding one keeps them
    assert.strictEqual(vis.getAggVismap(200).length, 100 * 50);

    // The vismap of a route is the aggregation of the vismaps of its signs only
    const routeVismap = vis.getAggVismap(200, 'west');
    assertSame(routeVismap, or(vis.getSignVismap('door', 200), vis.getSignVismap('hall', 200)), 'vismap of route west');
    assert.ok(differing(routeVismap, vis.getAggVismap(200)) > 0, 'the sign of the other route is not included');
    assertSame(vis.getAggVismap(200), ['door', 'hall', 'exit'].map(id => vis.getSignVismap(id, 200)).reduce(or), 'vismap of all signs');
    assert.throws(() => vis.getAggVismap(200, 'nowhere'), valueError);

    // A sign is looked up by its ID, not by its position
    const [nx] = vis.fdsGridShape;
    for (const signId of vis.allSignDict.keys()) {
        const cell = VisMapUtil.closestIndex(vis.allXCoords, 8) + nx * VisMapUtil.closestIndex(vis.allYCoords, 6);
        assert.strictEqual(vis.signIsVisible(200, 8, 6, signId), Boolean(vis.getSignVismap(signId, 200)[cell]));
    }
    assert.throws(() => vis.signIsVisible(200, 8, 6, 'nowhere'), valueError);
    assert.throws(() => vis.getDistanceToSign(8, 6, 'nowhere'), valueError);
    assert.ok(Math.abs(vis.getDistanceToSign(2, 4, 'hall') - 7.8) < 1e-9);

    // The coverage is sampled along the route in the resolution of the grid
    // and carries the value of the route vismap at the cell of each point
    const points = vis.getRoutePoints('west'), coverage = vis.getRouteCoverage('west', 200);
    assert.strictEqual(coverage.length, points.length);
    assert.deepStrictEqual(points[0], [1, 9]);
    assert.deepStrictEqual(points[points.length - 1], [9.8, 4.5]);
    for (let k = 1; k < points.length; k++) {
        const step = Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
        assert.ok(step <= Math.min(...vis.cellSize) + 1e-9);
    }
    points.forEach(([x, y], k) => {
        const cell = VisMapUtil.closestIndex(vis.allXCoords, x) + nx * VisMapUtil.closestIndex(vis.allYCoords, y);
        assert.strictEqual(coverage[k], routeVismap[cell]);
    });

    // The ASET along a route is the first time point without coverage per point
    const aset = vis.getRouteAset('west');
    const times = Array.from(vis.vismapTimePoints), last = times[times.length - 1];
    const coverages = times.map(time => vis.getRouteCoverage('west', time));
    assert.strictEqual(aset.length, points.length);
    aset.forEach((time, k) => {
        const lost = times.find((_, t) => !coverages[t][k]);
        assert.strictEqual(time, lost === undefined ? last : lost);
    });
    assert.ok(aset.some(time => time < last), 'points that lose their sign before the end');
    assert.ok(aset.some(time => time === last), 'points that keep their sign');

    // Waypoints at the same position do not break the sampling
    assert.deepStrictEqual(new VisMapRoute([[0, 0], [0, 0], [3, 4], [3, 4]]).sample(2.5), [[0, 0], [1.5, 2], [3, 4]]);
    assert.deepStrictEqual(new VisMapRoute([[1, 2], [1, 2]]).sample(1), [[1, 2]]);
    assert.throws(() => new VisMapRoute([[0, 0], [1, 1]]).sample(0), valueError);
    console.log('ok: signs, routes, their coverage and ASET');
}

// ── Time points ──────────────────────────────────────────────────────────
{
    // Unsorted time points give the same maps as sorted ones
    const ordered = routeMap([0, 150, 300, 450]), shuffled = routeMap([300, 0, 450, 150]);
    ordered.computeAll();
    shuffled.computeAll();
    assert.deepStrictEqual(Array.from(shuffled.vismapTimePoints), [0, 150, 300, 450]);
    assertSame(shuffled.getAsetMap(), ordered.getAsetMap(), 'ASET map of shuffled time points');
    for (const time of [0, 150, 300, 450]) {
        assertSame(shuffled.getAggVismap(time), ordered.getAggVismap(time), 'vismap of shuffled time points');
    }
    // The maximum time is the latest one, not the last one that was passed
    assert.strictEqual(Math.max(...shuffled.getAsetMap()), 450);
    assert.throws(() => shuffled.getAggVismap(500), valueError);

    // A time point given twice is computed once
    const twice = routeMap([0, 300, 300, 150]);
    assert.deepStrictEqual(Array.from(twice.vismapTimePoints), [0, 150, 300]);
    const steps = [];
    twice.computeAll({ progress: step => steps.push(step) });
    assert.strictEqual(steps.filter(step => step.phase === 'signs').length, 3);
    assert.deepStrictEqual(steps[steps.length - 1], { phase: 'times', done: 9, total: 9, time: 300 });
    console.log('ok: time points are sorted and unique');
}

{
    // Without time points the message names setTimePoints
    const vis = new FieldVisMap();
    vis.setGrid(X, Y);
    vis.addSign(1, 8.4, 4.8, 3, 0);
    assert.throws(() => vis.computeAll(), { ...valueError, message: /setTimePoints/ });
    for (const call of [() => vis.getAsetMap(), () => vis.getTimeAggVismap()]) {
        assert.throws(call, { ...valueError, message: /setTimePoints/ });
    }
    // A tMax below the first time point selects nothing, which is worth saying
    vis.setTimePoints([100, 200, 300]);
    vis.setField(vis.vismapTimePoints, 1, 1);
    assert.throws(() => vis.computeAll({ tMax: 50 }), { ...valueError, message: /tMax=50/ });
    vis.computeAll({ tMax: 200 });
    assert.strictEqual(vis.getAsetMap().length, X.length * Y.length);
    assert.throws(() => vis.getAggVismap(300), valueError);

    // Without a grid there is nothing to compute on
    const empty = new VisMap();
    empty.addSign(1, 1, 1, 3, 0);
    empty.setTimePoints([0]);
    assert.throws(() => empty.computeAll(), { ...stateError, message: /setGrid/ });
    console.log('ok: missing time points are named');
}

{
    // The aggregation over time is limited to the computed time points
    const vis = routeMap([0, 50, 100, 150, 200, 250, 300, 350, 400, 450]);
    vis.computeAll({ tMax: 200 });
    assertSame(vis.getTimeAggVismap(), [0, 50, 100, 150, 200].map(time => vis.getAggVismap(time)).reduce(and),
        'time aggregated vismap up to the computed time');
    // A shorter period uses its time points only, a longer one is rejected
    assertSame(vis.getTimeAggVismap(100), [0, 50, 100].map(time => vis.getAggVismap(time)).reduce(and),
        'time aggregated vismap up to 100 s');
    assertSame(vis.getTimeAggVismap(100, 'east'), [0, 50, 100].map(time => vis.getAggVismap(time, 'east')).reduce(and),
        'time aggregated vismap of a route up to 100 s');
    assert.throws(() => vis.getTimeAggVismap(300), valueError);
    assert.throws(() => vis.getAsetMap(300), valueError);
    assert.throws(() => vis.getRouteAset('west', 300), valueError);
    assert.throws(() => vis.signIsVisible(250, 5, 5, 'door'), valueError);
    assert.strictEqual(Math.max(...vis.getAsetMap()), 200);
    console.log('ok: evaluations after computeAll was limited with tMax');
}

{
    // The ASET map holds the first time without a sign, also with decimals
    const vis = routeMap([0, 112.5, 225, 337.5, 450]);
    vis.computeAll();
    const times = Array.from(vis.vismapTimePoints);
    const maps = times.map(time => vis.getAggVismap(time));
    const aset = vis.getAsetMap();
    assert.ok(aset instanceof Float64Array);
    aset.forEach((time, cell) => {
        const lost = times.find((_, t) => !maps[t][cell]);
        assert.strictEqual(time, lost === undefined ? 450 : lost);
    });
    assert.ok(aset.some(time => time % 1 !== 0), 'times with decimals are not truncated');
    // A maximum time with decimals limits the map to the time points below it
    const part = vis.getAsetMap(112.5);
    assert.ok(part.every(time => time === 0 || time === 112.5));
    assertSame(part.map(time => time === 0 ? 1 : 0), maps[0].map(v => 1 - v), 'cells without a sign from the start');
    // 0 is a limit of its own, not a missing one
    assert.ok(vis.getAsetMap(0).every(time => time === 0));
    console.log('ok: the ASET map keeps the time points');
}

// ── Results are discarded when their input changes ───────────────────────
{
    const fresh = () => { const vis = routeMap([0, 100, 200, 300]); vis.computeAll(); return vis; };

    // A map of an old time point is not returned for a new one
    let vis = fresh();
    vis.setTimePoints([0, 50]);
    assert.throws(() => vis.getAggVismap(50), stateError);
    assert.throws(() => vis.getAsetMap(), stateError);

    // A sign that is added again with another position does not keep its old arrays
    vis = fresh();
    vis.addSign('door', 1.0, 1.0, 3, 0);
    assert.throws(() => vis.getSignVismap('door', 100), stateError);
    assert.deepStrictEqual(Array.from(vis.allSignDict.keys()), ['door', 'hall', 'exit']);

    // A new sign, a new obstruction and new visibility bounds discard the maps
    vis = fresh();
    vis.addSign('new', 17, 5, 3, 180);
    assert.throws(() => vis.signIsVisible(100, 5, 5, 'new'), stateError);
    vis = fresh();
    vis.addVisualObstruction(8, 8.8, 4.6, 4.8);
    assert.throws(() => vis.getAggVismap(100), stateError);
    vis.computeAll();
    assert.strictEqual(vis.getAggVismap(100).length, vis.obstructionsArray.length);
    vis = fresh();
    vis.setVisibilityBounds(5, 20);
    assert.throws(() => vis.getAggVismap(100), stateError);

    // Before computeAll the getters name the missing computation
    vis = routeMap([0, 100]);
    for (const call of [
        () => vis.getSignVismap('door', 0), () => vis.getAggVismap(0), () => vis.getTimeAggVismap(),
        () => vis.getVisibilityToSign(0, 2, 4, 'door'), () => vis.signIsVisible(0, 2, 4, 'door'),
        () => vis.getRouteCoverage('west', 0), () => vis.getRouteAset('west')]) {
        assert.throws(call, stateError);
    }
    // An unknown ID is still a ValueError, not a missing computation
    assert.throws(() => vis.getSignVismap('nowhere', 0), valueError);
    console.log('ok: results are discarded when their input changes');
}

// ── Obstructions and holes added by hand ─────────────────────────────────
{
    // They are applied in the order they were added: a hole after a wall
    // opens it, a hole before a wall is covered by it
    const wallThenHole = new VisMap(), holeThenWall = new VisMap();
    for (const vis of [wallThenHole, holeThenWall]) vis.setGrid(X, Y);
    wallThenHole.addVisualObstruction(2, 4, 2, 4);
    wallThenHole.addVisualHole(2.5, 3.5, 2.5, 3.5);
    holeThenWall.addVisualHole(2.5, 3.5, 2.5, 3.5);
    holeThenWall.addVisualObstruction(2, 4, 2, 4);
    assert.strictEqual(sum(wallThenHole.obstructionsArray), 16 - 4);
    assert.strictEqual(sum(holeThenWall.obstructionsArray), 16);
    for (const vis of [wallThenHole, holeThenWall]) {
        const expected = vis.obstructionsArray.slice();
        vis.buildObstructionsArray();
        assertSame(vis.obstructionsArray, expected, 'manual obstructions after a rebuild');
    }

    // A rectangle that ends on a cell face does not claim the next row of cells
    const vis = new VisMap();
    vis.setGrid(X, Y);
    vis.addVisualObstruction(9.5, 10.5, 0.0, 4.0);
    const nx = X.length;
    for (let j = 0; j < Y.length; j++) {
        for (let i = 0; i < nx; i++) {
            const inside = X[i] > 9.5 && X[i] < 10.5 && Y[j] > 0.0 && Y[j] < 4.0;
            assert.strictEqual(vis.obstructionsArray[i + nx * j], inside ? 1 : 0);
        }
    }
    console.log('ok: manual obstructions and holes survive a rebuild, in their order');
}

// ── computeAll in the browser ────────────────────────────────────────────
{
    const reference = routeMap();
    reference.computeAll();

    // The stepwise computation gives the maps of the blocking one
    const vis = routeMap();
    assert.strictEqual(await vis.computeAllAsync(), true);
    for (const time of vis.vismapTimePoints) {
        assertSame(vis.getAggVismap(time), reference.getAggVismap(time), 'computeAllAsync at ' + time + ' s');
    }
    assertSame(vis.getAsetMap(null, 'west'), reference.getAsetMap(null, 'west'), 'ASET map of computeAllAsync');

    // A cancelled computation leaves no half-finished maps behind
    const slow = routeMap(axis(0, 2, 200));
    let asked = 0;
    assert.strictEqual(await slow.computeAllAsync({ cancelled: () => ++asked > 1 }), false);
    assert.throws(() => slow.getAggVismap(0), stateError);
    assert.throws(() => slow.getSignVismap('door', 0), stateError);

    // More than 32 signs need more than one word of bits per cell
    const many = routeMap([0, 200]);
    for (let k = 0; k < 40; k++) many.addSign(k, 0.3 + 0.47 * k, 0.5 + 0.2 * (k % 7), 3, 9 * k);
    many.addRoute('late', [[1, 1], [19, 1]], [35, 39, 'exit']);
    many.computeAll();
    const ids = Array.from(many.allSignDict.keys());
    assert.strictEqual(ids.length, 43);
    assertSame(many.getAggVismap(200), ids.map(id => many.getSignVismap(id, 200)).reduce(or), 'vismap of 43 signs');
    assertSame(many.getAggVismap(200, 'late'), [35, 39, 'exit'].map(id => many.getSignVismap(id, 200)).reduce(or),
        'vismap of a route among 43 signs');
    assert.strictEqual(many.signIsVisible(200, 17, 9, 39), Boolean(many.getSignVismap(39, 200)[
        VisMapUtil.closestIndex(many.allXCoords, 17) + 100 * VisMapUtil.closestIndex(many.allYCoords, 9)]));
    console.log('ok: computeAllAsync, cancelling and more than 32 signs');
}

// ── FDS output (tests/test_slice_selection.py) ───────────────────────────
// One mesh as in fdsvismap's tests/data/slice_order: 4 x 4 x 3 m with cells
// of 0.25 m and unnamed slices of one quantity, a vertical one through y = 0
// first, then cell-centred horizontal ones at PBZ = 2.5, 1.5 and 0.5 m from
// top to bottom. FDS writes a cell-centred slice at the grid plane above it.
const EXT = ['SOOT EXTINCTION COEFFICIENT', 'ext_coef_C0.9H0.1', '1/m'];
const SIM_TIMES = [0, 5, 10, 15, 20];

function smvText(meshes, slices) {
    const lines = ['TITLE', ' synthetic', ''];
    for (const mesh of meshes) {
        lines.push('OFFSET', ' 0.0 0.0 0.0', '', 'GRID   ' + mesh.id, '   ' + mesh.ijk.join('   ') + '    0', '',
            'PDIM', ' ' + mesh.xb.concat([0, 0, 0]).map(v => v.toFixed(5)).join(' '), '');
        ['TRNX', 'TRNY', 'TRNZ'].forEach((name, a) => {
            lines.push(name, '    0');
            for (let k = 0; k <= mesh.ijk[a]; k++) {
                lines.push('  ' + k + '  ' + (mesh.xb[a * 2] + (mesh.xb[a * 2 + 1] - mesh.xb[a * 2]) * k / mesh.ijk[a]).toFixed(5));
            }
            lines.push('');
        });
        const obsts = mesh.obsts || [];
        lines.push('OBST', '   ' + obsts.length);
        for (const xb of obsts) lines.push(' ' + xb.map(v => v.toFixed(5)).join(' ') + '   1   1   1   1   1   1   1');
        for (let k = 0; k < obsts.length; k++) lines.push('   0   1   0   1   0   1  -1  -1');
        lines.push('', 'VENT', '    0    0', '', 'CVENT', '    0', '');
    }
    for (const slc of slices) {
        lines.push(slc.type + '     ' + slc.mesh + ' # STRUCTURED ' + (slc.id ? '%' + slc.id + ' ' : '') + '&  ' +
            slc.indices.join('  ') + ' !  ' + slc.index + '  ' + (slc.type === 'SLCC' ? 1 : 0),
            ' ' + slc.file, ' ' + slc.quantity[0], ' ' + slc.quantity[1], ' ' + slc.quantity[2]);
    }
    return lines.join('\n') + '\n';
}

/** Extinction coefficient of the cell with the upper corner node (i, j) of a 16 x 16 grid: more of it further up. */
const extcoOfCell = (i, j, level, t) => level * (1 + t) * 0.05 + ((5 * i + 3 * j) % 7) / 100;
const GHOST = -99;  // FDS fills the first row and column of a cell-centred slice with values of no cell

function sliceOrderSim(options = {}) {
    const mesh = { id: 'mesh', ijk: [16, 16, 12], xb: [-2, 2, -2, 2, 0, 3], obsts: options.obsts };
    const horizontal = (index, k, level) => ({
        type: 'SLCC', mesh: 1, index, indices: [0, 16, 0, 16, k, k], file: 'so_1_' + index + '.sf',
        quantity: options.quantity || EXT, level, id: options.ids ? 'level_' + level : '',
    });
    const slices = [
        { type: 'SLCF', mesh: 1, index: 1, indices: [0, 16, 8, 8, 0, 12], file: 'so_1_1.sf', quantity: EXT, level: 0 },
        horizontal(2, 11, 3), horizontal(3, 7, 2), horizontal(4, 3, 1),
    ];
    const sim = VisMapFds.fromSmv(smvText([mesh], slices), 'slice_order.smv');
    for (const slc of slices) {
        sim.addSliceFile(slc.file, FdsSliceReader.parse(buildSliceFileWith(...slc.quantity, slc.indices, SIM_TIMES,
            (i, j, k, t) => (slc.type === 'SLCC' && (i === 0 || j === 0)) ? GHOST : extcoOfCell(i, j, slc.level, t))));
    }
    return sim;
}

function read(options, sim = sliceOrderSim()) {
    const vis = new VisMap();
    vis.readFdsData(sim, options);
    return vis;
}

{
    const sim = sliceOrderSim();
    assert.strictEqual(sim.meshes.length, 1);
    assert.ok(sim.meshes[0].coordinates.every(c => c instanceof Float32Array), 'coordinates in single precision, as in fdsreader');
    assert.deepStrictEqual(sim.slices.map(s => [s.index, s.orientation, s.cellCentered, s.extent[2][0]]),
        [[0, 2, false, 0], [1, 3, true, 2.75], [2, 3, true, 1.75], [3, 3, true, 0.75]]);
    assert.deepStrictEqual(sim.filesOf(sim.slices[2]), ['so_1_3.sf']);

    // The height selects the nearest horizontal slice
    for (const [height, z] of [[0.5, 0.75], [1.5, 1.75], [2.5, 2.75], [2.0, 1.75], [10.0, 2.75]]) {
        const vis = read({ fdsSlcHeight: height });
        assert.strictEqual(vis.slc.orientation, 3);
        assert.strictEqual(vis.slc.extent[2][0], z, 'slice nearest to ' + height + ' m');
        assert.strictEqual(vis.fdsSlcHeight, height);
    }
    assert.strictEqual(read().slc.extent[2][0], 1.75, 'the default height is 2 m');
    // 1.25 m lies halfway between 0.75 m and 1.75 m; 1.75 m is declared first
    assert.strictEqual(read({ fdsSlcHeight: 1.25 }).slc.extent[2][0], 1.75);

    // The smoke layer makes K grow with height
    const means = [0.5, 1.5, 2.5].map(height => {
        const extco = read({ fdsSlcHeight: height }).getExtcoArrayAtTime(20.0);
        return sum(extco) / extco.length;
    });
    assert.ok(means[0] < means[1] && means[1] < means[2]);

    // The index selects an unnamed slice and takes precedence over the height
    let vis = read({ fdsSlcIndex: 3 });
    assert.strictEqual(vis.slc.extent[2][0], 0.75);
    assert.strictEqual(vis.getExtcoArrayAtTime(20.0).length, 16 * 16);
    assert.strictEqual(read({ fdsSlcIndex: 1, fdsSlcHeight: 0.5 }).slc.extent[2][0], 2.75);
    for (const index of [4, -1]) {
        assert.throws(() => read({ fdsSlcIndex: index }), { ...valueError, message: /\[3\] \(no ID\).*z = 0\.75 m/ });
    }
    assert.strictEqual(VisMap.selectSlice(sim, 'ext_coef_C', { fdsSlcIndex: 2 }), sim.slices[2]);
    // A vertical slice is none to evaluate a floor plan on
    assert.throws(() => read({ fdsSlcIndex: 0 }), { ...valueError, message: /not horizontal/ });

    // The ID selects a named slice
    const named = sliceOrderSim({ ids: true });
    assert.strictEqual(read({ fdsSlcId: 'level_1' }, named).slc.extent[2][0], 0.75);
    assert.throws(() => read({ fdsSlcId: 'cellar' }, named), { ...valueError, message: /'cellar'.*\n.*\n.*\[1\] level_3: SOOT EXTINCTION COEFFICIENT, z = 2\.75 m/ });

    // Without a slice of the quantity the message lists what there is
    vis = new VisMap();
    vis.quantity = 'OD_C';
    assert.throws(() => vis.readFdsData(sim), { ...valueError, message: /SOOT OPTICAL DENSITY.*\n\s+\[0\] \(no ID\): SOOT EXTINCTION COEFFICIENT, y = 0\.00 m/ });
    vis.quantity = 'temperature';
    assert.throws(() => vis.readFdsData(sim), { ...valueError, message: /Unsupported quantity/ });
    assert.throws(() => new VisMap().readFdsData(VisMapFds.fromSmv('', 'empty.smv')), { ...valueError, message: /\(none\)/ });
    console.log('ok: the slice is selected by height, index or ID');
}

{
    // A cell-centred slice holds the values of the cells; the values FDS
    // writes for the first row and column belong to no cell
    const vis = read({ fdsSlcHeight: 0.5 });
    assert.deepStrictEqual(vis.fdsGridShape, [16, 16]);
    assert.ok(vis.allXCoords instanceof Float32Array);
    assertSame(Array.from(vis.allXCoords), axis(-1.875, 0.25, 16), 'cell centres in x');
    assertSame(Array.from(vis.allYCoords), axis(-1.875, 0.25, 16), 'cell centres in y');
    assert.deepStrictEqual(vis.extent, [[-2, 2], [-2, 2], [0.75, 0.75]]);
    assert.deepStrictEqual(vis.cellSize, [0.25, 0.25]);
    assert.deepStrictEqual(vis.getDomainExtent(), [-2, 2, -2, 2]);
    assert.deepStrictEqual(Array.from(vis.fdsTimePoints), SIM_TIMES);
    const extco = vis.getExtcoArrayAtTime(10.0);
    for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) assert.strictEqual(extco[i + 16 * j], Math.fround(extcoOfCell(i + 1, j + 1, 1, 2)));
    }

    // The data of the FDS time step closest to a time is used; of two
    // equally close ones the later, as in fdsreader
    const at = time => vis.getExtcoArrayAtTime(time)[0];
    const frame = t => Math.fround(extcoOfCell(1, 1, 1, t));
    assert.deepStrictEqual([-3, 0, 2.4, 2.5, 2.6, 7.4, 19, 20, 500].map(at), [0, 0, 0, 1, 1, 1, 4, 4, 4].map(frame));
    assert.strictEqual(vis.getLocalVisibility(10.0, -1.9, -1.9, 3), Math.min(3 / frame(2), 30));

    // Optical density is converted with K = OD * ln(10); a slice selected by
    // index is treated as the quantity that is set, whatever it holds
    const density = new VisMap();
    density.quantity = 'OD_C0.9H0.1';
    density.readFdsData(sliceOrderSim(), { fdsSlcIndex: 3 });
    assert.strictEqual(density.getExtcoArrayAtTime(10.0)[0], frame(2) * Math.log(10));
    const soot = ['SOOT OPTICAL DENSITY', 'OD_C0.9H0.1', '1/m'];
    density.readFdsData(sliceOrderSim({ quantity: soot }), { fdsSlcHeight: 0.5 });
    assert.strictEqual(density.slc.quantity, 'SOOT OPTICAL DENSITY');
    assert.strictEqual(density.getExtcoArrayAtTime(10.0)[0], frame(2) * Math.log(10));

    // Reading a simulation supersedes a uniform field, and the other way round
    const both = new VisMap();
    both.setUniformExtco(0.5);
    both.readFdsData(sliceOrderSim(), { fdsSlcHeight: 0.5 });
    assert.strictEqual(both.getExtcoArrayAtTime(10.0)[0], frame(2));
    both.setUniformExtco(0.25);
    assert.strictEqual(both.slc, null);
    assert.ok(both.getExtcoArrayAtTime(10.0).every(k => k === 0.25));
    assert.deepStrictEqual(both.fdsGridShape, [16, 16], 'the grid of the simulation stays');

    // The files of the slice have to be handed over first
    const unread = VisMapFds.fromSmv(smvText([{ id: 'mesh', ijk: [16, 16, 12], xb: [-2, 2, -2, 2, 0, 3] }],
        [{ type: 'SLCC', mesh: 1, index: 1, indices: [0, 16, 0, 16, 3, 3], file: 'so_1_1.sf', quantity: EXT }]));
    assert.throws(() => new VisMap().readFdsData(unread), { ...stateError, message: /so_1_1\.sf/ });
    console.log('ok: a cell-centred slice gives the extinction coefficient of the cells');
}

{
    // Obstructions of the simulation count where their z range includes the
    // evaluation height - the height that was asked for, not the one of the slice
    const sim = sliceOrderSim({ obsts: [
        [-1, -0.5, -2, 2, 0, 3],       // wall over the full height
        [0.5, 1, -1, 1, 2.2, 3],       // lintel above a door
        [1.5, 1.5, -2, 2, 0, 3],       // no thickness, covers no cell
        [-2, 2, 1.5, 1.75, 0, 0.5],    // low wall
    ] });
    assert.deepStrictEqual(sim.obstructions.map(o => o.xb[0]), [-1, 0.5, 1.5, -2]);
    const cellsAt = height => sum(read({ fdsSlcHeight: height }, sim).obstructionsArray);
    assert.strictEqual(cellsAt(2.0), 2 * 16);
    assert.strictEqual(cellsAt(2.5), 2 * 16 + 2 * 8);
    assert.strictEqual(cellsAt(0.4), 2 * 16 + 16 - 2);
    assert.strictEqual(read({ fdsSlcHeight: 2.0 }, sim).slc.extent[2][0], 1.75);

    // Manual obstructions are kept when the simulation is read again
    const vis = read({ fdsSlcHeight: 2.0 }, sim);
    vis.addVisualHole(-1, -0.5, 0, 0.5);
    vis.addVisualObstruction(0, 0.25, 0, 0.25);
    const expected = vis.obstructionsArray.slice();
    assert.strictEqual(sum(expected), 2 * 16 - 4 + 1);
    vis.readFdsData(sim, { fdsSlcHeight: 2.0 });
    assertSame(vis.obstructionsArray, expected, 'manual obstructions after reading again');

    // The wall conceals the sign behind it
    vis.addSign(1, -1.5, 0.3, 3, null);
    vis.setTimePoints([0]);
    vis.computeAll();
    assert.strictEqual(vis.signIsVisible(0, -1.9, -1.0, 1), true);
    assert.strictEqual(vis.signIsVisible(0, 1.0, 1.9, 1), false);
    assert.strictEqual(vis.signIsVisible(0, 1.0, 0.3, 1), true, 'through the hole in the wall');
    console.log('ok: obstructions of the simulation are taken at the evaluation height');
}

{
    // Several meshes: the slice of each one goes to its place in one grid
    const xbOf = (ix, iy) => [-2 + 2 * ix, 2 * ix, -2 + 2 * iy, 2 * iy, 0, 3];
    const tiled = (tiles, type = 'SLCC', valueAt = null) => {
        const meshes = tiles.map(([ix, iy]) => ({ id: 'mesh_' + ix + iy, ijk: [8, 8, 12], xb: xbOf(ix, iy) }));
        const slices = tiles.map((tile, m) => ({ type, mesh: m + 1, index: 1, indices: [0, 8, 0, 8, 3, 3],
            file: 'tile_' + (m + 1) + '_1.sf', quantity: EXT }));
        const sim = VisMapFds.fromSmv(smvText(meshes, slices), 'tiled.smv');
        tiles.forEach(([ix, iy], m) => sim.addSliceFile(slices[m].file, FdsSliceReader.parse(buildSliceFileWith(...EXT,
            slices[m].indices, SIM_TIMES, valueAt ? (i, j, k, t) => valueAt(i + 8 * ix, j + 8 * iy, m)
                : (i, j, k, t) => (i === 0 || j === 0) ? GHOST : extcoOfCell(i + 8 * ix, j + 8 * iy, 1, t)))));
        return sim;
    };
    const single = read({ fdsSlcHeight: 0.5 });
    // 2 x 2 meshes, in an order that is not the one of their positions
    const quad = read({ fdsSlcHeight: 0.5 }, tiled([[1, 1], [0, 0], [1, 0], [0, 1]]));
    assert.deepStrictEqual(quad.fdsGridShape, [16, 16]);
    assertSame(Array.from(quad.allXCoords), Array.from(single.allXCoords), 'cell centres of four meshes');
    assert.deepStrictEqual(quad.extent, single.extent);
    assertSame(quad.getExtcoArrayAtTime(15.0), single.getExtcoArrayAtTime(15.0), 'extinction coefficients of four meshes');

    // Cells that no mesh covers hold no value, and no sight line passes them
    const corner = read({ fdsSlcHeight: 0.5 }, tiled([[0, 0], [1, 0], [0, 1]]));
    assert.deepStrictEqual(corner.fdsGridShape, [16, 16]);
    const extco = corner.getExtcoArrayAtTime(0.0);
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) assert.strictEqual(Number.isNaN(extco[i + 16 * j]), i >= 8 && j >= 8);
    corner.addSign(1, -1.9, -1.9, 3, null);
    corner.setTimePoints([0]);
    corner.computeAll();
    assert.strictEqual(corner.signIsVisible(0, 1.9, -1.9, 1), true);
    assert.strictEqual(corner.signIsVisible(0, 1.9, 1.9, 1), false);
    assert.ok(Number.isNaN(corner.getVisibilityToSign(0, 1.9, 1.9, 1)));

    // Values on the grid nodes: the node on the border of two meshes is
    // taken from the mesh that starts there, as fdsreader does
    const nodes = read({ fdsSlcIndex: 0 }, tiled([[0, 0], [1, 0]], 'SLCF', (i, j, m) => 100 * m + i + j / 100));
    assert.deepStrictEqual(nodes.fdsGridShape, [17, 9]);
    assertSame(Array.from(nodes.allXCoords), axis(-2, 0.25, 17), 'grid nodes in x');
    assertSame(Array.from(nodes.allYCoords), axis(-2, 0.25, 9), 'grid nodes in y');
    const values = nodes.getExtcoArrayAtTime(0.0);
    for (let j = 0; j < 9; j++) {
        for (let i = 0; i < 17; i++) assert.strictEqual(values[i + 17 * j], Math.fround((i >= 8 ? 100 : 0) + i + j / 100));
    }

    // Meshes of different cell sizes make no grid a vismap could use
    const coarse = VisMapFds.fromSmv(smvText(
        [{ id: 'fine', ijk: [8, 8, 12], xb: xbOf(0, 0) }, { id: 'coarse', ijk: [4, 8, 12], xb: xbOf(1, 0) }],
        [{ type: 'SLCC', mesh: 1, index: 1, indices: [0, 8, 0, 8, 3, 3], file: 'a.sf', quantity: EXT },
            { type: 'SLCC', mesh: 2, index: 1, indices: [0, 4, 0, 8, 3, 3], file: 'b.sf', quantity: EXT }]));
    coarse.addSliceFile('a.sf', FdsSliceReader.parse(buildSliceFileWith(...EXT, [0, 8, 0, 8, 3, 3], [0], () => 0)));
    coarse.addSliceFile('b.sf', FdsSliceReader.parse(buildSliceFileWith(...EXT, [0, 4, 0, 8, 3, 3], [0], () => 0)));
    assert.throws(() => new VisMap().readFdsData(coarse), { ...valueError, message: /not equally wide in x/ });
    console.log('ok: the slices of several meshes are put together');
}

{
    // The synthetic simulation of the slice tests: a temperature slice on
    // the nodes of 2 x 2 meshes, selected by index and taken for smoke
    const example = buildExampleSim();
    const sim = VisMapFds.fromSmv(example.smvText, example.smvName);
    assert.strictEqual(sim.meshes.length, 4);
    assert.strictEqual(sim.slices.length, 1);
    assert.strictEqual(VisMapFds.describeSlice(sim.slices[0]), '[0] (no ID): TEMPERATURE, z = 1.20 m');
    for (const file of example.sliceFiles) sim.addSliceFile(file.name, FdsSliceReader.parse(file.buffer));
    const vis = new VisMap();
    vis.readFdsData(sim, { fdsSlcIndex: 0 });
    assert.deepStrictEqual(vis.fdsGridShape, [21, 21]);
    assert.deepStrictEqual(Array.from(vis.fdsTimePoints), TIMES);
    TIMES.forEach((time, t) => {
        const values = vis.getExtcoArrayAtTime(time);
        for (let j = 0; j < 21; j++) {
            for (let i = 0; i < 21; i++) assert.strictEqual(values[i + 21 * j], Math.fround(temperatureAt(i * 0.2, j * 0.2, t)));
        }
    });
    console.log('ok: the synthetic multimesh room reads as a 21 x 21 grid');
}

console.log('vismap tests passed');
