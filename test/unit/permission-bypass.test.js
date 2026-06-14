/**
 * Permission "Allow All" per-session bypass (ModalManager).
 *
 * This is the client-side auto-approve path the relay can't see: when the user
 * clicks "Allow All", ModalManager records the *current* session in
 * `bypassedSessions` and silently approves every later `permission_request`
 * carrying that same sessionId — never showing the modal again. A regression
 * here either (a) keeps prompting after Allow All, or worse (b) auto-approves
 * the WRONG session. Neither is visible to the relay/integration layer because
 * the decision is made entirely in the browser, so it lives here as a unit test.
 *
 * (The todo filed this under "Permissions / integration — alwaysAllow"; the real
 * mechanism is this per-session bypass, and it is only testable client-side.)
 */
const ModalManager = require('../../public/modal-manager');

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
}

/** A ModalManager wired to fully fake DOM/ws so we can assert outbound frames. */
function makeManager(currentSessionId = 's1') {
  const sent = [];
  const app = {
    wsClient: { send: (m) => sent.push(m) },
    messageRenderer: {
      markToolPermissionPending: () => {},
      clearToolPermissionPending: () => {},
    },
    state: { currentSessionId },
    elements: {
      permissionToolName: { textContent: '' },
      permissionToolInput: { textContent: '' },
      permissionModal: { classList: makeClassList(['hidden']) },
      permissionAllow: { focus: () => {} },
    },
  };
  const container = { get: (k) => (k === 'app' ? app : undefined) };
  const m = new ModalManager(container);
  const modalVisible = () => !app.elements.permissionModal.classList.contains('hidden');
  return { m, app, sent, modalVisible };
}

const req = (permissionId, sessionId, extra = {}) => ({
  permissionId,
  sessionId,
  toolName: 'Bash',
  toolInput: 'ls',
  ...extra,
});

describe('ModalManager permission per-session bypass', () => {
  test('first request shows the modal and sends nothing yet', () => {
    const { m, sent, modalVisible } = makeManager();
    m.showPermissionModal(req('p1', 's1'));
    expect(modalVisible()).toBe(true);
    expect(m.pendingPermissionId).toBe('p1');
    expect(sent).toEqual([]);
  });

  test('plain allow/deny forwards the decision and hides the modal', () => {
    const { m, sent, modalVisible } = makeManager();
    m.showPermissionModal(req('p1', 's1'));
    m.respondToPermission(false);
    expect(sent).toEqual([{ type: 'permission_response', permissionId: 'p1', approved: false }]);
    expect(modalVisible()).toBe(false);
    expect(m.pendingPermissionId).toBeNull();
  });

  test('Allow All approves the current request and bypasses subsequent same-session requests', () => {
    const { m, sent, modalVisible } = makeManager('s1');
    m.showPermissionModal(req('p1', 's1'));
    m.respondToPermissionAll();

    // Current request approved + session marked bypassed.
    expect(sent).toEqual([{ type: 'permission_response', permissionId: 'p1', approved: true }]);
    expect(m.bypassedSessions.has('s1')).toBe(true);
    expect(modalVisible()).toBe(false);

    // A later request for the SAME session is auto-approved without a modal.
    m.showPermissionModal(req('p2', 's1'));
    expect(modalVisible()).toBe(false);
    expect(m.pendingPermissionId).toBeNull();
    expect(sent).toContainEqual({ type: 'permission_response', permissionId: 'p2', approved: true });
  });

  test('bypass is per-session — a different session still prompts', () => {
    const { m, sent, modalVisible } = makeManager('s1');
    m.showPermissionModal(req('p1', 's1'));
    m.respondToPermissionAll();

    m.showPermissionModal(req('p9', 's2'));
    expect(modalVisible()).toBe(true);
    expect(m.pendingPermissionId).toBe('p9');
    // Only p1 was auto-sent; s2's request awaits the user.
    expect(sent).toEqual([{ type: 'permission_response', permissionId: 'p1', approved: true }]);
  });

  test('clearSessionBypass restores prompting for that session', () => {
    const { m, modalVisible } = makeManager('s1');
    m.showPermissionModal(req('p1', 's1'));
    m.respondToPermissionAll();
    m.clearSessionBypass('s1');

    m.showPermissionModal(req('p2', 's1'));
    expect(modalVisible()).toBe(true);
    expect(m.pendingPermissionId).toBe('p2');
  });

  test('queued same-session requests are drained as auto-approved after Allow All', () => {
    const { m, sent } = makeManager('s1');
    m.showPermissionModal(req('p1', 's1'));   // shown
    m.showPermissionModal(req('p2', 's1'));   // queued behind p1
    m.respondToPermissionAll();               // approves p1, bypasses s1, drains p2

    expect(sent).toEqual([
      { type: 'permission_response', permissionId: 'p1', approved: true },
      { type: 'permission_response', permissionId: 'p2', approved: true },
    ]);
    expect(m.pendingPermissionId).toBeNull();
    expect(m.permissionQueue).toHaveLength(0);
  });
});
