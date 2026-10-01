// S1-A5 Ask with typing and Return: one thread in the mode's default project, no
// dialog first. docs/design-today-s1.md
const { test, expect } = require('./fixture');
const { MODELS } = require('./fixture');
const { startChatInAlpha } = require('./today-helpers');

const ask = (page) => page.getByTestId('today-ask-input');
const sentTexts = (eve) => eve.relay.inbound.filter((m) => m.type === 'send_message').map((m) => m.text);

// Records any dialog that appears, for the whole run of a spec, not just the end.
async function watchDialogs(page) {
  await page.evaluate(() => {
    window.__dialogsSeen = [];
    const note = (el) => {
      if (el.nodeType !== 1) return;
      const hit = el.matches?.('[data-testid^="dialog-"], #sessionModal, #permissionModal') ? el : el.querySelector?.('[data-testid^="dialog-"]');
      if (hit && hit.offsetParent !== null) window.__dialogsSeen.push(hit.getAttribute('data-testid') || hit.id);
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach(note);
        if (m.type === 'attributes') note(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  });
}
const dialogsSeen = (page) => page.evaluate(() => window.__dialogsSeen);

test.describe('S1-A5 Ask', () => {
  test.use({
    world: {
      seed: ({ relay }) => {
        relay.setModels(MODELS);
        relay.setDefaultProject('work', 'beta');
      },
    },
  });

  test('Return creates one thread in the mode\'s default project and sends the text; no dialog at any moment', async ({ page, eve }) => {
    await expect(ask(page)).toBeFocused();
    await watchDialogs(page);
    await page.keyboard.type('what is in the README?');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('messages-container')).toContainText('what is in the README?');
    await expect(page.getByTestId('messages-container')).toContainText('Hello from fake relay', { timeout: 15000 });
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'beta', directory: eve.folders.beta });
    expect(sentTexts(eve)).toEqual([expect.stringContaining('what is in the README?')]);
    expect(await dialogsSeen(page)).toEqual([]);
  });

  test('Shift+Return adds a line and starts nothing; empty Return does nothing', async ({ page, eve }) => {
    await ask(page).press('Enter');
    await ask(page).type('first');
    await ask(page).press('Shift+Enter');
    await ask(page).type('second');
    await expect(ask(page)).toHaveValue('first\nsecond');
    await page.waitForTimeout(300);
    expect(eve.relay.sessionCreates).toHaveLength(0);
  });

  test('a refusal keeps the text and says what happened in plain words', async ({ page, eve }) => {
    eve.relay.failSessionCreateWith(403, { error: 'model not allowed for this project' });
    await ask(page).fill('please');
    await ask(page).press('Enter');
    await expect(page.getByTestId('today-ask-status')).toContainText("isn't allowed");
    await expect(page.getByTestId('today-ask-status')).not.toContainText('HTTP');
    await expect(ask(page)).toHaveValue('please');
    eve.relay.clearSessionCreateFail();
  });
});

test.describe('S1-A5 Ask picks its project', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); } } });

  test('with no default and two in-mode projects: an inline pick, no dialog, and the pick is used', async ({ page, eve }) => {
    await expect(page.getByTestId('today-ask-project')).toBeVisible();
    await watchDialogs(page);
    await page.getByTestId('today-ask-project').selectOption('beta');
    await ask(page).fill('hello');
    await ask(page).press('Enter');
    await expect.poll(() => eve.relay.sessionCreates.length).toBe(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'beta' });
    expect(await dialogsSeen(page)).toEqual([]);
  });
});

test.describe('S1-A5 Ask with one in-mode project', () => {
  test.use({
    world: {
      projects: ({ alpha }) => [{ id: 'alpha', name: 'Alpha Project', path: alpha }],
      seed: ({ relay }) => { relay.setModels(MODELS); },
    },
  });

  test('uses it silently: no pick is offered', async ({ page, eve }) => {
    await expect(page.getByTestId('today-ask-project')).toHaveCount(0);
    await ask(page).fill('hello');
    await ask(page).press('Enter');
    await expect.poll(() => eve.relay.sessionCreates.length).toBe(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ projectId: 'alpha' });
  });
});

test.describe('S1-A5 Ask waits for models', () => {
  let gate;
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.setDefaultProject('work', 'alpha'); gate = relay.holdModels(); } } });

  test('Return before the model list arrives sends once it does', async ({ page, eve }) => {
    await ask(page).fill('early');
    await ask(page).press('Enter');
    await page.waitForTimeout(400);
    expect(eve.relay.sessionCreates).toHaveLength(0);
    gate.release();
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
  });
});

test.describe('S1-A5 Ask with relay down', () => {
  test('Send is disabled, the line says why, and the text stays', async ({ page, eve }) => {
    await eve.relay.close();
    await page.reload();
    await page.waitForFunction(() => !!window.client?.state);
    await expect(page.getByTestId('today-ask-status')).toContainText("Can't reach relay");
    await expect(page.getByTestId('today-ask-send')).toBeDisabled();
    await ask(page).fill('typed while down');
    await ask(page).press('Enter');
    await expect(ask(page)).toHaveValue('typed while down');
  });
});

test.describe('S1-A5 a refusal is attributed to Ask only for a pending Ask', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.setDefaultProject('work', 'alpha'); } } });

  test('a session-less error frame with no Ask pending leaves the Ask line alone', async ({ page, eve }) => {
    await eve.relay.emitToRelay({ type: 'error', message: 'model not allowed for this project' });
    await page.waitForTimeout(300);
    await expect(page.getByTestId('today-ask-status')).not.toContainText("isn't allowed");
  });
});

test.describe('S1-A5 Ask while eve\'s own socket is down', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.setDefaultProject('work', 'beta'); } } });

  test('Return says so in plain words, keeps the text, recovers on reconnect, and never leaks into a later thread', async ({ page, eve }) => {
    // Hold the reconnect off so the socket stays down until the test says so.
    await page.evaluate(() => {
      const ws = window.client.wsClient;
      ws.reconnectDelay = 600000;
      ws.ws.close();
    });
    await page.waitForFunction(() => window.client.state.connection.browser === false);

    await ask(page).fill('typed while offline');
    await ask(page).press('Enter');
    const status = page.getByTestId('today-ask-status');
    await expect(status).not.toHaveText('');
    await expect(status).not.toContainText('Starting');
    await expect(ask(page)).toHaveValue('typed while offline');
    expect(eve.relay.sessionCreates).toHaveLength(0);

    // Back online: Send works again, nothing is stuck on Starting.
    await page.evaluate(() => window.client.wsClient.forceReconnect());
    await page.waitForFunction(() => window.client.state.connection.browser === true);
    await expect(page.getByTestId('today-ask-send')).toBeEnabled();
    await expect(status).not.toContainText('Starting');
    await expect(ask(page)).toHaveValue('typed while offline');

    // A thread started from the launcher must not receive the old Ask text.
    await startChatInAlpha(page);
    await page.waitForTimeout(500);
    expect(sentTexts(eve)).not.toContain('typed while offline');
  });
});
