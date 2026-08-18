import assert from 'node:assert';
import fs from 'node:fs';
import { buildExampleSim, temperatureAt, TIMES } from './make-test-sim.mjs';

// Load the non-module globals into a sandbox scope.
const rendererSrc = fs.readFileSync(new URL('../js/slice-renderer.js', import.meta.url), 'utf8');
const sandbox = {};
new Function('window', rendererSrc)(sandbox);
const { SliceFiles, SliceUtil } = sandbox;

const readerSrc = fs.readFileSync(new URL('../js/slice-reader.js', import.meta.url), 'utf8');
const { FdsSliceReader } = new Function(readerSrc + '\nreturn { FdsSliceReader };')();

// ── Helpers ──────────────────────────────────────────────────────────────
function fakePart(meshIndex, fileName, dims, indices, fillFn) {
    const valueCount = dims[0] * dims[1] * dims[2];
    return {
        meshIndex,
        fileName,
        dataset: {
            quantity: 'TEMPERATURE', shortName: 'temp', units: 'C',
            dims: dims.slice(), indices: Object.assign({}, indices), valueCount,
            frames: [{ time: 0 }],
            getFrameData() {
                const out = new Float32Array(valueCount);
                for (let j = 0; j < dims[1]; j++)
                    for (let i = 0; i < dims[0]; i++)
                        out[i + dims[0] * j] = fillFn(i, j);
                return out;
            },
        },
    };
}

// ── fdsContextFromSmvText ────────────────────────────────────────────────
{
    const smv = [
        'GRID   mesh_a',
        '    2    2    2    0',
        '',
        'PDIM',
        '  0.0  1.0  0.0  1.0  0.0  1.0  0.0  0.0  0.0',
        '',
        'TRNX',
        '    0',
        '    0  0.00',
        '    1  0.40', // stretched: not the linear 0.5
        '    2  1.00',
        '',
        'TRNY',
        '    0',
        '    0  0.00',
        '    1  0.50',
        '    2  1.00',
        '',
        'TRNZ',
        '    0',
        '    0  0.00',
        '    1  0.50',
        '    2  1.00',
        '',
        'GRID   mesh_b',
        '    2    2    2    0',
        '',
        'PDIM',
        '  1.0  2.0  0.0  1.0  0.0  1.0  0.0  0.0  0.0',
        '',
    ].join('\n');
    const ctx = SliceFiles.fdsContextFromSmvText(smv, 'test.smv');
    assert.ok(ctx, 'smv context parsed');
    assert.strictEqual(ctx.meshes.length, 2);
    assert.deepStrictEqual(ctx.meshes[0].ijk, [2, 2, 2]);
    assert.deepStrictEqual(ctx.meshes[0].xb, [0, 1, 0, 1, 0, 1]);
    assert.deepStrictEqual(ctx.meshes[0].trn[0], [0, 0.4, 1]);
    assert.deepStrictEqual(ctx.meshes[1].xb, [1, 2, 0, 1, 0, 1]);
    assert.strictEqual(ctx.meshes[1].trn[0], null);
    console.log('ok: fdsContextFromSmvText parses GRID/PDIM/TRN');
}

// ── 1D stitch (two meshes side by side along X) ──────────────────────────
{
    const ctx = {
        fileName: 'x', meshes: [
            { id: 'm1', ijk: [2, 2, 2], xb: [0, 1, 0, 1, 0, 1] },
            { id: 'm2', ijk: [2, 2, 2], xb: [1, 2, 0, 1, 0, 1] },
        ],
    };
    const indices = { i1: 0, i2: 2, j1: 0, j2: 2, k1: 1, k2: 1 };
    const parts = [
        fakePart(1, 'c_1_1.sf', [3, 3, 1], indices, (i, j) => 100 + 10 * j + i),
        fakePart(2, 'c_2_1.sf', [3, 3, 1], indices, (i, j) => 200 + 10 * j + i),
    ];
    const ds = SliceFiles.combineSliceDatasets(parts, ctx);
    assert.deepStrictEqual(ds.dims, [5, 3, 1]);
    const v = ds.getFrameData(0);
    assert.strictEqual(v[0], 100);       // m1 (0,0)
    assert.strictEqual(v[2], 102);       // shared boundary node: m1 wins
    assert.strictEqual(v[3], 201);       // m2 (1,0)
    assert.strictEqual(v[4 + 5 * 2], 222); // m2 (2,2)
    console.log('ok: 1D stitch along X');
}

