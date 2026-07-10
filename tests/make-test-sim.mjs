/**
 * Synthetic FDS simulation output for slice-pipeline verification.
 *
 * One 4 m × 4 m × 2.4 m room split into a 2×2 arrangement of meshes, a small
 * "fire" (Gaussian hot spot) in the south-west corner, and 3 time steps of a
 * TEMPERATURE slice at z = 1.2 m. Everything is generated deterministically:
 * the .smv / .fds texts and the four Fortran-record binary .sf files.
 *
 * Used in-memory by tests/slice-stitch.test.mjs. Can also write a folder that
 * the viewer's "Open simulation folder" understands (note: .sf/.smv are
 * gitignored, so only this generator is tracked):
 *
 *   node tests/make-test-sim.mjs examples/multimesh_room
 */

export const CHID = 'multimesh_room';

// Room split into 2×2 meshes, each 2×2 m in XY, full 2.4 m height, dx=dy=0.2, dz=0.4
export const MESHES = [
    { id: 'mesh_01', ijk: [10, 10, 6], xb: [0, 2, 0, 2, 0, 2.4] },
    { id: 'mesh_02', ijk: [10, 10, 6], xb: [2, 4, 0, 2, 0, 2.4] },
    { id: 'mesh_03', ijk: [10, 10, 6], xb: [0, 2, 2, 4, 0, 2.4] },
    { id: 'mesh_04', ijk: [10, 10, 6], xb: [2, 4, 2, 4, 0, 2.4] },
];

export const SLICE_K = 3;                    // z = 3 * 0.4 = 1.2 m
export const TIMES = [0, 1, 2];
export const FIRE = { x: 0.6, y: 0.6, sigma2: 0.5, amps: [0, 150, 300] };
export const AMBIENT = 20;

/** Analytic temperature at a point for a given time step. */
export function temperatureAt(x, y, timeIndex) {
    const r2 = (x - FIRE.x) ** 2 + (y - FIRE.y) ** 2;
    return AMBIENT + FIRE.amps[timeIndex] * Math.exp(-r2 / FIRE.sigma2);
}

// ── Fortran-record .sf writer ─────────────────────────────────────────────
function record(payload) {
    const out = new Uint8Array(payload.length + 8);
    const view = new DataView(out.buffer);
    view.setUint32(0, payload.length, true);
    out.set(payload, 4);
    view.setUint32(payload.length + 4, payload.length, true);
    return out;
}

function stringRecord(text) {
    // FDS pads slice header strings to 30 characters.
    const bytes = new Uint8Array(30).fill(0x20);
    for (let i = 0; i < Math.min(text.length, 30); i++) bytes[i] = text.charCodeAt(i);
    return record(bytes);
}

function int32Record(values) {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((v, i) => view.setInt32(i * 4, v, true));
    return record(bytes);
}

function float32Record(values) {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((v, i) => view.setFloat32(i * 4, v, true));
    return record(bytes);
}

/** Binary TEMPERATURE slice file (z-normal plane at SLICE_K) for one mesh. */
export function buildSliceFile(mesh) {
    const [ni, nj] = mesh.ijk;
    const chunks = [
        stringRecord('TEMPERATURE'),
        stringRecord('temp'),
        stringRecord('C'),
        int32Record([0, ni, 0, nj, SLICE_K, SLICE_K]),
    ];
    for (let t = 0; t < TIMES.length; t++) {
        const values = [];
        for (let j = 0; j <= nj; j++) {
            for (let i = 0; i <= ni; i++) {
                const x = mesh.xb[0] + (mesh.xb[1] - mesh.xb[0]) * i / ni;
                const y = mesh.xb[2] + (mesh.xb[3] - mesh.xb[2]) * j / nj;
                values.push(temperatureAt(x, y, t));
            }
        }
        chunks.push(float32Record([TIMES[t]]));
        chunks.push(float32Record(values));
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out.buffer;
}

// ── .smv / .end / .fds output ─────────────────────────────────────────────
// The .smv mirrors what FDS 6.8 writes (verified against a real run of the
// generated .fds): real Smokeview is strict about the sections it expects
// (TITLE/NMESHES/SURFACE/OBST/VENT/CVENT per mesh, the .end endianness file,
// exact SLCF entry format), so a minimal file makes it crash.

/** The CHID.end companion file: one Fortran record holding int32 1, used by
 *  Smokeview to detect the byte order of the binary output files. */
export function buildEndFile() {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 4, true);
    view.setInt32(4, 1, true);
    view.setUint32(8, 4, true);
    return bytes.buffer;
}

