import assert from 'node:assert';
import fs from 'node:fs';

// charts-panel.js is an IIFE that publishes its pure helpers on window.
const src = fs.readFileSync(new URL('../js/charts-panel.js', import.meta.url), 'utf8');
const win = {};
new Function('window', src)(win);
const { niceScale, tickValues, parseCSVData } = win.chartsPanelTestHooks;

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

// Semicolon-separated file with decimal commas (European export). The
// separator must come from the file, not from the decimal option.
const semi = 's;C\nTime;TC\n0,5;20,5\n1,0;21,0\n';
const dataComma = parseCSVData(semi, { decimalSep: ',' });
assert.ok(dataComma, 'semicolon file with decimal comma parses');
assert.deepStrictEqual(dataComma.headers, ['Time', 'TC'], 'semicolon header splits into two columns');
assert.deepStrictEqual(dataComma.columns[0], [0.5, 1], 'decimal comma parsed in time column');
assert.deepStrictEqual(dataComma.columns[1], [20.5, 21], 'decimal comma parsed in value column');
assert.strictEqual(dataComma.hasTime, true);

// Same file with the default decimal '.' must still split on ';'.
const dataDot = parseCSVData(semi, { decimalSep: '.' });
assert.ok(dataDot, 'semicolon file parses with default decimal option');
assert.strictEqual(dataDot.headers.length, 2, 'semicolon file is not collapsed into one column');

// Unparseable input is reported as null, not as a silent empty dataset.
assert.strictEqual(parseCSVData('just one line', { decimalSep: '.' }), null, 'garbage input returns null');

console.log('charts: all assertions passed');
