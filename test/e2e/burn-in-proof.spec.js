// SCRATCH (eve#206 CI proof, removed in the next commit): fails only on the 5th repeat.
const { test, expect } = require('@playwright/test');
test('burn-in proof', async ({}, testInfo) => { expect(testInfo.repeatEachIndex).toBeLessThan(4); });
