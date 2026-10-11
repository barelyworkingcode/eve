const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

test.use({ mic: 'silence' });

// Power path: a voice chat template of the Work project, marked as the Work voice preset.
function voiceWorld({ preset = true, defaultProject = true } = {}) {
  const world = worlds.base();
  if (preset) {
    world.projects[0].chat_templates = [
      {
        id: 't_voice',
        name: 'Voice - Acme',
        model: 'sonnet',
        mode: 'voice',
        voice: true,
        system_prompt: 'Talk briefly.',
        preset_for: ['work'],
      },
    ];
  }
  if (!defaultProject) {
    // With one project the mode falls back to it; two projects and no default leave the mode without one.
    delete world.default_project;
    world.projects.push({ id: 'p_beta', name: 'Beta', mode: 'work' });
  }
  return world;
}

async function startFromTodayTile(page) {
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
  await page.getByRole('button', { name: 'Start Voice Chat' }).click();
}

// The chat is open in Hands-free: the radio is checked and the status listens. The removed
// full-screen view leaves no "End session" button and no "Hold to record" button behind.
async function expectHandsFree(page) {
  await expect(page.getByRole('radiogroup', { name: 'Voice mode' }).getByRole('radio', { name: 'Hands-free' })).toBeChecked();
  await expect(page.getByRole('status', { name: 'Voice status' }).getByText('Listening…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hold to record' })).toHaveCount(0);
}

// No chat opened: no mode radios and no voice status.
async function expectNoChat(page) {
  await expect(page.getByRole('radiogroup', { name: 'Voice mode' })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Voice status' })).toHaveCount(0);
}

// Waits: the radio checked, then the status "Listening…", then session.launch.
test('the Today Voice tile starts a voice chat in Hands-free @G9.1', async ({ eve, page, relay }) => {
  await eve.open('/');
  const since = await relay.mark();
  await startFromTodayTile(page);
  await expectHandsFree(page);
  await relay.waitForEvent('session.launch', { since });
});

test.describe('a project that allows no model', () => {
  test.use({
    world: (() => {
      const world = worlds.base();
      world.projects[0].allowed_models = ['none-such'];
      return world;
    })(),
  });

  // Waits: the toast text; no chat opens.
  test('no model picked: the Today Voice tile refuses with a toast @G9.1.r1', async ({ eve, page }) => {
    await eve.open('/');
    await startFromTodayTile(page);
    await expect(page.getByText(/^Pick a model for "Voice - .*" before starting a chat\.$/)).toBeVisible();
    await expectNoChat(page);
  });

  test('no model picked: the Launcher Voice Chat card refuses with a toast @G9.2.r1', async ({ eve, page }) => {
    await eve.open('/');
    await page.getByRole('button', { name: 'New Session' }).click();
    await page.getByRole('button', { name: 'Voice Chat' }).click();
    await page.getByRole('button', { name: 'Start Voice Chat' }).click();
    await expect(page.getByText(/^Pick a model for "Voice - .*" before starting a chat\.$/)).toBeVisible();
    await expectNoChat(page);
  });
});

// Waits: the Launcher's button "Start Voice Chat", the radio and status, session.launch.
test('the Launcher Voice Chat card starts a voice chat in Hands-free @G9.2', async ({ eve, page, relay }) => {
  await eve.open('/');
  const since = await relay.mark();
  await page.getByRole('button', { name: 'New Session' }).click();
  await page.getByRole('button', { name: 'Voice Chat' }).click();
  await page.getByRole('button', { name: 'Start Voice Chat' }).click();
  await expectHandsFree(page);
  await relay.waitForEvent('session.launch', { since });
});

test.describe('a Work voice preset and a default project', () => {
  test.use({ world: voiceWorld() });

  // Waits: the Hands-free radio and status, then session.launch from the link.
  test('the deep link starts the Work voice preset in Hands-free @G9.4', async ({ eve, page, relay }) => {
    await eve.open('/');
    const since = await relay.mark();
    await eve.open('/#/voice-chat');
    await expectHandsFree(page);
    const launch = await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
    await expect(page.getByRole('tab', { name: /Voice/ })).toBeVisible();
    const made = (await relay.json('ctl', 'state', '--json')).sessions.find((s) => s.id === launch.session_id);
    expect(made.model).toBe('sonnet');
  });

  test('the Action Button link starts the current mode voice chat @G15.2', async ({ eve, page, relay }) => {
    await eve.open('/');
    const since = await relay.mark();
    await eve.open('/#/voice-chat');
    await expectHandsFree(page);
    const launch = await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
    // A second press reuses the recent voice thread.
    await eve.open('/#/voice-chat');
    await expectHandsFree(page);
    expect(await relay.logs({ event: 'session.launch', since })).toHaveLength(1);
    // The same thread: one Voice tab and one session, not a second of either.
    await expect(page.getByRole('tab', { name: /Voice/ })).toHaveCount(1);
    const sessions = (await relay.json('ctl', 'state', '--json')).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions.find((s) => s.id === launch.session_id).model).toBe('sonnet');
  });
});

// Home half: the same link in Home mode starts the Home voice preset, on its own model.
function homeVoiceWorld() {
  const world = voiceWorld();
  world.projects.push({
    id: 'p_home',
    name: 'Hearth',
    mode: 'home',
    chat_templates: [
      {
        id: 't_home_voice',
        name: 'Voice - Hearth',
        model: 'opus',
        mode: 'voice',
        voice: true,
        system_prompt: 'Talk briefly.',
        preset_for: ['home'],
      },
    ],
  });
  world.default_project = { home: 'p_home', work: 'p_acme' };
  return world;
}

test.describe('a Home voice preset and a Home default project', () => {
  test.use({ world: homeVoiceWorld() });

  // Waits: the radio checked, the Hands-free radio and status, then session.launch from the link.
  test('the deep link in Home mode starts the Home voice preset @G9.4', async ({ eve, page, relay }) => {
    await eve.open('/');
    await page.getByRole('radio', { name: 'Home' }).click();
    await expect(page.getByRole('radio', { name: 'Home' })).toBeChecked();
    const since = await relay.mark();
    await eve.open('/#/voice-chat');
    await expectHandsFree(page);
    const launch = await relay.waitForEvent('session.launch', { since, match: (l) => l.status === 'ok' });
    const made = (await relay.json('ctl', 'state', '--json')).sessions.find((s) => s.id === launch.session_id);
    expect(made.model).toBe('opus');
  });
});

test.describe('a default project but no voice preset', () => {
  test.use({ world: voiceWorld({ preset: false }) });

  // Waits: the toast text, then the Templates tab of the Project dialog.
  test('no voice preset: a toast points to Edit Project @G9.5 @G9.5.r1 @G15.2.r2', async ({ eve, page }) => {
    await eve.open('/');
    await eve.open('/#/voice-chat');
    await expect(page.getByText(/^No Work voice preset\. Pick one in Edit Project/)).toBeVisible();
    // The Launcher opens on its Voice Chat form instead.
    await expect(page.getByRole('heading', { name: 'Shell Launcher' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Voice Chat' })).toBeVisible();
    await expectNoChat(page);
  });
});

test.describe('no default project', () => {
  test.use({ world: voiceWorld({ defaultProject: false }) });

  // Waits: the toast text; no chat opens.
  test('no default project: a toast and no chat @G9.6 @G9.6.r1 @G15.2.r1', async ({ eve, page }) => {
    await eve.open('/');
    await eve.open('/#/voice-chat');
    await expect(page.getByText('Set a default Work project in Relay to use the Action Button.')).toBeVisible();
    await expectNoChat(page);
  });
});
