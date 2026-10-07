import assert from 'node:assert';
import fs from 'node:fs';
import { buildConstantSliceFile } from './make-test-sim.mjs';

// Load the non-module globals into a sandbox scope.
const rendererSrc = fs.readFileSync(new URL('../js/slice-renderer.js', import.meta.url), 'utf8');
const sandbox = {};
new Function('window', rendererSrc)(sandbox);
const { SliceFiles } = sandbox;

const readerSrc = fs.readFileSync(new URL('../js/slice-reader.js', import.meta.url), 'utf8');
const { FdsSliceReader } = new Function(readerSrc + '\nreturn { FdsSliceReader };')();
// describeSliceGroups reads each group's header through the global reader.
globalThis.FdsSliceReader = FdsSliceReader;

// ── Fixture: two meshes side by side, slices that touch only some meshes ──
// Mirrors a real FDS 6 run of
//   &MESH IJK=10,10,10, XB=0,1,0,1,0,1 /
//   &MESH IJK=10,10,10, XB=1,2,0,1,0,1 /
//   &SLCF PBX=1.55, QUANTITY='TEMPERATURE' /                       (mesh 2 only)
//   &SLCF PBZ=0.55, QUANTITY='TEMPERATURE' /                       (both meshes)
//   &SLCF PBY=0.55, QUANTITY='TEMPERATURE', CELL_CENTERED=.TRUE. / (both meshes)
// FDS numbers slice files per mesh, so two_1_1.sf is the PBZ slice while
// two_2_1.sf is the PBX slice. The SLCF/SLCC records below are verbatim
// from the .smv that run wrote.
function gridBlock(id, x0) {
    const lines = ['GRID   ' + id, '   10   10   10    0', '', 'PDIM',
        '  ' + [x0, x0 + 1, 0, 1, 0, 1, 0, 0, 0].map(v => v.toFixed(5)).join('  '), ''];
    for (const [axis, origin] of [['X', x0], ['Y', 0], ['Z', 0]]) {
        lines.push('TRN' + axis, '    0');
        for (let i = 0; i <= 10; i++) lines.push(String(i).padStart(5) + (origin + i / 10).toFixed(5).padStart(14));
        lines.push('');
    }
    return lines;
}

const SMV = [
    ...gridBlock('mesh_1', 0),
    ...gridBlock('mesh_2', 1),
    'SLCF     1 # STRUCTURED &     0    10     0    10     6     6 !      2      0      3',
    ' two_1_1.sf', ' TEMPERATURE', ' temp', ' C',
    'SLCC     1 # STRUCTURED &     0    10     6     6     0    10 !      3      1      2',
    ' two_1_2.sf', ' TEMPERATURE', ' temp', ' C',
    'SLCF     2 # STRUCTURED &     6     6     0    10     0    10 !      1      0      1',
    ' two_2_1.sf', ' TEMPERATURE', ' temp', ' C',
    'SLCF     2 # STRUCTURED &     0    10     0    10     6     6 !      2      0      3',
    ' two_2_2.sf', ' TEMPERATURE', ' temp', ' C',
    'SLCC     2 # STRUCTURED &     0    10     6     6     0    10 !      3      1      2',
    ' two_2_3.sf', ' TEMPERATURE', ' temp', ' C',
].join('\n');

const TIMES = [0, 1];
const PBX = [6, 6, 0, 10, 0, 10];
const PBZ = [0, 10, 0, 10, 6, 6];
const PBY = [0, 10, 6, 6, 0, 10];

function sliceFile(name, indices, value) {
    return new File([buildConstantSliceFile('TEMPERATURE', 'temp', 'C', indices, TIMES, value)], name);
}

const FILES = [
    sliceFile('two_1_1.sf', PBZ, 100),
    sliceFile('two_1_2.sf', PBY, 300),
    sliceFile('two_2_1.sf', PBX, 500),
    sliceFile('two_2_2.sf', PBZ, 200),
    sliceFile('two_2_3.sf', PBY, 400),
];

