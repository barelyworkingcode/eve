const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { git, write, makeTmp, initRepo, commitAll } = require('../helpers/git-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const LINT = path.join(ROOT, 'scripts', 'lint-added-waits.js');
const BURN = path.join(ROOT, 'scripts', 'burn-in-specs.js');

function run(script, cwd, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

const BASE_SPEC = [
  'test("a", async ({ page }) => {',
  '  await page.waitForTimeout(100);',
  '});',
  '',
].join('\n');

describe('PR e2e gates against a temp git repo', () => {
  let dir;
  beforeEach(() => {
    dir = makeTmp('eve-gates-');
    initRepo(dir, {
      'test/e2e/old.spec.js': BASE_SPEC,
      'test/e2e/helper.js': 'module.exports = 1;\n',
      'test/e2e/voice.spec.js': 'test("v", () => {});\n',
    });
    // Minimal stand-in for the real config: only testIgnore matters to the CLI.
    write(dir, 'playwright.config.js', 'module.exports = { testIgnore: /voice\\.spec\\.js$/ };\n');
    commitAll(dir, 'config');
    git(dir, ['branch', 'base']);
    git(dir, ['checkout', '-q', '-b', 'pr']);
  });
  afterEach(() => {
    if (dir && dir.length > 5) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails a head that adds a wait: exactly one annotation naming the new line', async () => {
    write(dir, 'test/e2e/old.spec.js', [
      '// a new comment',
      'test("a", async ({ page }) => {',
      '  await page.waitForTimeout(100);',
      '  await page.waitForTimeout(250);',
      '});',
      '',
    ].join('\n'));
    commitAll(dir, 'head A');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(1);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('::error'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::error file=test\/e2e\/old\.spec\.js,line=4::/);
  });

  it('passes a head that only adds a comment above an existing wait', async () => {
    write(dir, 'test/e2e/old.spec.js', `// a new comment\n${BASE_SPEC}`);
    commitAll(dir, 'head B');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.stdout).not.toMatch(/::error/);
    expect(r.code).toBe(0);
  });

  it('exits 2 with a usage message when refs are missing', async () => {
    const r = await run(LINT, dir, []);
    expect(r.code).toBe(2);
  });

  it('burn-in prints only the changed spec, not a changed helper or the ignored voice spec', async () => {
    write(dir, 'test/e2e/helper.js', 'module.exports = 2;\n');
    write(dir, 'test/e2e/old.spec.js', `// touched\n${BASE_SPEC}`);
    write(dir, 'test/e2e/voice.spec.js', 'test("v", () => { /* touched */ });\n');
    commitAll(dir, 'change');
    const r = await run(BURN, dir, ['base', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('test/e2e/old.spec.js\n');
  });

  it('burn-in prints nothing and exits 0 when no spec changed', async () => {
    write(dir, 'test/e2e/helper.js', 'module.exports = 2;\n');
    commitAll(dir, 'helper only');
    const r = await run(BURN, dir, ['base', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('lints a spec whose path contains a space: one annotation, exit 1', async () => {
    write(dir, 'test/e2e/my spec.spec.js', 'test("s", async ({ page }) => {\n  await page.waitForTimeout(5);\n});\n');
    commitAll(dir, 'spaced');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(1);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('::error'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::error file=test\/e2e\/my spec\.spec\.js,line=2::/);
  });

  it('exits 2 when a changed spec is missing from the working tree (fail closed)', async () => {
    write(dir, 'test/e2e/new.spec.js', 'test("n", async ({ page }) => {\n  await page.waitForTimeout(5);\n});\n');
    commitAll(dir, 'new');
    git(dir, ['checkout', '-q', 'base']);
    const r = await run(LINT, dir, ['base', 'pr']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/test\/e2e\/new\.spec\.js.*not in the working tree/);
  });

  it('exits 2 for a changed TypeScript e2e file', async () => {
    write(dir, 'test/e2e/t.spec.ts', 'export {};\n');
    commitAll(dir, 'ts');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/TypeScript e2e files are not linted; add a parser before adding one/);
  });

  it('lints a changed .mjs spec', async () => {
    write(dir, 'test/e2e/m.spec.mjs', 'import x from "y";\nawait x.waitForTimeout(5);\n');
    commitAll(dir, 'mjs');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^::error file=test\/e2e\/m\.spec\.mjs,line=2::/m);
  });

  it('burn-in lists a changed .test.ts spec', async () => {
    write(dir, 'test/e2e/z.test.ts', 'export {};\n');
    commitAll(dir, 'ts spec');
    const r = await run(BURN, dir, ['base', 'HEAD']);
    expect(r.stdout).toBe('test/e2e/z.test.ts\n');
  });

  it.each([['lint', LINT], ['burn-in', BURN]])('%s exits 2 when git fails on a missing ref', async (_n, script) => {
    const r = await run(script, dir, ['nosuchref', 'HEAD']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/git diff nosuchref\.\.\.HEAD failed/);
  });

  it('catches a wait in a later hunk after an added line that starts with "++ "', async () => {
    const lines = ['const a = 1;', 'x;', 'x;', 'x;', 'x;', 'x;', 'x;', 'x;', 'x;', 'x;', 'x;', 'x;', ''];
    write(dir, 'test/e2e/h.spec.js', lines.join('\n'));
    commitAll(dir, 'h base');
    git(dir, ['branch', '-f', 'base', 'HEAD']);
    const edited = [...lines];
    edited.splice(1, 0, '++ globalThis.n;');
    edited.splice(12, 0, 'async function f(page) { await page.waitForTimeout(5); }');
    write(dir, 'test/e2e/h.spec.js', edited.join('\n'));
    commitAll(dir, 'h head');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^::error file=test\/e2e\/h\.spec\.js,line=13::/m);
  });

  it('lints a spec containing a NUL byte that git would call binary', async () => {
    write(dir, 'test/e2e/n.spec.js', 'async function f(page) { await page.waitForTimeout(5); }\n// \u0000\n');
    commitAll(dir, 'nul');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^::error file=test\/e2e\/n\.spec\.js,line=1::/m);
  });

  it('lints a spec a PR-added .gitattributes marks -diff', async () => {
    write(dir, '.gitattributes', 'test/e2e/*.js -diff\n');
    write(dir, 'test/e2e/g.spec.js', 'async function f(page) { await page.waitForTimeout(5); }\n');
    commitAll(dir, 'attr');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^::error file=test\/e2e\/g\.spec\.js,line=1::/m);
  });

  it.each(['x.mjsx', 'x.cjsx', 'x.mtsx', 'x.ctsx'])('exits 2 for a changed %s e2e file', async (name) => {
    write(dir, `test/e2e/${name}`, 'export {};\n');
    commitAll(dir, 'odd ext');
    const r = await run(LINT, dir, ['base', 'HEAD']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/TypeScript e2e files are not linted/);
  });
});
