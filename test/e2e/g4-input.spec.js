const { test, expect, profiles } = require('./support/fixtures');
const worlds = require('./support/worlds');

// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function shellWorld() {
  const w = worlds.base();
  w.terminal_templates = [{ id: 'shell', name: 'Shell', command: '/bin/sh', description: 'A plain shell' }];
  return w;
}

// One project on an SSH host with its own terminal template.
function hostWorld() {
  const w = worlds.base();
  w.hosts = [
    {
      id: 'h_box',
      name: 'testbox',
      target: 'tester@testbox.example.test',
      agent: 'connected',
      probe: { at: '2026-10-01T00:00:00Z', ok: true, os: 'linux', arch: 'amd64', home: '/home/tester', shell: '/bin/sh', node_path: '/usr/bin/node', claude_path: '', tmux_path: '' },
      terminal_templates: [{ id: 'hshell', name: 'Host shell', command: '/bin/sh', description: 'A shell on the host' }],
    },
  ];
  w.projects = [{ id: 'p_remote', name: 'Remote', mode: 'work', host_id: 'h_box', path: '/home/tester/work', files: { 'notes.md': '# Notes\n' } }];
  w.default_project = { work: 'p_remote' };
  return w;
}

const rail = (page) => page.getByRole('navigation', { name: 'Projects' });

// Starts the Shell terminal from its Today tile and focuses its input.
async function startShell(page, tile = 'Shell', tab = 'Acme - Shell') {
  await page.getByRole('button', { name: tile, exact: true }).click();
  await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  await input.focus();
  return input;
}

// Opens a thread, then a Shell terminal beside it. Returns the thread's composer and the terminal input.
async function threadThenShell(eve, page) {
  await eve.open('/');
  await page.getByRole('textbox', { name: 'Ask' }).fill('hello from testbox');
  await page.getByRole('textbox', { name: 'Ask' }).press('Enter');
  const composer = page.getByRole('textbox', { name: 'Type your message...' });
  await expect(composer).toBeEnabled();
  await rail(page).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await page.getByRole('dialog', { name: 'Shell Launcher' }).getByRole('button', { name: 'Shell' }).click();
  await expect(page.getByRole('tab', { name: 'Acme - Shell' })).toHaveAttribute('aria-selected', 'true');
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  await input.focus();
  return { composer, input };
}

const showThread = (page) => page.getByRole('tab').first().click();

// The terminal draws a line as one span under an overlay, so the mouse reaches a link at the
// centre of its characters (the font is monospace).
async function pointAt(page, line, lineText, part) {
  const box = await line.boundingBox();
  const at = lineText.indexOf(part) + part.length / 2;
  const x = box.x + (box.width * at) / lineText.length;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  return { x, y };
}

// Drags across a whole line of terminal text.
async function selectLine(page, line) {
  const box = await line.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
  await page.mouse.up();
}