function membership(groups) {
    return groups.map(g => g.items.map(it => it.file.name + '@' + it.info.meshIndex));
}

// ── sliceRecordsFromSmvText ──────────────────────────────────────────────
{
    const records = SliceFiles.sliceRecordsFromSmvText(SMV);
    assert.strictEqual(records.length, 5);
    assert.deepStrictEqual(
        records.map(r => [r.type, r.meshIndex, r.sliceIndex, r.fileName, r.quantity, r.units]),
        [
            ['SLCF', 1, 2, 'two_1_1.sf', 'TEMPERATURE', 'C'],
            ['SLCC', 1, 3, 'two_1_2.sf', 'TEMPERATURE', 'C'],
            ['SLCF', 2, 1, 'two_2_1.sf', 'TEMPERATURE', 'C'],
            ['SLCF', 2, 2, 'two_2_2.sf', 'TEMPERATURE', 'C'],
            ['SLCC', 2, 3, 'two_2_3.sf', 'TEMPERATURE', 'C'],
        ]);
    assert.deepStrictEqual(records[2].indices, PBX);
    // A record line with an %ID before '&' still parses.
    const withId = SliceFiles.sliceRecordsFromSmvText(
        'SLCF     1 # STRUCTURED %HALL &     0    10     0    10     6     6 !      4      0      3\n' +
        ' x_1_1.sf\n SOOT VISIBILITY\n vis\n m\n');
    assert.deepStrictEqual([withId[0].sliceIndex, withId[0].fileName, withId[0].units], [4, 'x_1_1.sf', 'm']);
}

// ── Grouping by the .smv &SLCF record ────────────────────────────────────
{
    const records = SliceFiles.sliceRecordsFromSmvText(SMV);
    const groups = await SliceFiles.describeSliceGroups(FILES, records);
    assert.deepStrictEqual(groups.map(g => g.sliceIndex), [1, 2, 3]);
    assert.deepStrictEqual(membership(groups), [
        ['two_2_1.sf@2'],                    // PBX: mesh 2 only
        ['two_1_1.sf@1', 'two_2_2.sf@2'],    // PBZ: both meshes
        ['two_1_2.sf@1', 'two_2_3.sf@2'],    // PBY (cell-centred): both meshes
    ]);
    assert.strictEqual(new Set(groups.map(g => g.key)).size, 3);
    assert.ok(groups.every(g => g.header && g.header.quantity === 'TEMPERATURE'));

    // The PBZ slice spanning both meshes stitches into one plane: mesh 1's
    // values on the left, mesh 2's on the right.
    const fdsContext = SliceFiles.fdsContextFromSmvText(SMV, 'two.smv');
    const pbz = groups[1];
    const parts = [];
    for (const item of pbz.items) {
        parts.push({
            meshIndex: item.info.meshIndex,
            fileName: item.file.name,
            dataset: FdsSliceReader.parse(await item.file.arrayBuffer()),
        });
    }
    const ds = SliceFiles.combineSliceDatasets(parts, fdsContext);
    assert.deepStrictEqual(ds.dims, [21, 11, 1]);
    const frame = ds.getFrameData(TIMES.length - 1);
    assert.strictEqual(frame[0], 100);
    assert.strictEqual(frame[20], 200);
}

// ── Records listed in the .smv but missing from the folder are reported ──
{
    const records = SliceFiles.sliceRecordsFromSmvText(SMV);
    const groups = await SliceFiles.describeSliceGroups(
        FILES.filter(f => f.name !== 'two_2_2.sf'), records);
    const pbz = groups.find(g => g.sliceIndex === 2);
    assert.deepStrictEqual(membership([pbz]), [['two_1_1.sf@1']]);
    assert.deepStrictEqual(pbz.missing, ['two_2_2.sf']);
    assert.match(pbz.label, /1 of 2 files/);
    assert.strictEqual(SliceFiles.sliceGroupMissingNote(pbz), ' (1 of 2 files; missing: two_2_2.sf)');
    assert.strictEqual(SliceFiles.sliceGroupMissingNote(groups.find(g => g.sliceIndex === 1)), '');
}

