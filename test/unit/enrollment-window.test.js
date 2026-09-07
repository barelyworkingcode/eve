const EnrollmentWindow = require('../../enrollment-window');

function fakeTransport(responses) {
  // responses: array of { status, data } consumed in order, last one repeats.
  let i = 0;
  return {
    fetch: jest.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    }),
  };
}

describe('EnrollmentWindow', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('isOpen', () => {
    it('reports open with the expiry relay returned', async () => {
      const transport = fakeTransport([{ status: 200, data: { open: true, expires: '2026-09-07T10:15:00Z' } }]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      const result = await win.isOpen();

      expect(result).toEqual({ open: true, expires: '2026-09-07T10:15:00Z' });
      expect(transport.fetch).toHaveBeenCalledWith('GET', '/api/eve/passkey-enrolment');
    });

    it('reports closed when relay says so', async () => {
      const transport = fakeTransport([{ status: 200, data: { open: false } }]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      expect(await win.isOpen()).toEqual({ open: false, expires: undefined });
    });

    it('fails closed on a non-200 response', async () => {
      const transport = fakeTransport([{ status: 500, data: { error: 'boom' } }]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      expect((await win.isOpen()).open).toBe(false);
    });

    it('fails closed when the transport throws', async () => {
      const transport = { fetch: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      const win = new EnrollmentWindow({ relayTransport: transport, log: { error: jest.fn(), info() {}, warn() {}, debug() {}, child() { return this; } } });

      expect((await win.isOpen()).open).toBe(false);
    });

    it('always reports closed with a null transport, without calling anything', async () => {
      const win = new EnrollmentWindow({ relayTransport: null });
      expect(await win.isOpen()).toEqual({ open: false });
    });

    it('caches the answer for 2 seconds', async () => {
      jest.useFakeTimers();
      const transport = fakeTransport([
        { status: 200, data: { open: true, expires: 'a' } },
        { status: 200, data: { open: false } },
      ]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      expect((await win.isOpen()).open).toBe(true);
      jest.advanceTimersByTime(1000);
      expect((await win.isOpen()).open).toBe(true); // still cached
      expect(transport.fetch).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1001); // total 2001ms since the first call
      expect((await win.isOpen()).open).toBe(false); // cache expired, refetched
      expect(transport.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('consume', () => {
    it('resolves true on 200', async () => {
      const transport = fakeTransport([{ status: 200, data: { expires: 'now' } }]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      expect(await win.consume({ ip: '10.0.0.5', label: 'Mozilla/5.0' })).toBe(true);
      expect(transport.fetch).toHaveBeenCalledWith(
        'POST',
        '/api/eve/passkey-enrolment/consume',
        { ip: '10.0.0.5', label: 'Mozilla/5.0' }
      );
    });

    it('resolves false on 409', async () => {
      const transport = fakeTransport([{ status: 409, data: { error: 'closed' } }]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      expect(await win.consume({ ip: '10.0.0.5', label: 'x' })).toBe(false);
    });

    it('throws on anything else', async () => {
      const transport = fakeTransport([{ status: 500, data: { error: 'boom' } }]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      await expect(win.consume({ ip: '10.0.0.5', label: 'x' })).rejects.toThrow();
    });

    it('always resolves false with a null transport', async () => {
      const win = new EnrollmentWindow({ relayTransport: null });
      expect(await win.consume({ ip: '1.2.3.4', label: 'x' })).toBe(false);
    });

    it('invalidates the isOpen cache on a successful consume', async () => {
      const transport = fakeTransport([
        { status: 200, data: { open: true, expires: 'a' } }, // isOpen
        { status: 200, data: { expires: 'a' } }, // consume
        { status: 200, data: { open: false } }, // isOpen again, post-consume
      ]);
      const win = new EnrollmentWindow({ relayTransport: transport });

      expect((await win.isOpen()).open).toBe(true);
      expect(await win.consume({ ip: '1.2.3.4', label: 'x' })).toBe(true);
      // Without invalidation this would still return the cached "open: true".
      expect((await win.isOpen()).open).toBe(false);
    });
  });
});
