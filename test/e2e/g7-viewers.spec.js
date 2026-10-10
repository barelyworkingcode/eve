const { test, expect } = require('./support/fixtures');
const worlds = require('./support/worlds');

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">' +
  '<rect width="40" height="20" fill="#336699"/></svg>\n';

function viewersWorld() {
  const w = worlds.base();
  w.projects[0].files = {
    'README.md': '# Acme\n',
    'logo.svg': SVG,
    'broken.png': 'this is not a png\n',
    'manual.pdf': '%PDF-1.4\n%%EOF\n',
    'clip.mp4': 'this is not a video\n',
    'tune.mp3': 'this is not audio\n',
    'clip.webm': worlds.media.webm(),
    'tune.wav': worlds.media.wav(),
  };
  return w;
}

test.use({ world: viewersWorld() });

async function openFiles(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Acme' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  return page.getByRole('tree', { name: 'Files' });
}

test('open an image file @G7.16', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  await tree.getByRole('treeitem', { name: 'logo.svg', exact: true }).click();
  await expect(page.getByRole('img', { name: 'logo.svg', exact: true })).toBeVisible();
  await expect(page.getByText('/logo.svg')).toBeVisible();
  await expect(page.getByText(/^\d+ × \d+$/)).toBeVisible();
  await relay.waitForEvent('file.stream', { since, match: (l) => l.status === 'ok' });
});

test('an image that will not load says so @G7.16.r1', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'broken.png', exact: true }).click();
  await expect(page.getByText('Failed to load image')).toBeVisible();
});

test('open a PDF file @G7.17', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  await tree.getByRole('treeitem', { name: 'manual.pdf', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'manual.pdf', exact: true })).toBeVisible();
  await expect(page.getByText('/manual.pdf')).toBeVisible();
  await relay.waitForEvent('file.stream', { since, match: (l) => l.status === 'ok' });
});

test('open a video file @G7.18', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  await tree.getByRole('treeitem', { name: 'clip.webm', exact: true }).click();
  const player = page.getByLabel('Video clip.webm', { exact: true });
  await expect(player).toBeVisible();
  await expect(player).toHaveJSProperty('controls', true);
  await expect(page.getByText('/clip.webm')).toBeVisible();
  await relay.waitForEvent('file.stream', { since, match: (l) => l.status === 'ok' });
  // The length is the time the native controls show; decoding has no app hook, so the expect bound is the wait.
  await expect(player).toHaveJSProperty('duration', 1.008);
});

test('a video that will not play says so @G7.18.r1', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'clip.mp4', exact: true }).click();
  await expect(page.getByText('Failed to load video')).toBeVisible();
});

test('open an audio file @G7.19', async ({ eve, page, relay }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  const since = relay.mark();
  await tree.getByRole('treeitem', { name: 'tune.wav', exact: true }).click();
  const player = page.getByLabel('Audio tune.wav', { exact: true });
  await expect(player).toBeVisible();
  await expect(player).toHaveJSProperty('controls', true);
  await expect(page.getByText('tune.wav', { exact: true }).last()).toBeVisible();
  await relay.waitForEvent('file.stream', { since, match: (l) => l.status === 'ok' });
  await expect(player).toHaveJSProperty('duration', 1);
});

test('an audio file that will not play says so @G7.19.r1', async ({ eve, page }) => {
  await eve.open('/');
  const tree = await openFiles(page);
  await tree.getByRole('treeitem', { name: 'tune.mp3', exact: true }).click();
  await expect(page.getByText('Failed to load audio')).toBeVisible();
});
