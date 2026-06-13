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

/**
 * TTL configuration — SESSION_TTL_MS is derived from EVE_SESSION_TTL_DAYS ONCE
 * at module load (frozen at require time), so the env-override branch can only
 * be exercised by setting the env var and re-loading the module in an isolated
 * registry. The default-only describe block above never sees these paths.
 *
 * The load-bearing case is the non-numeric fallback: without the
 * `Number.isFinite(n) && n > 0` guard, parseInt('abc', 10) === NaN would make
 * SESSION_TTL_MS NaN, so `Date.now() + NaN` is NaN and `Date.now() > NaN` is
 * always false → tokens that NEVER expire. That's an auth/security regression.
 */
describe('SessionStore TTL configuration', () => {
  const ENV_KEY = 'EVE_SESSION_TTL_DAYS';
  const DAY_MS = 24 * 60 * 60 * 1000;
  let dataDir;
  let savedEnv;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-session-store-ttl-'));
    savedEnv = process.env[ENV_KEY]; // capture so we can restore exactly (incl. undefined)
  });

  afterEach(() => {
    // Always restore the env var so the override can't leak into the default
    // tests above (which assert the ~7 day default) or any other test file.
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    jest.resetModules(); // drop the env-tweaked module from the registry
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Load a SessionStore class against the given EVE_SESSION_TTL_DAYS value,
  // re-requiring the module in an isolated registry so its module-load-time
  // TTL parse runs with the env var we set here.
  const loadStoreWith = (envValue) => {
    if (envValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = envValue;
    }
    let Loaded;
    jest.isolateModules(() => {
      Loaded = require('../../session-store');
    });
    return Loaded;
  };

  // Observe the frozen TTL by reading the expiry a freshly created token gets.
  const ttlOf = (StoreClass) => {
    const store = new StoreClass(dataDir);
    const token = store.create();
    return store.sessions.get(token).expiresAt - Date.now();
  };

  it('honors a valid custom EVE_SESSION_TTL_DAYS (longer expiry)', () => {
    const StoreClass = loadStoreWith('30');
    const ttl = ttlOf(StoreClass);
    const thirtyDays = 30 * DAY_MS;
    // Generous slop for execution time; just pin the magnitude to 30 days.
    expect(ttl).toBeGreaterThan(thirtyDays - 60_000);
    expect(ttl).toBeLessThanOrEqual(thirtyDays);
    // Sanity: this is materially longer than the 7-day default.
    expect(ttl).toBeGreaterThan(7 * DAY_MS);
  });

  it('honors a valid custom EVE_SESSION_TTL_DAYS (shorter expiry) and expires across the boundary', () => {
    const StoreClass = loadStoreWith('1');
    const store = new StoreClass(dataDir);
    const token = store.create();

    const ttl = store.sessions.get(token).expiresAt - Date.now();
    expect(ttl).toBeGreaterThan(DAY_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(DAY_MS);

    // Within the 1-day window it validates; rewind past the deadline and it
    // must be rejected (and evicted), proving the custom TTL actually gates.
    expect(store.validate(token)).toBe(true);
    store.sessions.get(token).expiresAt = Date.now() - 1000;
    expect(store.validate(token)).toBe(false);
    expect(store.sessions.has(token)).toBe(false);
  });

  it('falls back to the 7-day default for a non-numeric value (no NaN / never-expiring token)', () => {
    const StoreClass = loadStoreWith('abc'); // parseInt('abc', 10) === NaN
    const store = new StoreClass(dataDir);
    const token = store.create();

    const expiresAt = store.sessions.get(token).expiresAt;
    // The regression: NaN expiry. Guard it explicitly before checking magnitude.
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(Number.isNaN(expiresAt)).toBe(false);

    const ttl = expiresAt - Date.now();
    const sevenDays = 7 * DAY_MS;
    expect(ttl).toBeGreaterThan(sevenDays - 60_000);
    expect(ttl).toBeLessThanOrEqual(sevenDays);

    // A NaN deadline would make `Date.now() > expiresAt` always false → the
    // token would NEVER expire. Confirm the fallback TTL actually expires.
    expect(store.validate(token)).toBe(true);
    store.sessions.get(token).expiresAt = Date.now() - 1000;
    expect(store.validate(token)).toBe(false);
    expect(store.sessions.has(token)).toBe(false);
  });

  it('falls back to the 7-day default for a non-positive value (the n > 0 guard)', () => {
    // parseInt('0', 10) === 0 and parseInt('-5', 10) === -5 are both finite but
    // fail `n > 0`; without that guard a 0 TTL would expire tokens instantly and
    // a negative TTL would set the deadline in the past at creation time.
    for (const bad of ['0', '-5']) {
      const StoreClass = loadStoreWith(bad);
      const ttl = ttlOf(StoreClass);
      const sevenDays = 7 * DAY_MS;
      expect(ttl).toBeGreaterThan(sevenDays - 60_000);
      expect(ttl).toBeLessThanOrEqual(sevenDays);
    }
  });

  it('falls back to the 7-day default for an empty string', () => {
    const StoreClass = loadStoreWith('');
    const ttl = ttlOf(StoreClass);
    const sevenDays = 7 * DAY_MS;
    expect(ttl).toBeGreaterThan(sevenDays - 60_000);
    expect(ttl).toBeLessThanOrEqual(sevenDays);
  });
});
