const { chromium, devices } = require('@playwright/test');
(async () => {
  const b = await chromium.launch();
  const out = 'design/homework/current/';
  const sizes = [['desktop',{viewport:{width:1440,height:900}}],['ipad',{...devices['iPad Pro 11'], }],['ipad-land',{...devices['iPad Pro 11 landscape']}],['phone',{...devices['iPhone 15 Pro']}]];
  for (const [n,opt] of sizes) {
    const ctx = await b.newContext(opt); const p = await ctx.newPage();
    await p.goto('http://localhost:3000/'); await p.waitForTimeout(3500);
    await p.screenshot({path: out+n+'-home.png'});
    // try opening palette
    if (n==='desktop') { await p.keyboard.press('Meta+k'); await p.waitForTimeout(600); await p.screenshot({path: out+n+'-palette.png'}); await p.keyboard.press('Escape'); }
    await ctx.close();
  }
  await b.close();
})();
