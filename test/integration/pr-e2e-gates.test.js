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
});
