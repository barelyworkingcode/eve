const path = require('path');
const { ESLint } = require('eslint');
const { addedLines, findingsOnAddedLines } = require('../../scripts/lint-added-waits');

const ROOT = path.resolve(__dirname, '..', '..');

describe('addedLines', () => {
  it('collects added lines across several hunks of one file', () => {
    const diff = [
      'diff --git a/test/e2e/a.spec.js b/test/e2e/a.spec.js',
      '--- a/test/e2e/a.spec.js',
      '+++ b/test/e2e/a.spec.js',
      '@@ -3,0 +4,2 @@ ctx',
      '+x',
      '+y',
      '@@ -10,2 +12,3 @@',
      '-old',
      '+n1',
      '+n2',
      '+n3',
      '@@ -20 +30 @@',
      '-z',
      '+z2',
    ].join('\n');
    const added = addedLines(diff);
    expect([...added.get('test/e2e/a.spec.js')].sort((a, b) => a - b)).toEqual([4, 5, 12, 13, 14, 30]);
  });

  it('counts nothing for a pure deletion hunk (+c,0)', () => {
    const diff = [
      'diff --git a/test/e2e/a.spec.js b/test/e2e/a.spec.js',
      '--- a/test/e2e/a.spec.js',
      '+++ b/test/e2e/a.spec.js',
      '@@ -5,2 +4,0 @@',
      '-gone1',
      '-gone2',
    ].join('\n');
    const lines = addedLines(diff).get('test/e2e/a.spec.js');
    expect(lines ? lines.size : 0).toBe(0);
  });

  it('records no lines for a deleted file', () => {
    const diff = [
      'diff --git a/test/e2e/gone.spec.js b/test/e2e/gone.spec.js',
      'deleted file mode 100644',
      '--- a/test/e2e/gone.spec.js',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
    ].join('\n');
    expect(addedLines(diff).size).toBe(0);
  });

  it('records no lines for a pure rename', () => {
    const diff = [
      'diff --git a/test/e2e/old.spec.js b/test/e2e/new.spec.js',
      'similarity index 100%',
      'rename from test/e2e/old.spec.js',
      'rename to test/e2e/new.spec.js',
    ].join('\n');
    const lines = addedLines(diff).get('test/e2e/new.spec.js');
    expect(lines ? lines.size : 0).toBe(0);
  });

  it('keys a new file under its new path with every line added', () => {
    const diff = [
      'diff --git a/test/e2e/new.spec.js b/test/e2e/new.spec.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/test/e2e/new.spec.js',
      '@@ -0,0 +1,3 @@',
      '+a', '+b', '+c',
    ].join('\n');
    expect([...addedLines(diff).get('test/e2e/new.spec.js')]).toEqual([1, 2, 3]);
  });

  it('treats a hunk with no count as one line', () => {
    const diff = [
      'diff --git a/test/e2e/a.spec.js b/test/e2e/a.spec.js',
      '--- a/test/e2e/a.spec.js',
      '+++ b/test/e2e/a.spec.js',
      '@@ -7 +7 @@',
      '-a',
      '+b',
    ].join('\n');
    expect([...addedLines(diff).get('test/e2e/a.spec.js')]).toEqual([7]);
  });
});

describe('addedLines, spaced path', () => {
  it('strips the trailing TAB git puts after a +++ header with a space in the path', () => {
    const diff = [
      'diff --git a/test/e2e/my spec.spec.js b/test/e2e/my spec.spec.js',
      '--- a/test/e2e/my spec.spec.js\t',
      '+++ b/test/e2e/my spec.spec.js\t',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
    ].join('\n');
    const added = addedLines(diff);
    expect([...added.keys()]).toEqual(['test/e2e/my spec.spec.js']);
    expect([...added.get('test/e2e/my spec.spec.js')]).toEqual([1, 2]);
  });
});

describe('findingsOnAddedLines (real eslint, repo config)', () => {
  // The repo config, passed in-memory: ESLint's own config-file loader uses a
  // dynamic import, which jest's vm sandbox rejects.
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: require('../../eslint.config.js') });
  const FILE = 'test/e2e/x.spec.js';
  const lint = (src) => eslint.lintText(src, { filePath: FILE });
  const added = (...n) => new Map([[FILE, new Set(n)]]);

  it('reports a wait on an added line', async () => {
    const results = await lint('test("a", async ({ page }) => {\n  await page.waitForTimeout(500);\n});\n');
    const findings = findingsOnAddedLines(results, added(2), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: FILE, line: 2 });
  });

  it('does not report an existing wait on a line the diff did not add', async () => {
    const results = await lint('test("a", async ({ page }) => {\n  await page.waitForTimeout(500);\n  // new\n});\n');
    expect(findingsOnAddedLines(results, added(3), ROOT)).toEqual([]);
  });

  it('reports a two-line call when only its second line is added', async () => {
    const results = await lint('async function f(page) {\n  await page\n    .waitForTimeout(1);\n}\n');
    const findings = findingsOnAddedLines(results, added(3), ROOT);
    expect(findings).toHaveLength(1);
  });

  it('does not report a comment or string that mentions waitForTimeout', async () => {
    const results = await lint('// page.waitForTimeout(1)\nconst s = "page.waitForTimeout(1)";\n');
    expect(findingsOnAddedLines(results, added(1, 2), ROOT)).toEqual([]);
  });

  it('is not silenced by an added eslint-disable-line comment', async () => {
    const results = await lint('async function f(page) {\n  await page.waitForTimeout(1); // eslint-disable-line\n}\n');
    expect(findingsOnAddedLines(results, added(2), ROOT)).toHaveLength(1);
  });

  it('reports a wait on a receiver other than page', async () => {
    const results = await lint('async function f(popup) {\n  await popup.waitForTimeout(1);\n}\n');
    expect(findingsOnAddedLines(results, added(2), ROOT)).toHaveLength(1);
  });

  it('lints a .mjs file as a module (import is not a parse error)', async () => {
    const results = await eslint.lintText('import x from "y";\nawait x.waitForTimeout(1);\n', { filePath: 'test/e2e/m.mjs' });
    const findings = findingsOnAddedLines(results, new Map([['test/e2e/m.mjs', new Set([2])]]), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('lints a .cjs file', async () => {
    const results = await eslint.lintText('async function f(p) { await p.waitForTimeout(1); }\n', { filePath: 'test/e2e/c.cjs' });
    expect(findingsOnAddedLines(results, new Map([['test/e2e/c.cjs', new Set([1])]]), ROOT)).toHaveLength(1);
  });

  it('always reports a parse error, even with no added lines', async () => {
    const results = await lint('const = ;\n');
    const findings = findingsOnAddedLines(results, new Map(), ROOT);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(FILE);
  });
});