test.describe('console terminal', () => {
  test.use({ world: shellWorld() });

  test.describe('the browser lets the page use the clipboard', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('select text in a terminal to copy it @G4.5', async ({ eve, page }) => {
      const { composer } = await threadThenShell(eve, page);
      const copyme = `copyme-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await page.keyboard.type(copyme);
      const line = page.getByText(copyme, { exact: true });
      await expect(line).toBeVisible();
      await selectLine(page, line);
      await showThread(page);
      await composer.focus();
      await page.keyboard.press('ControlOrMeta+V');
      await expect(composer).toHaveValue(copyme);
    });
  });

  test.describe('the browser lets the page read the clipboard but not write it', () => {
    // Reading is allowed, so a copy would show; writing is left unpermitted.
    test.use({ permissions: ['clipboard-read'] });

    test('a browser that refuses clipboard writes copies nothing @G4.5.r1', async ({ eve, page }) => {
      const { composer } = await threadThenShell(eve, page);
      const copyme = `copyme-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await page.keyboard.type(copyme);
      const line = page.getByText(copyme, { exact: true });
      await expect(line).toBeVisible();
      await selectLine(page, line);
      await showThread(page);
      await composer.focus();
      await page.keyboard.press('ControlOrMeta+V');
      // The marker is typed after the paste, so a paste that worked would sit in front of it.
      await page.keyboard.type('marker');
      await expect(composer).toHaveValue('marker');
    });
  });

  test('paste text into a terminal @G4.6', async ({ eve, page, desktop }) => {
    await eve.open('/');
    const input = await startShell(page);
    await desktop.paste(input, ['pasted from the clipboard']);
    await expect(page.getByText('pasted from the clipboard', { exact: true })).toBeVisible();
  });

  test('open a web link printed in a terminal @G4.7', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    // A link to the machine itself, so the new tab can load.
    const link = `${eve.url.replace(/\/$/, '')}/guide`;
    const text = `see ${link} now`;
    await page.keyboard.type(text);
    const line = page.getByText(text, { exact: true });
    await expect(line).toBeVisible();
    const opened = page.context().waitForEvent('page');
    const at = await pointAt(page, line, text, link);
    await page.mouse.click(at.x, at.y);
    const tab = await opened;
    await tab.waitForURL(link);
  });

  test('open a generated image path printed in a terminal @G4.8', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    const path = '/api/generated/render-1.png';
    const text = `saved ${path} ok`;
    await page.keyboard.type(text);
    const line = page.getByText(text, { exact: true });
    await expect(line).toBeVisible();
    const at = await pointAt(page, line, text, path);
    await page.mouse.click(at.x, at.y);
    await expect(page.getByRole('img', { name: 'Generated image' })).toBeVisible();
  });

  test('paste an image into a terminal on this machine @G4.9', async ({ eve, page, desktop }) => {
    await eve.open('/');
    const input = await startShell(page);
    await desktop.paste(input, [{ name: 'image.png', type: 'image/png', base64: PNG_BASE64 }]);
    await expect(page.getByText(/eve-paste-\d+-\w+\.png/)).toBeVisible();
  });

  test('drop an image file onto a terminal @G4.11', async ({ eve, page, desktop }) => {
    await eve.open('/');
    const input = await startShell(page);
    await desktop.dropFiles(input, [{ name: 'shot.png', type: 'image/png', size: 64 }]);
    await expect(page.getByText(/eve-paste-\d+-\w+\.png/)).toBeVisible();
  });
});

test.describe('console terminal, resized', () => {
  test.use({ world: shellWorld() });

  test('keep the terminal fitted when the window changes size @G4.12', async ({ eve, page }) => {
    await eve.open('/');
    await startShell(page);
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789-'.repeat(3);
    await page.keyboard.type(long);
    await expect(page.getByText(long, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // The one line re-wraps into several rows, so no single row holds it any more.
    await expect(page.getByText(long, { exact: true })).toBeHidden();
    await expect(page.getByText(long.slice(0, 20))).toBeVisible();
    // The screen is not drawn twice: a new marker shows once.
    await page.keyboard.type('marker-after-resize');
    await expect(page.getByText('marker-after-resize')).toHaveCount(1);
    await expect(page.getByText(long.slice(0, 20))).toHaveCount(1);
  });
});

test.describe('console terminal on a touch screen', () => {
  test.use({ world: shellWorld(), ...profiles.phone });

  test('scroll a terminal history by dragging on a touch screen @G4.13', async ({ eve, page, touch }) => {
    await eve.open('/');
    // A phone shows no tab strip: the terminal opens full screen under its title.
    await page.getByRole('button', { name: 'Shell', exact: true }).click();
    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    const lines = Array.from({ length: 80 }, (_, i) => `history line ${String(i + 1).padStart(3, '0')}`);
    await page.keyboard.type(lines.join('\n'));
    const last = page.getByText(lines[79], { exact: true });
    await expect(last).toBeVisible();
    // The screen holds about 30 rows, so a line from the middle of the output is off screen.
    const earlier = page.getByText(lines[39], { exact: true });
    await expect(earlier).toBeHidden();
    await touch.swipe(last, { dx: 0, dy: 600 });
    await expect(earlier).toBeVisible();
  });
});

test.describe('terminal on an SSH host', () => {
  test.use({ world: hostWorld() });

  test('paste an image into a terminal on an SSH host @G4.10', async ({ eve, page, relay, desktop }) => {
    await eve.open('/');
    const input = await startShell(page, 'Host shell', 'Remote - Host shell');
    await desktop.paste(input, [{ name: 'image.png', type: 'image/png', base64: PNG_BASE64 }]);
    await relay.waitForEvent('host.pastetmp', { match: (l) => l.status === 'ok' && l.host_id === 'h_box' });
    await expect(page.getByText(/\/tmp\/\S*eve-paste-\d+-\w+\.png/)).toBeVisible();
  });
});
