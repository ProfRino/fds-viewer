/**
 * Geometry helpers of the Vismap overlay (js/vismap-overlay.js): the flat
 * shapes routes are drawn with. They are plain coordinate math, so they run
 * without THREE.
 */
import assert from 'node:assert';
import fs from 'node:fs';

const sandbox = {};
new Function('window', fs.readFileSync(new URL('../js/vismap-overlay.js', import.meta.url), 'utf8'))(sandbox);
const { VisMapOverlay } = sandbox;

const length = ([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1]);
/** Area of a triangle, twice. */
const area2 = ([a, b, c]) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));

// ── A straight band ──────────────────────────────────────────────────────
{
    const band = VisMapOverlay._band([1, 1], [4, 5], 0.2, '#123456');
    assert.strictEqual(band.length, 2);
    assert.ok(band.every(triangle => triangle.color === '#123456'));
    // Two triangles that make up length x width
    assert.ok(Math.abs((area2(band[0].points) + area2(band[1].points)) / 2 - 5 * 0.2) < 1e-12);
    // No band between two points at the same position
    assert.deepStrictEqual(VisMapOverlay._band([2, 2], [2, 2], 0.2, '#000'), []);
    console.log('ok: a band is two triangles of its length and width');
}

// ── Dashed line along a route ────────────────────────────────────────────
{
    // Area of all dashes / width = length drawn; dash 0.3, gap 0.2
    const drawn = (waypoints, dash = 0.3, gap = 0.2, width = 0.1) =>
        VisMapOverlay._dashes(waypoints, dash, gap, width, '#000').reduce((sum, t) => sum + area2(t.points) / 2, 0) / width;

    // 10 m in periods of 0.5 m: 20 dashes of 0.3 m
    assert.ok(Math.abs(drawn([[0, 0], [10, 0]]) - 6) < 1e-9);
    // The dashes run on across the corners instead of starting anew at each
    const bent = [[0, 0], [1.1, 0], [1.1, 2.3], [4.7, 2.3]];
    assert.ok(Math.abs(drawn(bent) - drawn([[0, 0], [7, 0]])) < 1e-9);
    // A dash that a corner cuts in two keeps its length
    assert.ok(Math.abs(drawn([[0, 0], [0.15, 0], [0.15, 0.15]]) - 0.3) < 1e-9);

    // Lengths that are no multiple of the period end, whatever the rounding
    for (const [dash, gap] of [[0.2835, 0.189], [0.1, 0.1], [1 / 3, 1 / 7], [0.45 * 0.63, 0.3 * 0.63]]) {
        const route = [[1, 9], [4, 7], [7, 5.5], [9.5, 4.2], [11, 4.2], [15, 6], [17, 9.5], [17, 9.5]];
        const total = route.slice(1).reduce((sum, q, k) => sum + length([route[k], q]), 0);
        const dashes = drawn(route, dash, gap);
        assert.ok(dashes > 0 && dashes <= total);
        assert.ok(Math.abs(dashes - total * dash / (dash + gap)) <= dash);
    }
    console.log('ok: dashes follow a route across its corners');
}

// ── Arrow head at the end of a route ─────────────────────────────────────
{
    const head = VisMapOverlay._head([0, 0], [3, 0], 0.4, '#000');
    assert.deepStrictEqual(head.points[0], [3.4, 0]);                  // the tip, in the direction of the section
    assert.ok(head.points.slice(1).every(([x]) => Math.abs(x - 2.8) < 1e-12));
    console.log('ok: the arrow head points along the last section');
}

// ── Name of a route ──────────────────────────────────────────────────────
{
    const place = (waypoints, occupied) => VisMapOverlay.prototype._namePosition.call({ markerSize: 0.5 }, waypoints, occupied);
    const route = [[0, 0], [2, 0], [2, 10]];
    // The middle of the longest section
    assert.deepStrictEqual(place(route, []), [2, 5]);
    // The next place along it if a sign is in the way, then the shorter section
    assert.deepStrictEqual(place(route, [[2, 5.2]]), [2, 2.5]);
    assert.deepStrictEqual(place(route, [[2, 5], [2, 2.5], [2, 7.5]]), [1, 0]);
    // The first place if every one is taken
    assert.deepStrictEqual(place([[0, 0], [1, 0]], [[0.5, 0], [0.25, 0], [0.75, 0]]), [0.5, 0]);
    console.log('ok: the name of a route keeps clear of the signs');
}

console.log('vismap-overlay tests passed');
