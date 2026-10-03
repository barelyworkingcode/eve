// Shared by the S1 Today specs (docs/design-today-s1.md). Test ids used:
//   today-part-<id>        a part's root; data-state is loading | ready | error
//   today-error-<id>       its one-line error; today-retry-<id> its Retry button
//   today-ask-input        the Ask textarea; today-ask-status its status line;
//                          today-ask-project the inline project pick
//   today-needs-row-<id>   a Needs you row (data-kind waiting | failed)
//   today-running-row-<id> a Running row
//   mode-switch            the Home | Work radiogroup; mode-home, mode-work
// A custom card (eve#117) is the part custom-<taskId>; inside it:
//   today-custom-never | -running | -failed | -not-understood   its state line
//   today-custom-refresh, today-custom-retry, today-custom-stale, today-custom-when
//   today-custom-body (data-renderer), today-custom-item (a list row), today-custom-raw
const { expect } = require('@playwright/test');

const nav = (page) => page.getByRole('navigation', { name: 'Projects' });
const part = (page, id) => page.getByTestId(`today-part-${id}`);

// A chat in Alpha started through the launcher (not Ask), so these specs do not
// depend on the code they are written to drive. Ends on the chat screen.
async function startChatInAlpha(page) {
  await nav(page).getByTitle('Alpha Project', { exact: true }).click();
  await page.getByTestId('sidebar-new-session-alpha').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
  return page.evaluate(() => window.client.currentSessionId);
}

// Today is visible while that thread stays joined: another project's tab strip is
// empty, so the empty state (Today) shows.
async function backToToday(page) {
  await nav(page).getByTitle('Beta Project', { exact: true }).click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
}

// One run of a seeded task as relayScheduler records it: started at the fake's
// own route (not through eve or the page), then finished with `finish`.
async function runThroughScheduler(relay, relayPort, id, finish) {
  relay.holdTaskRuns();
  const res = await fetch(`http://127.0.0.1:${relayPort}/api/tasks/${id}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`run ${id}: ${res.status}`);
  relay.finishTask(id, finish);
  relay.holdTaskRuns(false);
}

module.exports = { nav, part, startChatInAlpha, backToToday, runThroughScheduler };
