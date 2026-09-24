// Renders each mockups/*.html to a PNG at the size named in its <meta name="frame">.
// Usage (from the eve repo root): node design/homework/tools/render-mockups.js [name...]
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'mockups');
const FRAMES = { desktop: [1440, 900, 1], ipad: [1194, 834, 2], 'ipad-portrait': [834, 1194, 2], phone: [393, 852, 3] };

(async () => {
  const only = process.argv.slice(2);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && (!only.length || only.some(o => f.includes(o))));
  const browser = await chromium.launch();
  for (const f of files) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const frame = (html.match(/<meta name="frame" content="([^"]+)"/) || [])[1] || 'desktop';
    const [w, h, scale] = FRAMES[frame];
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    await page.goto('file://' + path.join(dir, f));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(dir, f.replace(/\.html$/, '.png')) });
    await ctx.close();
    console.log('rendered', f, frame);
  }
  await browser.close();
})();
