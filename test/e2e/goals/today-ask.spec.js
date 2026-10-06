// S1-A5 Ask with typing and Return: one thread in the mode's default project, no
// dialog first. docs/design-today-s1.md
const { test, expect } = require('./fixture');
const { reloadEve } = require('../fixtures');
const { MODELS } = require('./fixture');
const { startChatInAlpha } = require('./today-helpers');
const { watchSocket, sentTypes, sentFrames, waitHandled } = require('../socket-watch');

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
    await watchSocket(page);
    await ask(page).press('Enter');
    await ask(page).type('first');
    await ask(page).press('Shift+Enter');
    await ask(page).type('second');
    await expect(ask(page)).toHaveValue('first\nsecond');
    expect(await sentTypes(page)).not.toContain('create_session');
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
    await watchSocket(page);
    await ask(page).fill('early');
    await ask(page).press('Enter');
    expect(await sentTypes(page)).not.toContain('create_session');
    expect(eve.relay.sessionCreates).toHaveLength(0);
    gate.release();
    await expect.poll(() => eve.relay.sessionCreates.length, { timeout: 15000 }).toBe(1);
  });
});

test.describe('S1-A5 Ask with relay down', () => {
  test('Send is disabled, the line says why, and the text stays', async ({ page, eve }) => {
    await eve.relay.close();
    await reloadEve(page);
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
    await watchSocket(page);
    await eve.relay.emitToRelay({ type: 'error', message: 'model not allowed for this project' });
    await waitHandled(page, { type: 'error' });
    await expect(page.getByTestId('today-ask-status')).not.toContainText("isn't allowed");
  });
});

test.describe('S1-A5 Ask while eve\'s own socket is down', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.setDefaultProject('work', 'beta'); } } });

  test('Return says so in plain words, keeps the text, recovers on reconnect, and never leaks into a later thread', async ({ page, eve }) => {
    // A drop after eve was ready, not during its first start (where Ask queues).
    await page.waitForFunction(() => window.client.state.connection.browser === true);
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
    await expect(status).toContainText('Not connected to eve');
    await expect(status).not.toContainText('Starting');
    await expect(ask(page)).toHaveValue('typed while offline');
    expect(eve.relay.sessionCreates).toHaveLength(0);

    // Back online: Send works again, nothing is stuck on Starting.
    await page.evaluate(() => window.client.wsClient.forceReconnect());
    await page.waitForFunction(() => window.client.state.connection.browser === true);
    await watchSocket(page); // the reconnect opened a new socket
    await expect(page.getByTestId('today-ask-send')).toBeEnabled();
    await expect(status).not.toContainText('Starting');
    await expect(ask(page)).toHaveValue('typed while offline');

    // A thread started from the launcher must not receive the old Ask text.
    await startChatInAlpha(page);
    await waitHandled(page, { type: 'session_created' });
    expect((await sentFrames(page)).filter((f) => f.type === 'user_input' && String(f.text).includes('typed while offline'))).toEqual([]);
    expect(sentTexts(eve)).not.toContain('typed while offline');
  });
});

// Holds eve's socket at the point auth_success arrives: everything from it on is
// kept from the page until release(). `held` resolves once auth_success is caught.
async function holdAuth(page, baseUrl) {
  const host = new URL(baseUrl).host;
  const isAuthSuccess = (m) => {
    try {
      const d = JSON.parse(m);
      return d.type === 'auth_success' || (d.type === '__batch' && d.msgs.some((x) => x.type === 'auth_success'));
    } catch { return false; }
  };
  const kept = [];
  let open = false;
  let caught;
  const held = new Promise((resolve) => { caught = resolve; });
  await page.routeWebSocket((url) => url.host === host, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (!open && (kept.length || isAuthSuccess(m))) { kept.push([ws, m]); caught(); return; }
      ws.send(m);
    });
  });
  await page.reload(); // pre-ready: holdAuth; waits on `held`
  await page.waitForFunction(() => !!window.client?.state);
  await held;
  return { release: () => { open = true; for (const [ws, m] of kept.splice(0)) ws.send(m); } };
}