function fmt(value, width, decimals) {
    return value.toFixed(decimals).padStart(width);
}

function trnBlock(axis, mesh) {
    const a = { X: 0, Y: 1, Z: 2 }[axis];
    const lines = ['TRN' + axis, '    0'];
    for (let i = 0; i <= mesh.ijk[a]; i++) {
        const coord = mesh.xb[a * 2] + (mesh.xb[a * 2 + 1] - mesh.xb[a * 2]) * i / mesh.ijk[a];
        lines.push(String(i).padStart(5) + fmt(coord, 14, 5));
    }
    return lines;
}

function surfaceBlock(name, type, rgb) {
    return [
        'SURFACE',
        ' ' + name.padEnd(60),
        ' 5000.00    1.00',
        (String(type).padStart(2)) + rgb.map(v => fmt(v, 13, 5)).join('') + fmt(1, 13, 5),
        ' null'.padEnd(61),
        '',
    ];
}

function domainBounds() {
    const b = MESHES[0].xb.slice();
    for (const mesh of MESHES) {
        for (let a = 0; a < 3; a++) {
            b[a * 2] = Math.min(b[a * 2], mesh.xb[a * 2]);
            b[a * 2 + 1] = Math.max(b[a * 2 + 1], mesh.xb[a * 2 + 1]);
        }
    }
    return b;
}

function outlineEdges() {
    // The 12 edges of the domain bounding box, one "x1 y1 z1 x2 y2 z2" each.
    const [x0, x1, y0, y1, z0, z1] = domainBounds();
    const edges = [];
    for (const z of [z0, z1]) {
        edges.push([x0, y0, z, x1, y0, z], [x0, y1, z, x1, y1, z],
                   [x0, y0, z, x0, y1, z], [x1, y0, z, x1, y1, z]);
    }
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        edges.push([x, y, z0, x, y, z1]);
    }
    return edges;
}

export function buildSmvText() {
    const lines = [
        'TITLE',
        ' Single multimesh room, small fire, ' + TIMES.length + ' time steps',
        '',
        'FDSVERSION',
        'FDS-6.8.0 (synthetic test data, tests/make-test-sim.mjs)',
        '',
        'ENDF',
        ' ' + CHID + '.end',
        '',
        'INPF',
        ' ' + CHID + '.fds',
        '',
        'CHID',
        ' ' + CHID,
        '',
        'NMESHES',
        '  ' + MESHES.length,
        '',
        'TIMES',
        fmt(TIMES[0], 11, 3) + fmt(TIMES[TIMES.length - 1], 11, 3),
        '',
        'VIEWTIMES',
        fmt(TIMES[0], 10, 2) + fmt(TIMES[TIMES.length - 1], 10, 2) + '  ' + TIMES.length,
        '',
        'ALBEDO',
        '      0.30000',
        '',
        'IBLANK',
        ' 1',
        '',
        'GVEC',
        '      0.00000      0.00000     -9.80665',
        '',
        'SURFDEF',
        ' ' + 'INERT'.padEnd(60),
        '',
    ];
    // Reserved surfaces FDS always writes, plus our fire surface.
    lines.push(...surfaceBlock('INERT', 0, [1, 1, 1, 0.8, 0.4]));
    lines.push(...surfaceBlock('fire', 0, [1, 1, 1, 0, 0]));
    lines.push(...surfaceBlock('OPEN', 2, [1, 1, 1, 0, 1]));
    lines.push(...surfaceBlock('MIRROR', -2, [1, 1, 1, 0.8, 0.4]));
    for (const name of ['INTERPOLATED', 'PERIODIC', 'HVAC', 'MASSLESS TRACER', 'DROPLET', 'MASSLESS TARGET']) {
        lines.push(...surfaceBlock(name, 0, [1, 1, 1, 0.8, 0.4]));
    }
    const edges = outlineEdges();
    lines.push('OUTLINE', '  ' + edges.length);
    for (const e of edges) lines.push(e.map(v => fmt(v, 14, 4)).join(''));
    lines.push(
        '',
        'TOFFSET',
        '      0.00000      0.00000      0.00000',
        '',
        'HRRPUVCUT',
        '     1',
        '    200.00000',
        '',
        'PROP',
        ' null',
        '  1',
        ' sensor',
        '  0',
        ''
    );
    MESHES.forEach(mesh => {
        lines.push(
            'OFFSET',
            '      0.00000      0.00000      0.00000',
            '',
            'GRID   ' + mesh.id,
            '   ' + mesh.ijk.map(v => String(v).padStart(2)).join('   ') + '    0',
            '',
            'PDIM',
            ' ' + [...mesh.xb, 0, 0, 0].map(v => fmt(v, 13, 5)).join(' '),
            '',
            ...trnBlock('X', mesh), '',
            ...trnBlock('Y', mesh), '',
            ...trnBlock('Z', mesh), '',
            'OBST',
            '           0',
            '',
            'VENT',
            '    0    0',
            '',
            'CVENT',
            '    0',
            ''
        );
    });
    MESHES.forEach((mesh, m) => {
        lines.push(
            'SLCF     ' + (m + 1) + ' # STRUCTURED &     0    ' + mesh.ijk[0] +
                '     0    ' + mesh.ijk[1] + '     ' + SLICE_K + '     ' + SLICE_K + ' !      1      0',
            ' ' + CHID + '_' + (m + 1) + '_1.sf',
            ' TEMPERATURE',
            ' temp',
            ' C'
        );
    });
    return lines.join('\n') + '\n';
}

