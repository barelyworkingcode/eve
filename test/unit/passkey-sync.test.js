const PasskeySync = require('../../passkey-sync');

// Stands in for AuthService: enough of the real listCredentials/removeCredential
// contract (../relay/docs/eve-passkey-enrolment.md) for PasskeySync's own logic,
// which is what this file pins — not AuthService's, covered in auth-ceremony.test.js.
function fakeAuthService(initial) {
  let creds = initial.map((c) => ({ ...c }));
  return {
    listCredentials: jest.fn(() => creds.map((c) => ({ ...c }))),
    removeCredential: jest.fn((id) => {
      const idx = creds.findIndex((c) => c.id === id);
      if (idx === -1) throw new Error('Unknown credential');
      if (creds.length <= 1) throw new Error('Refusing to remove the last passkey — eve would be locked out');
      creds.splice(idx, 1);
      return { removed: true, sessionsEnded: 1 };
    }),
  };
}

function silentLog() {
  return { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), child() { return this; } };
}

describe('PasskeySync', () => {
  afterEach(() => jest.useRealTimers());

  describe('report', () => {
    it('PUTs the current credential list in the shape relay expects', async () => {
      const authService = fakeAuthService([{ id: 'c1', label: 'Browser A', created: 't1', last_used: null }]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: [] } }) };
      const sync = new PasskeySync({ authService, relayTransport: transport });

      await sync.report();

      expect(transport.fetch).toHaveBeenCalledWith('PUT', '/api/eve/passkeys', {
        passkeys: [{ id: 'c1', label: 'Browser A', created: 't1', last_used: null }],
      });
    });

    it('applies revocations returned in the same round-trip, then re-reports as the acknowledgement', async () => {
      const authService = fakeAuthService([
        { id: 'c1', label: 'A', created: 't1', last_used: null },
        { id: 'c2', label: 'B', created: 't2', last_used: null },
      ]);
      const transport = { fetch: jest.fn() };
      transport.fetch.mockResolvedValueOnce({ status: 200, data: { revocations: ['c1'] } }); // initial report
      transport.fetch.mockResolvedValueOnce({ status: 200, data: { revocations: [] } }); // ack report from apply()

      const sync = new PasskeySync({ authService, relayTransport: transport });
      await sync.report();

      expect(authService.removeCredential).toHaveBeenCalledWith('c1');
      expect(transport.fetch).toHaveBeenCalledTimes(2);
    });

    it('logs at error level on a non-200 response and applies nothing', async () => {
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 500, data: { error: 'boom' } }) };
      const log = silentLog();
      const sync = new PasskeySync({ authService, relayTransport: transport, log });

      await sync.report();

      expect(log.error).toHaveBeenCalled();
      expect(authService.removeCredential).not.toHaveBeenCalled();
    });

    it('logs at error level when the transport throws', async () => {
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const transport = { fetch: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      const log = silentLog();
      const sync = new PasskeySync({ authService, relayTransport: transport, log });

      await expect(sync.report()).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('checkRevoked (fails open)', () => {
    it('returns true when the id is in relay\'s pending set', async () => {
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: ['c1', 'c2'] } }) };
      const sync = new PasskeySync({ authService: fakeAuthService([]), relayTransport: transport });

      expect(await sync.checkRevoked('c1')).toBe(true);
      expect(await sync.checkRevoked('c3')).toBe(false);
      expect(transport.fetch).toHaveBeenCalledWith('GET', '/api/eve/passkeys/revocations');
    });

    it('fails open (false) and logs at error level on a non-200 response', async () => {
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 500, data: null }) };
      const log = silentLog();
      const sync = new PasskeySync({ authService: fakeAuthService([]), relayTransport: transport, log });

      expect(await sync.checkRevoked('c1')).toBe(false);
      expect(log.error).toHaveBeenCalled();
    });

    it('fails open (false) and logs at error level when the transport throws', async () => {
      const transport = { fetch: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      const log = silentLog();
      const sync = new PasskeySync({ authService: fakeAuthService([]), relayTransport: transport, log });

      expect(await sync.checkRevoked('c1')).toBe(false);
      expect(log.error).toHaveBeenCalled();
    });

    it('returns false with a null transport, without calling anything', async () => {
      const sync = new PasskeySync({ authService: fakeAuthService([]), relayTransport: null });
      expect(await sync.checkRevoked('c1')).toBe(false);
    });
  });

  describe('apply', () => {
    it('removes every id present and not the last credential', async () => {
      const authService = fakeAuthService([
        { id: 'c1', label: '', created: 't1', last_used: null },
        { id: 'c2', label: '', created: 't2', last_used: null },
      ]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: [] } }) };
      const sync = new PasskeySync({ authService, relayTransport: transport });

      await sync.apply(['c1']);

      expect(authService.removeCredential).toHaveBeenCalledWith('c1');
      expect(transport.fetch).toHaveBeenCalledTimes(1); // the acknowledgement report
    });

    it('never removes the last remaining credential, even if relay reports it pending', async () => {
      const authService = fakeAuthService([{ id: 'only', label: '', created: 't', last_used: null }]);
      const transport = { fetch: jest.fn() };
      const sync = new PasskeySync({ authService, relayTransport: transport });

      await sync.apply(['only']);

      expect(authService.removeCredential).not.toHaveBeenCalled();
      expect(transport.fetch).not.toHaveBeenCalled(); // nothing removed, nothing to acknowledge
    });

    it('stops at the last credential even mid-batch (two ids, one credential each)', async () => {
      const authService = fakeAuthService([
        { id: 'c1', label: '', created: 't1', last_used: null },
        { id: 'c2', label: '', created: 't2', last_used: null },
      ]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: [] } }) };
      const sync = new PasskeySync({ authService, relayTransport: transport });

      await sync.apply(['c1', 'c2']);

      expect(authService.removeCredential).toHaveBeenCalledTimes(1);
      expect(authService.removeCredential).toHaveBeenCalledWith('c1');
    });

    it('is a no-op with a null transport', async () => {
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const sync = new PasskeySync({ authService, relayTransport: null });

      await sync.apply(['c1']);

      expect(authService.removeCredential).not.toHaveBeenCalled();
    });
  });

  describe('timer lifecycle', () => {
    it('start() reports immediately, then polls every pollMs; stop() clears it', async () => {
      jest.useFakeTimers();
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: [] } }) };
      const sync = new PasskeySync({ authService, relayTransport: transport, pollMs: 1000 });

      sync.start();
      await Promise.resolve();
      expect(transport.fetch).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(transport.fetch).toHaveBeenCalledTimes(2);

      sync.stop();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(transport.fetch).toHaveBeenCalledTimes(2);
    });

    it('the poll timer is unref\'d so it cannot keep the process alive', () => {
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: [] } }) };
      const sync = new PasskeySync({ authService, relayTransport: transport });

      sync.start();

      expect(sync.timer.hasRef()).toBe(false);
      sync.stop();
    });

    it('start() is a no-op with a null transport (no timer, no report)', () => {
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const sync = new PasskeySync({ authService, relayTransport: null });

      sync.start();

      expect(sync.timer).toBeNull();
      expect(authService.listCredentials).not.toHaveBeenCalled();
      sync.stop(); // must not throw
    });

    it('start() is idempotent (a second call does not stack a second interval)', () => {
      const authService = fakeAuthService([{ id: 'c1', label: '', created: 't', last_used: null }]);
      const transport = { fetch: jest.fn().mockResolvedValue({ status: 200, data: { revocations: [] } }) };
      const sync = new PasskeySync({ authService, relayTransport: transport });

      sync.start();
      const timer = sync.timer;
      sync.start();

      expect(sync.timer).toBe(timer);
      sync.stop();
    });
  });
});
