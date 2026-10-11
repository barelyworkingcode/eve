const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const GREETING = /^(Good morning|Good afternoon|Good evening|Working late)\.$/;

function threadWorld() {
  const w = worlds.base();
  w.sessions = [
    { id: 's_a1', project_id: 'p_acme', name: 'Ledger', model: 'haiku', state: 'dormant', messages: [{ role: 'user', text: 'question in Ledger' }, { role: 'assistant', text: 'answer in Ledger' }] },
  ];
  return w;
}

test.describe('front door', () => {
  test.use({ world: threadWorld() });

  // A fresh browser context has no stamp of earlier activity, which eve counts as away.
  // Whether earlier tabs stay closed after an hour away is left open (G3.15's question).
  test('a browser away from eve opens on Today with Ask ready @G14.26', async ({ eve, page }) => {
    await eve.open('/');
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Ask' })).toBeFocused();
    await expect(page.getByRole('tab')).toHaveCount(0);
  });

  test('a link to a thread still opens that thread @G14.26', async ({ eve, page }) => {
    await eve.open('/#session/s_a1');
    await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('answer in Ledger')).toBeVisible();
  });

  test('a deep link shows the linked view instead of Today @G14.26.r1', async ({ eve, page }) => {
    await eve.open('/#project/p_acme');
    await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: GREETING })).toBeHidden();
  });
});