// ── 2D stitch (2×2 mesh tiling in the XY plane) ──────────────────────────
{
    const ctx = {
        fileName: 'x', meshes: [
            { id: 'm1', ijk: [2, 2, 2], xb: [0, 1, 0, 1, 0, 1] },
            { id: 'm2', ijk: [2, 2, 2], xb: [1, 2, 0, 1, 0, 1] },
            { id: 'm3', ijk: [2, 2, 2], xb: [0, 1, 1, 2, 0, 1] },
            { id: 'm4', ijk: [2, 2, 2], xb: [1, 2, 1, 2, 0, 1] },
        ],
    };
    const indices = { i1: 0, i2: 2, j1: 0, j2: 2, k1: 1, k2: 1 };
    const parts = [1, 2, 3, 4].map(m =>
        fakePart(m, 'c_' + m + '_1.sf', [3, 3, 1], indices, (i, j) => 100 * m + 10 * j + i));
    const ds = SliceFiles.combineSliceDatasets(parts, ctx);
    assert.deepStrictEqual(ds.dims, [5, 5, 1]);
    const v = ds.getFrameData(0);
    const at = (i, j) => v[i + 5 * j];
    assert.strictEqual(at(0, 0), 100);   // m1 (0,0)
    assert.strictEqual(at(4, 0), 202);   // m2 (2,0)
    assert.strictEqual(at(0, 4), 320);   // m3 (0,2)
    assert.strictEqual(at(4, 4), 422);   // m4 (2,2)
    assert.strictEqual(at(2, 2), 122);   // interior corner: m1 wins
    assert.strictEqual(at(3, 3), 411);   // m4 (1,1)
    // Flat per-mesh parts exposed for physical placement
    assert.strictEqual(ds.parts.length, 4);
    assert.ok(ds.parts.every(p => typeof p.meshIndex === 'number'));

    const view = SliceUtil.buildPlaneView(ds, 0, ctx);
    assert.strictEqual(view.kind, 'xy');
    assert.ok(view.physical, 'physical placement applied');
    assert.strictEqual(view.physical.x0, 0);
    assert.strictEqual(view.physical.x1, 2);
    assert.strictEqual(view.physical.y0, 0);
    assert.strictEqual(view.physical.y1, 2);
    assert.strictEqual(view.physical.slabOffset, 0.5); // k=1 of 2 cells over 0..1
    console.log('ok: 2D stitch of a 2x2 mesh tiling + physical placement');
}

// ── Integration: synthetic multimesh room (tests/make-test-sim.mjs) ──────
// A 4×4×2.4 m room split into 2×2 meshes, a Gaussian "fire" hot spot in the
// south-west corner and 3 time steps, generated as real .smv text and real
// Fortran-record .sf binaries — exercises reader + context + stitch together.
{
    const sim = buildExampleSim();
    const ctx = SliceFiles.fdsContextFromSmvText(sim.smvText, sim.smvName);
    assert.ok(ctx, 'smv context parsed');
    assert.strictEqual(ctx.meshes.length, 4);
    assert.deepStrictEqual(ctx.meshes[0].ijk, [10, 10, 6]);
    assert.deepStrictEqual(ctx.meshes[3].xb, [2, 4, 2, 4, 0, 2.4]);

    const parts = sim.sliceFiles.map(f => ({
        meshIndex: f.meshIndex,
        fileName: f.name,
        dataset: FdsSliceReader.parse(f.buffer),
    }));
    assert.deepStrictEqual(parts[0].dataset.dims, [11, 11, 1]);
    assert.deepStrictEqual(parts[0].dataset.frames.map(f => f.time), TIMES);

    const ds = SliceFiles.combineSliceDatasets(parts, ctx);
    // 2×2 meshes of 11×11 planes, shared boundary nodes deduped
    assert.deepStrictEqual(ds.dims, [21, 21, 1]);
    assert.strictEqual(ds.frames.length, TIMES.length);

    // Every stitched node must match the analytic temperature field.
    const last = TIMES.length - 1;
    const v = ds.getFrameData(last);
    for (let j = 0; j <= 20; j++) {
        for (let i = 0; i <= 20; i++) {
            const expected = temperatureAt(i * 0.2, j * 0.2, last);
            assert.ok(Math.abs(v[i + 21 * j] - expected) < 1e-3,
                'value at (' + i + ',' + j + '): ' + v[i + 21 * j] + ' vs ' + expected);
        }
    }
    // Hot spot sits at the fire location (x=0.6, y=0.6 → node 3,3) …
    let max = -Infinity, maxIdx = -1;
    for (let i = 0; i < v.length; i++) if (v[i] > max) { max = v[i]; maxIdx = i; }
    assert.strictEqual(maxIdx % 21, 3);
    assert.strictEqual(Math.floor(maxIdx / 21), 3);
    assert.ok(Math.abs(max - (20 + 300)) < 1e-3);
    // … and the first frame is uniformly ambient.
    assert.ok(Array.from(ds.getFrameData(0)).every(x => Math.abs(x - 20) < 1e-3));

    const view = SliceUtil.buildPlaneView(ds, 0, ctx);
    assert.strictEqual(view.kind, 'xy');
    assert.ok(view.physical, 'physical placement applied');
    assert.strictEqual(view.physical.x0, 0);
    assert.strictEqual(view.physical.x1, 4);
    assert.strictEqual(view.physical.y0, 0);
    assert.strictEqual(view.physical.y1, 4);
    assert.ok(Math.abs(view.physical.slabOffset - 1.2) < 1e-9); // k=3, dz=0.4

    // Default color range = global min/max across all frames (like
    // Smokeview's research mode): ambient 20 at t=0 up to the peak 320 at
    // the last time step — NOT a per-frame percentile band.
    const range = SliceUtil.computeGlobalRange(ds);
    assert.ok(Math.abs(range.min - 20) < 1e-3, 'global min ~20, got ' + range.min);
    assert.ok(Math.abs(range.max - 320) < 1e-3, 'global max ~320, got ' + range.max);

    // The percentile variant trims the rare hot-spot tail: still floored at
    // ambient, but the 98th percentile sits well below the 320 peak.
    const robust = SliceUtil.computeGlobalPercentileRange(ds, 0.02, 0.98);
    assert.ok(Math.abs(robust.min - 20) < 1e-3, 'percentile min ~20, got ' + robust.min);
    assert.ok(robust.max > 20 && robust.max < 319, 'percentile max inside (20, 319), got ' + robust.max);
    console.log('ok: synthetic multimesh room stitches to 21x21 spanning 4x4 m at z=1.2');
}

console.log('slice-stitch tests passed');
