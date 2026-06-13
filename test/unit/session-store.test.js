/**
 * SessionStore — auth session token lifecycle (create / validate / expire /
 * cleanup) and on-disk persistence. This is an authentication primitive, so a
 * regression here (e.g. accepting an expired or unknown token) is a real
 * security bug. Driven directly against a temp data dir.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const SessionStore = require('../../session-store');

describe('SessionStore', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-session-store-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a 256-bit hex token that validates', () => {
    const store = new SessionStore(dataDir);
    const token = store.create();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(store.validate(token)).toBe(true);
  });

  it('rejects unknown, empty, and missing tokens', () => {
    const store = new SessionStore(dataDir);
    store.create();
    expect(store.validate('not-a-real-token')).toBe(false);
    expect(store.validate('')).toBe(false);
    expect(store.validate(undefined)).toBe(false);
    expect(store.validate(null)).toBe(false);
  });

  it('rejects an expired token and evicts it from the store', () => {
    const store = new SessionStore(dataDir);
    const token = store.create();
    // Force expiry by rewinding the stored deadline into the past.
    store.sessions.get(token).expiresAt = Date.now() - 1000;
    expect(store.validate(token)).toBe(false);
    expect(store.sessions.has(token)).toBe(false); // eviction on failed validate
    expect(store.validate(token)).toBe(false);     // still gone on re-check
  });

  it('defaults to a ~7 day TTL', () => {
    const store = new SessionStore(dataDir);
    const token = store.create();
    const ttl = store.sessions.get(token).expiresAt - Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // Allow a generous slop for execution time; just guard the order of magnitude.
    expect(ttl).toBeGreaterThan(sevenDays - 60_000);
    expect(ttl).toBeLessThanOrEqual(sevenDays);
  });

  it('persists tokens across instances over the same data dir', () => {
    const token = new SessionStore(dataDir).create();
    const reopened = new SessionStore(dataDir); // fresh instance, reads disk
    expect(reopened.validate(token)).toBe(true);
  });

  it('writes sessions.json with 0600 permissions', () => {
    const store = new SessionStore(dataDir);
    store.create();
    const mode = fs.statSync(path.join(dataDir, 'sessions.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('cleanup() removes only expired tokens and persists the change', () => {
    const store = new SessionStore(dataDir);
    const live = store.create();
    const dead = store.create();
    store.sessions.get(dead).expiresAt = Date.now() - 1000;

    store.cleanup();
    expect(store.sessions.has(live)).toBe(true);
    expect(store.sessions.has(dead)).toBe(false);

    // The eviction is durable: a reopened store still rejects the dead token.
    const reopened = new SessionStore(dataDir);
    expect(reopened.validate(live)).toBe(true);
    expect(reopened.validate(dead)).toBe(false);
  });

  it('tolerates a corrupt sessions.json by starting empty', () => {
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), '{ not valid json', 'utf8');
    const store = new SessionStore(dataDir); // must not throw
    expect(store.validate('anything')).toBe(false);
    const token = store.create(); // still usable afterward
    expect(store.validate(token)).toBe(true);
  });
});