export function buildFdsText() {
    const lines = [
        "&HEAD CHID='" + CHID + "', TITLE='Single multimesh room, small fire, 3 time steps' /",
        '&TIME T_END=2.0 /',
    ];
    for (const mesh of MESHES) {
        lines.push('&MESH ID=\'' + mesh.id + '\' IJK=' + mesh.ijk.join(',') +
            ' XB=' + mesh.xb.map(v => v.toFixed(1)).join(',') + ' /');
    }
    lines.push(
        "&REAC FUEL='PROPANE' /",
        "&SURF ID='fire' HRRPUA=100.0 COLOR='RED' /",
        "&VENT XB=0.4,0.8,0.4,0.8,0.0,0.0 SURF_ID='fire' /",
        "&SLCF QUANTITY='TEMPERATURE' PBZ=1.2 /",
        '&TAIL /'
    );
    return lines.join('\n') + '\n';
}

/** The whole synthetic sim: texts plus the four binary slice files. */
export function buildExampleSim() {
    return {
        chid: CHID,
        smvName: CHID + '.smv',
        smvText: buildSmvText(),
        fdsName: CHID + '.fds',
        fdsText: buildFdsText(),
        endName: CHID + '.end',
        endBuffer: buildEndFile(),
        sliceFiles: MESHES.map((mesh, m) => ({
            name: CHID + '_' + (m + 1) + '_1.sf',
            meshIndex: m + 1,
            buffer: buildSliceFile(mesh),
        })),
    };
}

// ── CLI: write the sim to a folder ────────────────────────────────────────
if (import.meta.url === new URL('file://' + process.argv[1]).href ||
    import.meta.url === new URL('file://' + process.argv[1] + '.mjs').href) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = process.argv[2];
    if (!dir) {
        console.error('Usage: node tests/make-test-sim.mjs <output-folder>');
        process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
    const sim = buildExampleSim();
    fs.writeFileSync(path.join(dir, sim.smvName), sim.smvText);
    fs.writeFileSync(path.join(dir, sim.fdsName), sim.fdsText);
    fs.writeFileSync(path.join(dir, sim.endName), Buffer.from(sim.endBuffer));
    for (const f of sim.sliceFiles) fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.buffer));
    console.log('Wrote ' + sim.smvName + ', ' + sim.fdsName + ', ' + sim.endName +
        ' and ' + sim.sliceFiles.length + ' slice files to ' + dir);
}
