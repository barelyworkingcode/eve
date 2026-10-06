// Every e2e spec navigates to eve through gotoEve/reloadEve, which wait on
// <html data-ready>. A bare reload/goto must say why it acts before ready.
const fs = require('fs');
const path = require('path');

const E2E_DIR = path.join(__dirname, '..', 'e2e');
const NAV = /\.(reload|goto)\(/;
const BLANK = /\.goto\(\s*(['"])about:blank\1/;
const MARKER = '// pre-ready:';

const isViolation = (line) => NAV.test(line) && !BLANK.test(line) && !line.includes(MARKER);

function specFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return specFiles(p);
    return e.name.endsWith('.js') && e.name !== 'fixtures.js' ? [p] : [];
  });
}

describe('e2e ready-wait guard', () => {
  test('the matcher flags a bare reload and goto, and passes the allowed forms', () => {
    expect(isViolation('    await page.reload();')).toBe(true);
    expect(isViolation("    await page.goto(`${eve.baseUrl}/#x`);")).toBe(true);
    expect(isViolation("    await page.goto('about:blank');")).toBe(false);
    expect(isViolation('    await page.goto("about:blank");')).toBe(false);
    expect(isViolation('    await page.reload(); // pre-ready: auth screen')).toBe(false);
  });

  test('no e2e spec calls a bare reload or goto without a pre-ready marker', () => {
    const offenders = [];
    for (const file of specFiles(E2E_DIR)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (isViolation(line)) offenders.push(`${path.relative(E2E_DIR, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
