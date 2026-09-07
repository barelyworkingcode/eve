// End-to-end wire check for the eve<->relay passkey-enrolment contract
// (../relay/docs/eve-passkey-enrolment.md): EnrollmentWindow talking to the
// real HTTP route shapes the fake relay serves, through a real spawned eve.
//
// EVE_DISABLE_SUBNET_BYPASS=1 is required — otherwise a loopback caller (this
// test) is treated as trusted and /auth/status never reaches the enrolment
// window at all (see local-surface.test.js).
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startEve } = require('./harness');

// A one-passkey auth.json, as if a first browser had already enrolled — the
// scenario this whole feature exists for (adding a *second* browser).
function seedEnrolledAuthFile(dataDir) {
  const auth = {
    rpId: '127.0.0.1',
    userId: crypto.randomBytes(32).toString('base64url'),
    credentials: [{
      id: 'seed-cred',
      publicKey: Buffer.from('pk').toString('base64url'),
      counter: 0,
      transports: ['internal'],
      createdAt: '2026-01-01T00:00:00.000Z',
      label: 'Seed Browser',
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify(auth));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('eve <-> relay passkey-enrolment window (fake relay)', () => {
  let eve;

  beforeAll(async () => {
    eve = await startEve({
      env: { EVE_DISABLE_SUBNET_BYPASS: '1' },
      seedDataDir: seedEnrolledAuthFile,
    });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
  });

  it('reports enrollmentOpen: false and 403s enroll/start when relay has no window open', async () => {
    const status = await eve.get('/api/auth/status');
    expect(await status.json()).toEqual({ enrolled: true, authenticated: false, enrollmentOpen: false });

    const start = await eve.get('/api/auth/enroll/start', { method: 'POST' });
    expect(start.status).toBe(403);
    expect((await start.json()).error).toMatch(/^Enrollment is not open\./);
  });

  it('reports enrollmentOpen + enrollmentExpires and allows enroll/start once the console opens the window', async () => {
    await sleep(2100); // let the prior "closed" answer age out of EnrollmentWindow's 2s cache
    eve.relay.openEveEnrolment();

    const status = await eve.get('/api/auth/status');
    const body = await status.json();
    expect(body.enrolled).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.enrollmentOpen).toBe(true);
    expect(typeof body.enrollmentExpires).toBe('string');

    const start = await eve.get('/api/auth/enroll/start', { method: 'POST' });
    expect(start.status).toBe(200);
    const { options } = await start.json();
    // Multi-credential support (../relay/docs/eve-passkey-enrolment.md decision 5):
    // the seeded credential must be excluded so the authenticator can't duplicate it.
    expect(options.excludeCredentials).toEqual([
      { id: 'seed-cred', transports: ['internal'], type: 'public-key' },
    ]);
  });

  it('enroll/finish verifies before consuming: a failed ceremony leaves relay\'s window untouched', async () => {
    // Window is still open from the previous test. A bogus/expired challenge
    // fails inside verifyEnrollment, before routes/auth.js ever calls
    // enrollmentWindow.consume() — see decision 3 (verify -> consume -> save).
    const finish = await eve.get('/api/auth/enroll/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: { id: 'bogus' }, challengeId: 'not-a-real-challenge' }),
    });
    expect(finish.status).toBe(400);
    expect(eve.relay.listConsumedEnrolments()).toEqual([]);
  });
});

// A two-passkey auth.json, plus one sessions.json token minted by each — the
// scenario "revoke one, its sessions end, the other browser is untouched".
// No real WebAuthn ceremony runs here: a revoked credential's login/finish
// call is refused by PasskeySync.checkRevoked() *before* verifyLogin() ever
// looks at the (fake) assertion, so no genuine signature is needed to reach
// the behaviour under test — see routes/auth.js.
function seedTwoCredentialAuthFile(dataDir) {
  const auth = {
    rpId: '127.0.0.1',
    userId: crypto.randomBytes(32).toString('base64url'),
    credentials: [
      { id: 'seed-cred-a', publicKey: Buffer.from('pk-a').toString('base64url'), counter: 0, transports: ['internal'], createdAt: '2026-01-01T00:00:00.000Z', label: 'Browser A' },
      { id: 'seed-cred-b', publicKey: Buffer.from('pk-b').toString('base64url'), counter: 0, transports: ['internal'], createdAt: '2026-01-02T00:00:00.000Z', label: 'Browser B' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify(auth));
  const sessions = {
    'token-for-a': { expiresAt: Date.now() + 100000, credentialId: 'seed-cred-a' },
    'token-for-b': { expiresAt: Date.now() + 100000, credentialId: 'seed-cred-b' },
  };
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify(sessions));
}

async function waitUntil(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await sleep(intervalMs);
  }
}

describe('eve <-> relay passkey mirror and revocation (fake relay)', () => {
  let eve;

  beforeAll(async () => {
    eve = await startEve({
      env: { EVE_DISABLE_SUBNET_BYPASS: '1' },
      seedDataDir: seedTwoCredentialAuthFile,
    });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
  });

  it('reports its credential list (public metadata only) to relay once at startup', async () => {
    await waitUntil(() => eve.relay.listReportedPasskeys().length === 2);
    const reported = eve.relay.listReportedPasskeys();
    expect(reported.map((p) => p.id).sort()).toEqual(['seed-cred-a', 'seed-cred-b']);
    for (const entry of reported) {
      expect(entry).not.toHaveProperty('publicKey');
      expect(entry).not.toHaveProperty('counter');
    }
  });

  it('a pending revocation refuses the next login for that credential, applies it, and the report acknowledges it', async () => {
    eve.relay.seedPasskeyRevocation('seed-cred-a');

    const res = await eve.get('/api/auth/login/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: { id: 'seed-cred-a' }, challengeId: 'irrelevant' }),
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('This passkey has been revoked.');

    // Applied inline, before the response — no polling needed for this part.
    const auth = JSON.parse(fs.readFileSync(path.join(eve.dataDir, 'auth.json'), 'utf8'));
    expect(auth.credentials.map((c) => c.id)).toEqual(['seed-cred-b']);

    const sessions = JSON.parse(fs.readFileSync(path.join(eve.dataDir, 'sessions.json'), 'utf8'));
    expect(sessions).not.toHaveProperty('token-for-a');
    expect(sessions).toHaveProperty('token-for-b');

    // The report is the acknowledgement (decision 12) — relay's pending set
    // and mirror both drop the revoked id on the same round-trip.
    expect(eve.relay.listPendingRevocations()).toEqual([]);
    expect(eve.relay.listReportedPasskeys().map((p) => p.id)).toEqual(['seed-cred-b']);
  });

  it('the surviving credential still logs in cleanly (not refused)', async () => {
    const res = await eve.get('/api/auth/login/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: { id: 'seed-cred-b' }, challengeId: 'irrelevant' }),
    });

    // No real signature was ever provided, so the ceremony itself still
    // fails verification — the point here is that it's a 400 (verification
    // failure), never the 401 revocation refusal.
    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toBe('This passkey has been revoked.');
  });
});
