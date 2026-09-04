// This is a client-side auto-approve path the relay/integration layer can't see:
// the decision is made entirely in the browser, so a regression that either keeps
// prompting after Allow All, or worse auto-approves the WRONG session, is only
// visible to a unit test like this one.
const ModalManager = require('../../public/modal-manager');

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
}

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

    expect(sent).toEqual([{ type: 'permission_response', permissionId: 'p1', approved: true }]);
    expect(m.bypassedSessions.has('s1')).toBe(true);
    expect(modalVisible()).toBe(false);

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
    m.showPermissionModal(req('p1', 's1'));
    m.showPermissionModal(req('p2', 's1'));
    m.respondToPermissionAll();

    expect(sent).toEqual([
      { type: 'permission_response', permissionId: 'p1', approved: true },
      { type: 'permission_response', permissionId: 'p2', approved: true },
    ]);
    expect(m.pendingPermissionId).toBeNull();
    expect(m.permissionQueue).toHaveLength(0);
  });
});
