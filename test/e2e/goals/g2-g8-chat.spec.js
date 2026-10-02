// G2 · Ask about my project and get an answer. G8 · Let an agent act, under my
// control: the permission prompt appears, and my answer reaches the session.
const { test, expect } = require('./fixture');
const { relayFrames } = require('../../integration/protocol');

async function startChat(page) {
  await page.getByRole('navigation', { name: 'Projects' }).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('sidebar-new-session-alpha').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
  return page.evaluate(() => window.client.currentSessionId);
}

const thread = (page) => page.getByTestId('messages-container');

test.describe('G2 chat', () => {
  test('from Home: the Chat tile opens the launcher, and a question gets a streamed reply', async ({ page, eve }) => {
    await page.getByTestId('home-tile-chat').click();
    // The tile carries the intent, so the launcher opens on the chat form, not the card picker.
    await expect(page.getByTestId('dialog-shell-launcher-dialog')).toBeVisible();
    await expect(page.getByTestId('shell-card-web-chat')).toHaveCount(0);
    await page.getByRole('button', { name: 'Start Chat' }).click();
    await page.getByTestId('chat-input').fill('what is in the README?');
    await page.getByTestId('chat-submit').click();

    await expect(thread(page)).toContainText('what is in the README?');
    await expect(thread(page)).toContainText('Hello from fake relay', { timeout: 15000 });
    expect(eve.relay.sessionCreates).toHaveLength(1);
    expect(eve.relay.sessionCreates[0]).toMatchObject({ directory: expect.any(String) });
    const sent = eve.relay.inbound.filter((m) => m.type === 'send_message');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('what is in the README?');
  });

  test('the new thread is listed under its project and on Home after the turn', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await page.getByTestId('chat-input').fill('first question');
    await page.getByTestId('chat-submit').click();
    await expect(thread(page)).toContainText('Hello from fake relay', { timeout: 15000 });
    await page.getByTestId('panel-project-page').click();
    await expect(page.getByTestId(`project-thread-${sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`tab-${sessionId}`)).toBeVisible();
    expect(eve.relay.listSessions().map((s) => s.sessionId)).toContain(sessionId);
  });

  test('a turn that fails shows the error in the thread and leaves the prompt usable', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    eve.relay.scriptSession(sessionId, [relayFrames.error({ message: 'model unavailable', sessionId })]);
    await page.getByTestId('chat-input').fill('will fail');
    await page.getByTestId('chat-submit').click();
    await expect(thread(page)).toContainText('model unavailable');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    eve.relay.scriptSession(sessionId, undefined);
  });

  test('a message refused by a dormant session makes eve resume it', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    eve.relay.scriptSession(sessionId, [relayFrames.resumeRequired({ sessionId, message: 'session is not running' })]);
    await page.getByTestId('chat-input').fill('are you there?');
    await page.getByTestId('chat-submit').click();
    await expect.poll(() => eve.relay.requests.filter((r) => r.path === `/api/sessions/${sessionId}/resume`).length).toBe(1);
  });
});

test.describe('G8 permission prompt', () => {
  async function prompt(page, eve, sessionId, id = 'perm-1') {
    eve.relay.emitToSession(sessionId, relayFrames.permissionRequest({
      sessionId, permissionId: id, toolName: 'Bash', toolInput: '{"command":"rm -rf build"}', toolUseId: `tu-${id}`,
    }));
    await expect(page.locator('#permissionModal')).toBeVisible();
  }

  test('a tool call raises the prompt with the tool and its input; Allow answers approved', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await prompt(page, eve, sessionId);
    await expect(page.locator('#permissionToolName')).toHaveText('Bash');
    await expect(page.locator('#permissionToolInput')).toContainText('rm -rf build');
    await page.getByTestId('modal-permission-allow').click();
    const answer = await eve.relay.waitForInbound((m) => m.type === 'permission_response' && m.permissionId === 'perm-1');
    expect(answer.approved).toBe(true);
    await expect(page.locator('#permissionModal')).toBeHidden();
  });

  test('Deny answers not approved', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await prompt(page, eve, sessionId);
    await page.getByTestId('modal-permission-deny').click();
    const answer = await eve.relay.waitForInbound((m) => m.type === 'permission_response' && m.permissionId === 'perm-1');
    expect(answer.approved).toBe(false);
  });

  test('Allow All approves this request and answers later ones for the session without asking', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await prompt(page, eve, sessionId, 'perm-a');
    await page.getByTestId('modal-permission-allow-all').click();
    await eve.relay.waitForInbound((m) => m.type === 'permission_response' && m.permissionId === 'perm-a');
    eve.relay.emitToSession(sessionId, relayFrames.permissionRequest({
      sessionId, permissionId: 'perm-b', toolName: 'Write', toolInput: '{}', toolUseId: 'tu-b',
    }));
    const second = await eve.relay.waitForInbound((m) => m.type === 'permission_response' && m.permissionId === 'perm-b');
    expect(second.approved).toBe(true);
    await expect(page.locator('#permissionModal')).toBeHidden();
  });

  test('a second request waits its turn behind the first', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await prompt(page, eve, sessionId, 'perm-1');
    eve.relay.emitToSession(sessionId, relayFrames.permissionRequest({
      sessionId, permissionId: 'perm-2', toolName: 'Edit', toolInput: '{}', toolUseId: 'tu-2',
    }));
    await expect(page.locator('#permissionToolName')).toHaveText('Bash');
    await page.getByTestId('modal-permission-allow').click();
    await expect(page.locator('#permissionToolName')).toHaveText('Edit');
  });

  test('several waiting requests are asked in the order they arrived', async ({ page, eve }) => {
    const sessionId = await startChat(page);
    await prompt(page, eve, sessionId, 'perm-1');
    for (const [id, tool] of [['perm-2', 'Edit'], ['perm-3', 'Write']]) {
      eve.relay.emitToSession(sessionId, relayFrames.permissionRequest({
        sessionId, permissionId: id, toolName: tool, toolInput: '{}', toolUseId: `tu-${id}`,
      }));
    }
    await expect(page.locator('#permissionToolName')).toHaveText('Bash');
    await page.getByTestId('modal-permission-allow').click();
    await expect(page.locator('#permissionToolName')).toHaveText('Edit');
    await page.getByTestId('modal-permission-allow').click();
    await expect(page.locator('#permissionToolName')).toHaveText('Write');
  });
});
