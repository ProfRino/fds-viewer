import assert from 'node:assert';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// charts-panel.js is an IIFE that publishes its pure helpers on window.
const src = fs.readFileSync(new URL('../js/charts-panel.js', import.meta.url), 'utf8');
const win = {};
new Function('window', src)(win);
const { niceScale, tickValues, parseCSVData, plotIndices } = win.chartsPanelTestHooks;

// Regular axis: ticks land on the nice grid and cover the data range.
assert.deepStrictEqual(tickValues(niceScale(0, 10, 7)), [0, 2, 4, 6, 8, 10], 'regular 0..10 axis');

// Tiny span on a large value: step is ~2e-8 at 101325, so accumulating
// y += step with toPrecision(10) never advances and the old loop hung.
// A synchronous hang cannot be stopped from inside the same process, so this
// case runs in a child process with a hard timeout: a regression fails here.
const tinySpanProbe = `
    const fs = require('fs');
    const src = fs.readFileSync(${JSON.stringify(new URL('../js/charts-panel.js', import.meta.url).pathname)}, 'utf8');
    const win = {};
    new Function('window', src)(win);
    const { niceScale, tickValues } = win.chartsPanelTestHooks;
    const ticks = tickValues(niceScale(101325, 101325.0000001, 7));
    process.stdout.write(JSON.stringify(ticks));
`;
const probe = spawnSync(process.execPath, ['-e', tinySpanProbe], { timeout: 2000, encoding: 'utf8' });
assert.ok(!(probe.error && probe.error.code === 'ETIMEDOUT'), 'tick generation for a tiny span hung (killed after 2 s): regression in tickValues');
assert.strictEqual(probe.error, undefined, `tick probe could not start: ${probe.error}`);
assert.strictEqual(probe.signal, null, `tick probe killed by ${probe.signal}`);
assert.strictEqual(probe.status, 0, `tick probe exited with status ${probe.status}: ${probe.stderr}`);
const ticks = JSON.parse(probe.stdout);
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

// Downsampling above 5000 points must keep a short peak that falls between
// stride samples (here a single spike at index 12345 of 20000).
const N = 20000;
const spikeTime = Array.from({ length: N }, (_, i) => i * 0.01);
const spikeVals = Array.from({ length: N }, () => 0);
spikeVals[12345] = 1000;
const picked = plotIndices(spikeTime, spikeVals, N);
assert.ok(picked.includes(12345), 'peak sample survives downsampling');
assert.ok(picked.length < N, 'long series is actually downsampled');
for (let i = 1; i < picked.length; i++) {
    assert.ok(picked[i] > picked[i - 1], 'picked indices stay in time order');
}

// Short series is drawn unchanged.
assert.deepStrictEqual(plotIndices([0, 1, 2], [5, 6, 7], 3), [0, 1, 2], 'short series not decimated');

console.log('charts: all assertions passed');

// Hover lookup: nearestIndex (binary search) must agree with a brute-force
// scan on sorted time data, including targets before, between and after samples.
const { nearestIndex } = win.chartsPanelTestHooks;
const tsorted = Array.from({ length: 500 }, (_, i) => i * 0.37 + 0.001 * (i % 7));
const brute = (arr, t) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - t); if (d < bd) { bd = d; bi = i; } }
    return bi;
};
for (const t of [-5, 0, 0.2, 10.4, 50, 123.456, 184, 999]) {
    assert.strictEqual(nearestIndex(tsorted, t), brute(tsorted, t), `nearestIndex matches brute force at t=${t}`);
}
console.log('charts hover lookup: nearestIndex matches brute force');

// Escaping: filenames and channel keys go into attributes and markup, so
// quotes and angle brackets must not break out of them.
const { esc } = win.chartsPanelTestHooks;
assert.strictEqual(esc('a"b<c>&d'), 'a&quot;b&lt;c&gt;&amp;d', 'esc covers quote, angle brackets and ampersand');
const key = 'weird"name.csv_1700000000::3';
const markup = `<span data-key="${esc(key)}"></span>`;
assert.ok(!/data-key="[^"]*"[^>]*"/.test(markup), 'escaped key cannot close the attribute early');
console.log('charts escaping: esc() covers quotes and brackets');
