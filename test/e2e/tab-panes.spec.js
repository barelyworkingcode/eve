/**
 * TabManager (public/tab-manager.js), asserted behaviourally — the
 * characterisation suite for the pane-registry refactor
 * (docs/decisions/001-feature-registry.md's sibling for panes; see
 * /tmp/eve-phase4-tab-manager-spec.md §G.3, which enumerates the ~15 tests
 * below by number in its own table).
 *
 * tab-manager.js had ZERO test cover before this file. Every assertion here
 * pins CURRENT behaviour, bugs included — this is a safety net for an
 * incremental refactor, not a spec for how the code *should* work. Two
 * deliberately-pinned oddities are called out inline where they occur:
 * an image tab clears location.hash instead of linking to it (no `image` arm
 * in `_updateHash`), and a restored module tab's label is the raw
 * `moduleName`, not the manifest's `displayName`.
 *
 * Tests 9-13 drive TabManager's own API via `page.evaluate` rather than
 * synthesizing pointer events, exactly as the spec directs: `PaneDnd` is
 * Pointer-Events-based and timing-sensitive, and this suite pins TabManager,
 * not the drag gesture. Voice-session state is likewise seeded directly
 * (a tab object + a `sessions` map entry) rather than driven through a real
 * `openSession`/`switchToTab` call — activating a real voice session invokes
 * `voiceChatManager.activateForSession`, which reaches for a microphone via
 * getUserMedia and was observed to hang indefinitely in headless Chromium
 * with no real audio device. `_canSplit`'s voice guard only *reads*
 * `tab.type`/`session.sessionType`, so it doesn't need a live voice session
 * to exercise, and the alternative risks the whole suite's runtime.
 *
 * Terminal panes are NOT opened end to end anywhere in this file: the fake
 * relay (test/integration/fake-relay.js) only implements
 * `GET /api/terminals/:id/log`, not terminal creation over WS, so a real
 * terminal isn't reachable without extending the fake relay — which the spec
 * explicitly rules out for this phase. `openTerminal()` itself has no side
 * effects (no WS send, no persistence — see spec §C), so it's safe to use
 * directly as a second pane in the split tests (10-11); that's bookkeeping,
 * not a terminal-specific behaviour, so it isn't terminal coverage. Terminal
 * has no unit-level pure-logic seam either at this handoff (there is no
 * descriptor yet to unit-test) — it is a recorded, open gap, not a covered one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const base = require('@playwright/test');
const { test, expect, testWithModule } = require('./fixtures');
const { startEve } = require('../integration/harness');
const legacyStorageTemplate = require('./fixtures/legacy-tab-storage.json');

// A 1x1 transparent PNG — real bytes so /api/files and the image viewer's
// <img> load event both succeed; content is otherwise irrelevant to what's
// under test here.
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

/** Mouse down over an element, hold for `ms`, then release — the same
 *  press-duration technique voice-buttons.spec.js uses for its long-press gate. */
async function press(page, locator, ms) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Intercepts the raw WebSocket while clicking the element at `testid`,
 *  returning every frame sent matching `type`. Same technique as
 *  chat-input-row.spec.js's plan-mode test, one level lower: `_sendWatchFile`
 *  writes through `this.app.ws?.send(JSON.stringify(...))` — the native
 *  WebSocket underlying `wsClient`, not `wsClient.send()`'s own
 *  object-in/JSON-out wrapper — so the patch has to sit on `wsClient.ws`. */
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
    // Dismissed the confirm -> the tab survives.
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
    expect(urlAfter).toBe('/api/generated/x.png'); // the cross-project refresh did not re-render
  });

  test('10. setPaneB shows both containers, marks the split classes, and mounts a divider + two undock buttons', async ({ page, eve }) => {
    await page.getByTestId('sidebar-project-p1').click();
    await page.getByTestId('file-tree-item-/README.md').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible({ timeout: 10000 });

    const result = await page.evaluate((directory) => {
      const tm = window.client.tabManager;
      // openTerminal has no WS/persistence side effects (spec §C) — safe to
      // drive directly without a real terminal backend. Its directory must
      // resolve under project p1 (via _projectIdForDirectory's longest-prefix
      // match) or render() will hide it as belonging to no active project.
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
    expect(result.terminalTabPresent).toBe(true); // popped B is now a standalone tab
    expect(result.editorHidden).toBe(false);      // host (A) keeps filling the view
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
    expect(sameContainer).toBe(false); // both are `editor` view -> same container

    // A voice-typed session tab, seeded directly (see file header: a real
    // voice session hangs headless Chromium on getUserMedia, and _canSplit
    // only reads tab.type / session.sessionType — no activation needed).
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
    // Opening the .html file switched to it — make the chat session the host
    // again, exactly as dragging the file onto an already-active chat tab would.
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
    expect(result.editorHidden).toBe(true); // pinned: htmlPreview, not the editor, for an .html file as pane B
  });
});

// --- 14. Project-scoped tab bar, across two real projects ---
//
// A dedicated fixture with two seeded projects, kept local to this one test:
// the default `eve`/`page` fixture in ./fixtures.js is also what
// test/visual/capture.spec.js screenshots, and a second activity-rail icon
// would show up as a pixel diff in every one of its 24 baselines for a
// reason that has nothing to do with tab-manager.js.
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

    // render() filters the tab bar to the active project (§ tab-manager.js
    // render(), the `_activeProjectId` check) — p1's tab still exists in
    // `this.tabs`, it's just not rendered.
    await expect(page.getByTestId('tab-p1:/README.md')).toHaveCount(0);
    await expect(page.getByTestId('tab-p2:/NOTES.md')).toBeVisible();

    await page.getByTestId('sidebar-project-p1').click();
    await expect(page.getByTestId('tab-p1:/README.md')).toBeVisible();
    await expect(page.getByTestId('tab-p2:/NOTES.md')).toHaveCount(0);
  }
);

// --- 15. Restore — the back-compat gate for the whole refactor (spec §H) ---

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
    // The reconnect restore loop only re-joins a session that GET /api/sessions
    // still knows about (app.js onWebSocketReady) — seed it as if created by
    // an earlier browser session, before this test's page ever loaded.
    eve.relay.seedSession({
      sessionId, directory: eve.projectDir, projectId: 'p1', model: 'fake-model', name: 'Restored Session',
    });

    const storage = buildLegacyStorage({ sessionId, projectId: 'p1', ts: Date.now() });
    await page.addInitScript((data) => {
      for (const [key, value] of Object.entries(data)) localStorage.setItem(key, JSON.stringify(value));
    }, storage);

    await page.goto(eve.baseUrl);

    // Session and file tabs land asynchronously (a join_session / read_file
    // WS round trip); the module tab lands synchronously in the same restore
    // loop (app.js onWebSocketReady) — order below is what that loop actually
    // produces today, not an assumption.
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
