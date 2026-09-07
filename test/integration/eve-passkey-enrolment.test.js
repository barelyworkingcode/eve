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
