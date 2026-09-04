/**
 * Characterisation suite for tab-manager.js (pane-registry refactor,
 * docs/decisions/001-feature-registry.md's sibling for panes) — pins CURRENT
 * behaviour, bugs included, as a refactor safety net, not a correctness spec.
 * Two deliberately-pinned oddities: an image tab clears location.hash
 * instead of linking to it, and a restored module tab's label is the raw
 * moduleName, not the manifest's displayName.
 *
 * Tests 9-13 drive TabManager's API via page.evaluate instead of
 * synthesizing pointer events, because PaneDnd is timing-sensitive and this
 * suite pins TabManager, not the drag gesture. Voice-session state is seeded
 * directly rather than through a real session, because activating a real
 * voice session reaches for a microphone via getUserMedia and hangs headless
 * Chromium with no audio device.
 *
 * Terminal panes are never opened end to end: the fake relay only
 * implements GET /api/terminals/:id/log, not terminal creation over WS.
 * This is a recorded gap, not covered ground.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const base = require('@playwright/test');
const { test, expect, testWithModule } = require('./fixtures');
const { startEve } = require('../integration/harness');
const legacyStorageTemplate = require('./fixtures/legacy-tab-storage.json');

// Real bytes — the image viewer's <img> load event needs them; content is
// otherwise irrelevant to what's under test.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function openChat(page) {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
}

// Same press-duration technique as voice-buttons.spec.js's long-press gate.
async function press(page, locator, ms) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

// Patches the native WebSocket underlying wsClient, not wsClient.send()'s
// object-in/JSON-out wrapper — same technique as chat-input-row.spec.js's
// plan-mode test, one level lower.
async function framesSentClicking(page, testid, type, settleMs = 400) {
  return page.evaluate(
    async ({ testid, type, settleMs }) => {
      const rawWs = window.client.wsClient.ws;
      const original = rawWs.send.bind(rawWs);
      const frames = [];
      rawWs.send = (m) => { frames.push(JSON.parse(m)); return original(m); };
      document.querySelector(`[data-testid="${testid}"]`).click();
      await new Promise((r) => setTimeout(r, settleMs));
      rawWs.send = original;
      return frames.filter((f) => f && f.type === type);
    },
    { testid, type, settleMs }
  );
}

test.describe('tab-panes', () => {
  test('1. opening a chat creates a session tab, shows #chat, hides #editor, and sets the hash', async ({ page }) => {
    await openChat(page);
    const sessionId = await page.evaluate(() => window.client.currentSessionId);

    const tab = page.getByTestId(`tab-${sessionId}`);
    await expect(tab).toBeVisible();
    await expect(tab.locator('.tab-label')).toContainText('E2E Project');
    await expect(page.locator('#chat')).not.toHaveClass(/hidden/);
    await expect(page.locator('#editor')).toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#session/${sessionId}`);
  });

  test('2. clicking a text file in the tree opens the editor, hashes it, and sends watch_file', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await expect(page.getByTestId('file-tree-item-/README.md')).toBeVisible({ timeout: 15000 });

    const sent = await framesSentClicking(page, 'file-tree-item-/README.md', 'watch_file');

    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#editor')).not.toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => location.hash))
      .toBe(`#file/p1/${encodeURIComponent('/README.md')}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ projectId: 'p1', path: '/README.md', binary: false });
  });

  test('3. opening a .png shows the file viewer and sends watch_file with binary:true', async ({ page, eve }) => {
    fs.writeFileSync(path.join(eve.projectDir, 'photo.png'), TINY_PNG);
    await page.getByTestId('sidebar-project-p1').click();
    await expect(page.getByTestId('file-tree-item-/photo.png')).toBeVisible({ timeout: 15000 });

    const sent = await framesSentClicking(page, 'file-tree-item-/photo.png', 'watch_file');

    await expect(page.locator('#fileViewer')).not.toHaveClass(/hidden/);
    await expect(page.locator('#fileViewerPath')).toHaveText('/photo.png');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ projectId: 'p1', path: '/photo.png', binary: true });
  });

  test('4. closing a file tab hides the editor, sends unwatch_file, and forgets it', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    const sent = await framesSentClicking(page, 'tab-close-p1:/README.md', 'unwatch_file');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ projectId: 'p1', path: '/README.md' });
    await expect(page.locator('#editor')).toHaveClass(/hidden/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('eve-open-files') || '{}'));
    expect(stored).not.toHaveProperty('p1:/README.md');
  });

  test('5. a modified file marks its tab, and closing prompts before discarding', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => window.client.tabManager.setFileModified('p1', '/README.md', true));
    await expect(page.getByTestId('tab-p1:/README.md').locator('.tab-label')).toHaveText('README.md ●');

    let dialogMessage = null;
    page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.dismiss(); });
    await page.getByTestId('tab-close-p1:/README.md').click();
    await expect.poll(() => dialogMessage).toContain('unsaved changes');
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible();
  });

  test('6. closing the last tab in a project shows the welcome screen and clears the hash', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('tab-close-p1:/README.md').click();
    await expect(page.locator('#welcomeScreen')).not.toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  });

  test('7. Cmd/Ctrl+W closes the active tab', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
    await expect(page.getByTestId('tab-p1:/README.md')).toHaveCount(0);
    await expect(page.locator('#welcomeScreen')).not.toHaveClass(/hidden/);
  });

  test('8. a 500ms press on a session tab close button deletes the session; a short tap only closes', async ({ page }) => {
    await openChat(page);
    await page.evaluate(() => {
      window.__deleteCalls = [];
      window.client.deleteSession = (id) => window.__deleteCalls.push(id);
    });
    const sessionId1 = await page.evaluate(() => window.client.currentSessionId);

    await press(page, page.getByTestId(`tab-close-${sessionId1}`), 50);
    await expect(page.getByTestId(`tab-${sessionId1}`)).toHaveCount(0);
    expect(await page.evaluate(() => window.__deleteCalls)).toEqual([]);

    await openChat(page);
    const sessionId2 = await page.evaluate(() => window.client.currentSessionId);
    await press(page, page.getByTestId(`tab-close-${sessionId2}`), 600);
    expect(await page.evaluate(() => window.__deleteCalls)).toEqual([sessionId2]);
  });

  test('9. openImageTab shows the viewer with the given title; refreshImageTab from another project is rejected', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();

    const opened = await page.evaluate(() => {
      window.client.tabManager.openImageTab('eve-llm-1', '/api/generated/x.png', 'Generated', { actor: 'llm', projectId: 'p1' });
      return {
        viewerHidden: document.getElementById('fileViewer').classList.contains('hidden'),
        title: document.getElementById('fileViewerPath').textContent,
      };
    });
    expect(opened).toEqual({ viewerHidden: false, title: 'Generated' });

    const refreshed = await page.evaluate(() =>
      window.client.tabManager.refreshImageTab('eve-llm-1', { actor: 'llm', projectId: 'p2' }, '/api/generated/y.png')
    );
    expect(refreshed).toBe(false);
    const urlAfter = await page.evaluate(() => window.client.tabManager.tabs.find((t) => t.id === 'eve-llm-1').url);
    expect(urlAfter).toBe('/api/generated/x.png');
  });

  test('10. setPaneB shows both containers, marks the split classes, and mounts a divider + two undock buttons', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    const result = await page.evaluate((directory) => {
      const tm = window.client.tabManager;
      // openTerminal has no side effects, so safe to drive directly.
      // Directory must resolve under p1 (longest-prefix match) or render()
      // hides it as belonging to no active project.
      tm.openTerminal('term-1', 'Term', directory);
      tm.setPaneB('p1:/README.md', 'term-1', 'row', false);
      return {
        editorHidden: document.getElementById('editor').classList.contains('hidden'),
        terminalHidden: document.getElementById('terminal').classList.contains('hidden'),
        splitClasses: [...document.getElementById('contentArea').classList],
        dividerCount: document.querySelectorAll('.pane-divider').length,
        undockCount: document.querySelectorAll('.pane-undock').length,
      };
    }, eve.projectDir);

    expect(result.editorHidden).toBe(false);
    expect(result.terminalHidden).toBe(false);
    expect(result.splitClasses).toEqual(expect.arrayContaining(['content-area--split', 'content-area--row']));
    expect(result.dividerCount).toBe(1);
    expect(result.undockCount).toBe(2);
  });

  test('11. undockPane collapses the split; the host fills and the popped pane returns to the tab strip', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    await page.evaluate((directory) => {
      const tm = window.client.tabManager;
      tm.openTerminal('term-1', 'Term', directory);
      tm.setPaneB('p1:/README.md', 'term-1', 'row', false);
    }, eve.projectDir);
    expect(await page.evaluate(() => document.querySelectorAll('.pane-divider').length)).toBe(1);

    const result = await page.evaluate(() => {
      window.client.tabManager.undockPane('p1:/README.md', 'B');
      return {
        dividerCount: document.querySelectorAll('.pane-divider').length,
        terminalTabPresent: !!document.querySelector('[data-testid="tab-term-1"]'),
        editorHidden: document.getElementById('editor').classList.contains('hidden'),
        activeTabId: window.client.tabManager.activeTabId,
      };
    });

    expect(result.dividerCount).toBe(0);
    expect(result.terminalTabPresent).toBe(true);
    expect(result.editorHidden).toBe(false);
    expect(result.activeTabId).toBe('p1:/README.md');
  });

  test('12. _canSplit refuses two panes sharing a container, and refuses voice on either side', async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('file-tree-item-/src').click();
    await page.getByTestId('file-tree-item-/src/index.js').click();
    await expect(page.getByTestId('tab-p1:/src/index.js')).toBeVisible({ timeout: 10000 });

    const sameContainer = await page.evaluate(() => window.client.tabManager._canSplit('p1:/README.md'));
    expect(sameContainer).toBe(false);

    // Seeded directly — see file header on why a real voice session isn't used.
    const draggedIsVoice = await page.evaluate(() => {
      const tm = window.client.tabManager;
      tm.tabs.push({ id: 'voice-tab', type: 'session', label: 'Voice' });
      window.client.sessions.set('voice-tab', { sessionType: 'voice', projectId: 'p1' });
      return tm._canSplit('voice-tab');
    });
    expect(draggedIsVoice).toBe(false);

    const activeIsVoice = await page.evaluate(() => {
      const tm = window.client.tabManager;
      tm.activeTabId = 'voice-tab';
      return tm._canSplit('p1:/README.md');
    });
    expect(activeIsVoice).toBe(false);
  });

  test('13. dropping an .html file as pane B renders the html preview, not the editor', async ({ page, eve }) => {
    fs.writeFileSync(path.join(eve.projectDir, 'page.html'), '<!doctype html><html><body>hi</body></html>', 'utf8');

    await openChat(page);
    const sessionId = await page.evaluate(() => window.client.currentSessionId);

    await page.getByTestId('sidebar-project-p1').click();
    await expect(page.getByTestId('file-tree-item-/page.html')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('file-tree-item-/page.html').click();
    await expect(page.getByTestId('tab-p1:/page.html')).toBeVisible({ timeout: 10000 });
    // Make the chat session the host again, as dragging onto an already-active chat tab would.
    await page.evaluate((sid) => window.client.tabManager.switchToTab(sid), sessionId);

    const result = await page.evaluate(() => {
      const ok = window.client.tabManager.commitSplit('p1:/page.html', 'right');
      return {
        ok,
        htmlHidden: document.getElementById('htmlPreview').classList.contains('hidden'),
        editorHidden: document.getElementById('editor').classList.contains('hidden'),
      };
    });
    expect(result.ok).toBe(true);
    expect(result.htmlHidden).toBe(false);
    expect(result.editorHidden).toBe(true);
  });
});

// Kept local to this test: the default eve/page fixture in ./fixtures.js is
// also what test/visual/capture.spec.js screenshots, and a second
// activity-rail icon would diff every one of its baselines for a reason
// unrelated to tab-manager.js.
const twoProjectTest = base.test.extend({
  eve: async ({}, use) => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-proj1-'));
    fs.writeFileSync(path.join(dir1, 'README.md'), '# Project One', 'utf8');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-proj2-'));
    fs.writeFileSync(path.join(dir2, 'NOTES.md'), '# Project Two', 'utf8');

    const eve = await startEve({
      projects: [
        { id: 'p1', name: 'E2E Project', path: dir1 },
        { id: 'p2', name: 'Second Project', path: dir2 },
      ],
    });
    try {
      await use({ ...eve, dir1, dir2 });
    } finally {
      await eve.stop();
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  },
  page: async ({ page, eve }, use) => {
    await page.goto(eve.baseUrl);
    await use(page);
  },
});

twoProjectTest(
  "14. a second project's tabs are hidden while the first is active, and return when the rail switches back",
  async ({ page }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('sidebar-project-p2').click();
    await page.getByTestId('file-tree-item-/NOTES.md').click();
    await expect(page.getByTestId('tab-p2:/NOTES.md')).toBeVisible({ timeout: 10000 });

    // render() filters to the active project (_activeProjectId check);
    // p1's tab still exists in this.tabs, just not rendered.
    await expect(page.getByTestId('tab-p1:/README.md')).toHaveCount(0);
    await expect(page.getByTestId('tab-p2:/NOTES.md')).toBeVisible();

    await page.getByTestId('sidebar-project-p1').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible();
    await expect(page.getByTestId('tab-p2:/NOTES.md')).toHaveCount(0);
  }
);

// Restore — the back-compat gate for the whole refactor.

function buildLegacyStorage({ sessionId, projectId, ts }) {
  const json = JSON.stringify(legacyStorageTemplate)
    .replace(/"\{\{SESSION_ID\}\}"/g, JSON.stringify(sessionId))
    .replace(/\{\{PROJECT_ID\}\}/g, projectId)
    .replace(/"\{\{TS\}\}"/g, String(ts));
  const parsed = JSON.parse(json);
  delete parsed._comment;
  return parsed;
}

testWithModule(
  "15. restore: today's four localStorage keys reopen the same session/file/module tabs, with the same labels",
  async ({ page, eve }) => {
    const sessionId = 'sess-restore-1';
    // The restore loop only re-joins a session GET /api/sessions still knows
    // about (app.js onWebSocketReady) — seed it before the page ever loads.
    eve.relay.seedSession({
      sessionId, directory: eve.projectDir, projectId: 'p1', model: 'fake-model', name: 'Restored Session',
    });

    const storage = buildLegacyStorage({ sessionId, projectId: 'p1', ts: Date.now() });
    await page.addInitScript((data) => {
      for (const [key, value] of Object.entries(data)) localStorage.setItem(key, JSON.stringify(value));
    }, storage);

    await page.goto(eve.baseUrl);

    // Session/file tabs land asynchronously (join_session / read_file);
    // the module tab lands synchronously in the same restore loop
    // (app.js onWebSocketReady) — order below is what it actually produces.
    await expect(page.getByTestId(`tab-${sessionId}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('tab-module:p1:demo-module')).toBeVisible({ timeout: 15000 });

    const tabs = await page.$$eval('#tabBar .tab', (els) =>
      els.map((e) => ({ id: e.dataset.tabId, label: e.querySelector('.tab-label').textContent }))
    );
    expect(tabs).toEqual([
      { id: 'module:p1:demo-module', label: 'demo-module' }, // pinned: restore labels a module with its raw moduleName, not the manifest displayName
      { id: sessionId, label: 'Restored Session' },
      { id: 'p1:/README.md', label: 'README.md' },
    ]);
  }
);
