// The Chief of Staff follows the setting relay holds: a change made while eve runs reaches the next
// model session. Real server, real ChiefOfStaff and model, the fake relay's GET /api/chief-of-staff/config.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startEve } = require('./harness');

const WAIT = 15000;
const haiku = (projectId) => ({ projectId, model: 'haiku', dailyModelCalls: 100 });

let eve;
let ws;
let dirs = [];
afterEach(async () => {
  if (ws) { try { await ws.close(); } catch { /* already closed */ } }
  ws = null;
  if (eve) await eve.stop();
  eve = null;
  for (const d of dirs) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function boot() {
  const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cos-cfg-'))); dirs.push(d); return d; };
  eve = await startEve({
    projects: [{ id: 'pa', name: 'Acme A', path: mk() }, { id: 'pb', name: 'Acme B', path: mk() }],
  });
  eve.relay.setCosModel({ reply: (text, n) => (n === 1 ? 'ready' : text.startsWith('Chief of Staff person') ? 'Noted.' : null) });
  await eve.relay.waitForScopedRelay();
  ws = await eve.connectWs();
  ws.send({ type: 'cos_subscribe' });
  await ws.waitFor((f) => f.type === 'cos_snapshot');
}

const say = async (text, body) => {
  const from = ws.mark();
  ws.send({ type: 'cos_message', text });
  await ws.waitFor((f) => f.type === 'cos_post' && f.post.kind === 'reply' && f.post.body === body, WAIT, from);
};
const personCreates = () => eve.relay.cosSessionCreates;
const deletes = () => eve.relay.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith('/api/sessions/'));

describe('a change in relay reaches the next turn', () => {
  it('relaunches the person session in the new project and model, and ends the old one, with no restart', async () => {
    await boot();
    eve.relay.setChiefOfStaffConfig(haiku('pa'));
    await say('first', 'Noted.');
    const inA = personCreates().filter((c) => c.body.projectId === 'pa');
    expect(inA.length).toBeGreaterThan(0);
    expect(inA.every((c) => c.body.model === 'haiku')).toBe(true);
    const oldPerson = inA[inA.length - 1].sessionId;

    eve.relay.setChiefOfStaffConfig({ projectId: 'pb', model: 'opus', dailyModelCalls: 100 });
    await say('second', 'Noted.');

    expect(deletes().map((r) => r.path)).toContain(`/api/sessions/${oldPerson}`);
    const inB = personCreates().filter((c) => c.body.projectId === 'pb');
    expect(inB.length).toBeGreaterThan(0);
    expect(inB.every((c) => c.body.model === 'opus')).toBe(true);
  });

  it('the config call carries no scope header', async () => {
    await boot();
    eve.relay.setChiefOfStaffConfig(haiku('pa'));
    await say('first', 'Noted.');
    const reads = eve.relay.scopeLog.filter((e) => e.method === 'GET' && e.path === '/api/chief-of-staff/config');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((e) => e.scope === null)).toBe(true);
  });

  it.each([
    ['is cleared', null],
    ['is a 404 from an older relay', 'absent'],
  ])('when the relay setting %s, the next turn returns to the defaults', async (_what, value) => {
    await boot();
    eve.relay.setChiefOfStaffConfig({ projectId: 'pb', model: 'opus', dailyModelCalls: 100 });
    await say('first', 'Noted.');
    expect(personCreates().every((c) => c.body.projectId === 'pb' && c.body.model === 'opus')).toBe(true);
    const before = personCreates().length;

    eve.relay.setChiefOfStaffConfig(value);
    await say('second', 'Noted.');
    const after = personCreates().slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.body.projectId === 'pa' && c.body.model === 'sonnet')).toBe(true);
  });
});
