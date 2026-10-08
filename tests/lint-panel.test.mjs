import assert from 'node:assert';
import fs from 'node:fs';

// fire-panel.js is a plain browser script; load its top-level functions
// into a sandbox (it touches the DOM only when its functions run).
const src = fs.readFileSync(new URL('../js/fire-panel.js', import.meta.url), 'utf8');
const { _lintLineMap, _renderLintResults } =
    new Function(src + '\nreturn { _lintLineMap, _renderLintResults };')();

// ── _lintLineMap: ranges and severity order ─────────────────────────────────
{
    const map = _lintLineMap([
        { severity: 'INFO',    line: 2, lineEnd: 4, message: '' },
        { severity: 'ERROR',   line: 3,             message: '' },
        { severity: 'WARNING', line: 4,             message: '' },
        { severity: 'WARNING', line: 0,             message: 'no line' },
        { severity: 'ERROR',   line: 9, lineEnd: 7, message: 'bad range' },
    ]);
    assert.deepStrictEqual({ ...map }, { 2: 'INFO', 3: 'ERROR', 4: 'WARNING', 9: 'ERROR' });
}

// ── _renderLintResults: clickable rows only for findings with a line ────────
{
    const html = _renderLintResults([
        { severity: 'ERROR', line: 7, message: 'Undefined <SURF>', hint: 'Define it' },
        { severity: 'WARNING', line: 0, message: 'Internal rule failed' },
    ]);
    assert.match(html, /1 error/);
    assert.match(html, /1 warning/);
    assert.match(html, /<button type="button" class="fp-finding" data-line="7">/);
    assert.match(html, /<div class="fp-finding">/);
    assert.match(html, /Undefined &lt;SURF&gt;/);
    assert.doesNotMatch(html, /<div class="fp-finding-msg"/);
}

// ── _renderLintResults: clean file ──────────────────────────────────────────
{
    const html = _renderLintResults([]);
    assert.match(html, /No issues found/);
    assert.match(html, /aria-label="Close findings"/);
}

console.log('lint-panel: ok');