// ── Files the .smv does not list are kept apart and marked ───────────────
{
    const records = SliceFiles.sliceRecordsFromSmvText(SMV);
    const extra = sliceFile('two_1_3.sf', PBX, 700);
    const groups = await SliceFiles.describeSliceGroups([...FILES, extra], records);
    assert.strictEqual(groups.length, 4);
    const listed = groups.filter(g => !g.unlisted);
    assert.deepStrictEqual(membership(listed), [
        ['two_2_1.sf@2'], ['two_1_1.sf@1', 'two_2_2.sf@2'], ['two_1_2.sf@1', 'two_2_3.sf@2'],
    ]);
    const unlisted = groups.filter(g => g.unlisted);
    assert.deepStrictEqual(membership(unlisted), [['two_1_3.sf@1']]);
    assert.strictEqual(unlisted[0].sliceIndex, 3);
    assert.match(unlisted[0].label, /Slice 3 \(not in \.smv\)/);
    assert.doesNotMatch(listed[2].label, /not in \.smv/);
    assert.strictEqual(new Set(groups.map(g => g.key)).size, 4);
}

// ── Record parsing: slice records only, file line must be a .sf ──────────
{
    const records = SliceFiles.sliceRecordsFromSmvText([
        'BNDF     1     1', ' two_1_1.bf', ' WALL TEMPERATURE', ' wall_temp', ' C',
        'SLCT     1 # STRUCTURED &     0    10     0    10     6     6 !      5      0      3',
        ' t_1_5.sf', ' TEMPERATURE', ' temp', ' C',
        'SLCF     1 # STRUCTURED &     0    10     0    10     6     6 !      6      0      3',
        ' not_a_slice.txt', ' TEMPERATURE', ' temp', ' C',
    ].join('\n'));
    assert.deepStrictEqual(records.map(r => [r.type, r.sliceIndex, r.fileName]), [['SLCT', 5, 't_1_5.sf']]);
}

// ── Records without the '!' index: file-name fallback, one console.info ──
{
    const noIndex = SMV.replace(/ !\s+2\s+0\s+3/g, '');
    const records = SliceFiles.sliceRecordsFromSmvText(noIndex);
    assert.strictEqual(records.filter(r => r.sliceIndex === null).length, 2);
    const infos = [];
    const orig = console.info;
    console.info = (...args) => infos.push(args.join(' '));
    let groups;
    try { groups = await SliceFiles.describeSliceGroups(FILES, records); }
    finally { console.info = orig; }
    assert.strictEqual(infos.length, 1);
    assert.match(infos[0], /2 of 5 .*file-name index/);
    assert.ok(groups.every(g => !g.unlisted));
    assert.deepStrictEqual(membership(groups), [
        ['two_1_1.sf@1', 'two_2_1.sf@2'],
        ['two_1_2.sf@1', 'two_2_2.sf@2'],
        ['two_2_3.sf@2'],
    ]);
    // With complete records nothing is logged.
    console.info = (...args) => infos.push(args.join(' '));
    try { await SliceFiles.describeSliceGroups(FILES, SliceFiles.sliceRecordsFromSmvText(SMV)); }
    finally { console.info = orig; }
    assert.strictEqual(infos.length, 1);
}

// ── Without a .smv, file-name grouping is the fallback ───────────────────
{
    const groups = await SliceFiles.describeSliceGroups(FILES);
    assert.deepStrictEqual(groups.map(g => g.sliceIndex), [1, 2, 3]);
    assert.deepStrictEqual(membership(groups), [
        ['two_1_1.sf@1', 'two_2_1.sf@2'],
        ['two_1_2.sf@1', 'two_2_2.sf@2'],
        ['two_2_3.sf@2'],
    ]);
}

