import assert from 'node:assert';
import fs from 'node:fs';

// charts-panel.js is an IIFE that publishes its pure helpers on window.
const src = fs.readFileSync(new URL('../js/charts-panel.js', import.meta.url), 'utf8');
const win = {};
new Function('window', src)(win);
const { niceScale, tickValues } = win.chartsPanelTestHooks;

// Regular axis: ticks land on the nice grid and cover the data range.
assert.deepStrictEqual(tickValues(niceScale(0, 10, 7)), [0, 2, 4, 6, 8, 10], 'regular 0..10 axis');

// Tiny span on a large value: step is ~2e-8 at 101325, so accumulating
// y += step with toPrecision(10) never advances and the old loop hung.
const ticks = tickValues(niceScale(101325, 101325.0000001, 7));
assert.ok(ticks.length >= 2 && ticks.length <= 12, `tick count sane, got ${ticks.length}`);
for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i] > ticks[i - 1], `ticks strictly increasing at index ${i}`);
}
assert.ok(ticks[0] <= 101325 && ticks[ticks.length - 1] >= 101325.0000001, 'ticks cover the data range');

console.log('charts: all assertions passed');
