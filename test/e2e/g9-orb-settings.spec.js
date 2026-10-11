const { test, expect } = require('./support/fixtures');

test.use({ mic: 'silence' });

async function openVoiceView(eve, page, relay) {
  await eve.open('/');
  const since = await relay.mark();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await page.getByRole('button', { name: 'Start Voice Chat' }).click();
  await expect(page.getByRole('button', { name: 'Hold to record' })).toBeVisible();
  await expect(page.getByText('Listening...')).toBeVisible();
  await relay.waitForEvent('session.launch', { since });
}

async function openSheet(page) {
  await page.getByRole('button', { name: 'Orb settings' }).click();
  await expect(page.getByText('Orb settings', { exact: true })).toBeVisible();
}

const SLIDERS = ['Inner orb size', 'Outer orb size', 'Spin rate', 'Idle jitter', 'Speech jitter'];

// Waits: the sheet text "Orb settings" visible.
test('the orb settings sheet shows five sliders and a reset button @G9.14', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await expect(page.getByText('Orb settings', { exact: true })).toBeHidden();
  await openSheet(page);
  for (const name of SLIDERS) {
    await expect(page.getByRole('slider', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('slider')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Reset to defaults' })).toBeVisible();
});

// Waits: the sheet text hidden after Close.
test('Close puts the orb settings sheet away @G9.15', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Orb settings', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Hold to record' })).toBeVisible();
});

// Each slider: fill a value, then its value text beside it (two decimals). No pixel claims.

test('the inner orb size slider changes its value @G9.16', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  const slider = page.getByRole('slider', { name: 'Inner orb size', exact: true });
  await expect(page.getByText('0.70', { exact: true })).toBeHidden();
  await slider.fill('0.7');
  await expect(slider).toHaveValue('0.7');
  await expect(page.getByText('0.70',{ exact: true })).toBeVisible();
});

test('the outer orb size slider changes its value @G9.17', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  const slider = page.getByRole('slider', { name: 'Outer orb size', exact: true });
  await expect(page.getByText('1.30', { exact: true })).toBeHidden();
  await slider.fill('1.3');
  await expect(slider).toHaveValue('1.3');
  await expect(page.getByText('1.30',{ exact: true })).toBeVisible();
});

test('the spin rate slider changes its value @G9.18', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  const slider = page.getByRole('slider', { name: 'Spin rate', exact: true });
  await expect(page.getByText('1.70', { exact: true })).toBeHidden();
  await slider.fill('1.7');
  await expect(slider).toHaveValue('1.7');
  await expect(page.getByText('1.70',{ exact: true })).toBeVisible();
});

test('the idle jitter slider changes its value @G9.19', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  const slider = page.getByRole('slider', { name: 'Idle jitter', exact: true });
  await expect(page.getByText('0.40', { exact: true })).toBeHidden();
  await slider.fill('0.4');
  await expect(slider).toHaveValue('0.4');
  await expect(page.getByText('0.40',{ exact: true })).toBeVisible();
});

test('the speech jitter slider changes its value @G9.20', async ({ eve, page, relay }) => {
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  const slider = page.getByRole('slider', { name: 'Speech jitter', exact: true });
  await expect(page.getByText('0.30', { exact: true })).toBeHidden();
  await slider.fill('0.3');
  await expect(slider).toHaveValue('0.3');
  await expect(page.getByText('0.30',{ exact: true })).toBeVisible();
});

// Waits: each slider toHaveValue its default, read before moving.
test('Reset to defaults puts all five sliders back @G9.21', async ({ eve, page, relay }) => {
  test.slow();
  await openVoiceView(eve, page, relay);
  await openSheet(page);
  const defaults = {};
  for (const name of SLIDERS) {
    defaults[name] = await page.getByRole('slider', { name, exact: true }).inputValue();
  }
  const moved = { 'Inner orb size': '0.7', 'Outer orb size': '1.3', 'Spin rate': '1.7', 'Idle jitter': '0.4', 'Speech jitter': '0.3' };
  for (const name of SLIDERS) {
    const slider = page.getByRole('slider', { name, exact: true });
    expect(moved[name]).not.toBe(defaults[name]);
    await slider.fill(moved[name]);
    await expect(slider).toHaveValue(moved[name]);
  }
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  for (const name of SLIDERS) {
    await expect(page.getByRole('slider', { name, exact: true })).toHaveValue(defaults[name]);
  }
});