// ── '!' and '&' inside a %ID do not shift the bounds or the index ───────
{
    const records = SliceFiles.sliceRecordsFromSmvText(
        'SLCF     1 # STRUCTURED %LEVEL!2 & 0 1 0 1 0 0 & 3 ! 9 &     0    10     0    10     6     6 !      1      0      3\n' +
        ' x_1_1.sf\n TEMPERATURE\n temp\n C\n' +
        'SLCF     1 # STRUCTURED %A!7     &     0    10     0    10     6     6\n' +
        ' x_1_2.sf\n TEMPERATURE\n temp\n C\n');
    assert.deepStrictEqual(records.map(r => [r.sliceIndex, r.indices]), [
        [1, PBZ],
        [null, PBZ],
    ]);
    const codex = SliceFiles.sliceRecordsFromSmvText(
        'SLCF 1 # STRUCTURED %LEVEL!2 & 0 1 0 1 0 0 ! 1 0 3\n x_1_1.sf\n TEMPERATURE\n temp\n C\n');
    assert.deepStrictEqual([codex[0].sliceIndex, codex[0].indices], [1, [0, 1, 0, 1, 0, 0]]);
}

// ── Two runs (two .smv files) in one folder: each run uses its own records ─
{
    // Run 'two' as above; run 'two_b' renames every file (CHID 'two_b'), so
    // 'two_' also prefixes its files and the longest CHID must win.
    const smvB = SMV.replace(/ two_/g, ' two_b_');
    const filesB = FILES.map(f => new File([f], f.name.replace(/^two_/, 'two_b_')));
    const runs = [
        { chid: 'two', records: SliceFiles.sliceRecordsFromSmvText(SMV) },
        { chid: 'two_b', records: SliceFiles.sliceRecordsFromSmvText(smvB) },
    ];
    for (const order of [runs, runs.slice().reverse()]) {
        const groups = await SliceFiles.describeSliceGroupsForRuns([...FILES, ...filesB], order);
        assert.ok(groups.every(g => !g.unlisted));
        assert.deepStrictEqual(groups.map(g => [g.chid, g.sliceIndex]), [
            ['two', 1], ['two', 2], ['two', 3], ['two_b', 1], ['two_b', 2], ['two_b', 3],
        ]);
        assert.deepStrictEqual(membership(groups), [
            ['two_2_1.sf@2'], ['two_1_1.sf@1', 'two_2_2.sf@2'], ['two_1_2.sf@1', 'two_2_3.sf@2'],
            ['two_b_2_1.sf@2'], ['two_b_1_1.sf@1', 'two_b_2_2.sf@2'], ['two_b_1_2.sf@1', 'two_b_2_3.sf@2'],
        ]);
        assert.strictEqual(new Set(groups.map(g => g.key)).size, 6);
        assert.strictEqual(new Set(groups.map(g => g.label)).size, 6);
        assert.match(groups[3].label, /^two_b \| TEMPERATURE/);
    }
}

// ── A group whose files are all missing is not loadable but reported once ─
{
    const records = SliceFiles.sliceRecordsFromSmvText(SMV);
    const infos = [];
    const orig = console.info;
    console.info = (...args) => infos.push(args.join(' '));
    let groups;
    try { groups = await SliceFiles.describeSliceGroups(FILES.filter(f => f.name !== 'two_2_1.sf'), records); }
    finally { console.info = orig; }
    assert.deepStrictEqual(groups.map(g => g.sliceIndex), [2, 3]);
    assert.deepStrictEqual(groups.unavailable.map(g => [g.sliceIndex, g.missing]), [[1, ['two_2_1.sf']]]);
    assert.strictEqual(infos.length, 1);
    assert.match(infos[0], /Slice 1: 0 of 1 files \(missing: two_2_1\.sf\)/);
}

console.log('slice-grouping tests passed');