test.describe('S1-A5 Ask before eve is ready', () => {
  test.use({ world: { seed: ({ relay }) => { relay.setModels(MODELS); relay.setDefaultProject('work', 'beta'); } } });

  test('Return while starting queues the question and sends it once eve is ready, with no second Return', async ({ page, eve }) => {
    const gate = await holdAuth(page, eve.baseUrl);
    expect(await page.evaluate(() => window.client.state.connection.browser)).not.toBe(true);
    await ask(page).fill('what is in the README?');
    await ask(page).press('Enter');
    await expect(page.getByTestId('today-ask-status')).toContainText('Sending when eve is ready…');
    expect(eve.relay.sessionCreates).toHaveLength(0);

    gate.release();
    await expect(page.getByTestId('messages-container')).toContainText('what is in the README?', { timeout: 15000 });
    await expect(page.getByTestId('messages-container')).toContainText('Hello from fake relay', { timeout: 15000 });
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(sentTexts(eve)).toEqual([expect.stringContaining('what is in the README?')]);
  });

  test('editing the text while queued keeps the queue and sends the edited text, not the original', async ({ page, eve }) => {
    const gate = await holdAuth(page, eve.baseUrl);
    await ask(page).fill('first draft');
    await ask(page).press('Enter');
    await expect(page.getByTestId('today-ask-status')).toContainText('Sending when eve is ready…');
    await ask(page).fill('second draft');
    await expect(page.getByTestId('today-ask-status')).toContainText('Sending when eve is ready…');

    gate.release();
    await expect(page.getByTestId('messages-container')).toContainText('second draft', { timeout: 15000 });
    // The question shows locally before it reaches relay; the reply means relay has it.
    await expect(page.getByTestId('messages-container')).toContainText('Hello from fake relay', { timeout: 15000 });
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(sentTexts(eve)).toEqual([expect.stringContaining('second draft')]);
    expect(sentTexts(eve).join('\n')).not.toContain('first draft');
  });

  test('Return after eve connects but before projects load queues the question and sends it once they do', async ({ page, eve }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let hit;
    const held = new Promise((resolve) => { hit = resolve; });
    await page.route('**/api/projects', async (route) => { hit(); await gate; await route.continue(); });
    await page.reload(); // pre-ready: holds /api/projects; waits on `held`
    await page.waitForFunction(() => window.client?.state?.connection.browser === true);
    await held;

    await ask(page).fill('what is in the README?');
    await ask(page).press('Enter');
    await expect(page.getByTestId('today-ask-status')).toContainText('Sending when eve is ready…');
    expect(eve.relay.sessionCreates).toHaveLength(0);

    release();
    await expect(page.getByTestId('messages-container')).toContainText('what is in the README?', { timeout: 15000 });
    await expect(page.getByTestId('messages-container')).toContainText('Hello from fake relay', { timeout: 15000 });
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(sentTexts(eve)).toEqual([expect.stringContaining('what is in the README?')]);
  });
});

test.describe('S1-A5 Ask queued while starting, then blocked for good', () => {
  test.use({
    world: {
      projects: ({ beta }) => [{ id: 'hm', name: 'Home Only', path: beta, mode: 'home' }],
      seed: ({ relay }) => { relay.setModels(MODELS); },
    },
  });

  test('no project in the mode: the queue is dropped, the reason shows, the text stays, nothing is sent', async ({ page, eve }) => {
    const gate = await holdAuth(page, eve.baseUrl);
    await watchSocket(page);
    await ask(page).fill('early question');
    await ask(page).press('Enter');
    await expect(page.getByTestId('today-ask-status')).toContainText('Sending when eve is ready…');

    gate.release();
    await expect(page.getByTestId('today-ask-status')).toContainText('No projects in Work yet');
    await expect(ask(page)).toHaveValue('early question');
    expect(await sentTypes(page)).not.toContain('create_session');
    expect(eve.relay.sessionCreates).toHaveLength(0);
    expect(sentTexts(eve)).toEqual([]);
  });
});
