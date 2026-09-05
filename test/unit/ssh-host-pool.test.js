/**
 * Exercises HostPool/HostAgent against the real remote-fs-agent.js, spawned
 * locally via an injected spawnFn instead of ssh — the fake "ssh" the doc's
 * test plan calls for. Covers request/response, reconnect after the child
 * dies, and rejection of in-flight requests on exit.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HostPool, HostAgent } = require('../../ssh-host-pool');

const AGENT_PATH = path.join(__dirname, '..', '..', 'remote-fs-agent.js');

// Ignores ssh_argv entirely and just execs `node remote-fs-agent.js` — the
// spec's fake "ssh": HostAgent still builds `[...ssh_argv, '-T', '--',
// nodeLauncher(source)]`, but this spawner only ever looks at argv[0].
function localAgentSpawner() {
  return spawn(process.execPath, [AGENT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeHost(overrides = {}) {
  return { id: 'h1', name: 'devbox', ssh_argv: ['ssh', 'devbox'], ...overrides };
}

describe('HostAgent (spawned via a fake "ssh" that runs remote-fs-agent.js locally)', () => {
  let tmpDir, root, agent;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-hostpool-test-'));
    root = fs.realpathSync(tmpDir);
    fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
  });

  afterEach(() => {
    agent?.disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function waitForStatus(a, status, timeoutMs = 5000) {
    if (a.status === status) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for status ${status}`)), timeoutMs);
      a.on('status', (evt) => {
        if (evt.status === status) { clearTimeout(timer); resolve(evt); }
      });
    });
  }

  it('connects (hello round trip) and reports status transitions connecting -> connected', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    // The constructor sets 'connecting' synchronously, before any listener
    // attached after `new` could observe the event — assert the state directly.
    expect(agent.status).toBe('connecting');
    const statuses = [];
    agent.on('status', (evt) => statuses.push(evt.status));
    await waitForStatus(agent, 'connected');
    expect(statuses[statuses.length - 1]).toBe('connected');
  });

  it('serves a request/response round trip once connected', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    await waitForStatus(agent, 'connected');
    const res = await agent.request('read', { root, path: 'a.txt' });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('hi');
  });

  it('streams via stream(), invoking onChunk for each chunk', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    await waitForStatus(agent, 'connected');
    const chunks = [];
    const res = await agent.stream('stream', { root, path: 'a.txt' }, (buf) => chunks.push(buf));
    expect(res.ok).toBe(true);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hi');
  });

  it('rejects in-flight requests and flips to unreachable when the child dies', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    await waitForStatus(agent, 'connected');

    const pending = agent.request('read', { root, path: 'a.txt' });
    // Kill the underlying ssh process out from under the in-flight request.
    agent._proc.kill();

    await expect(pending).rejects.toThrow(/unreachable/);
    await waitForStatus(agent, 'unreachable');
  });

  it('reconnects with backoff after the child dies and serves requests again', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    await waitForStatus(agent, 'connected');

    agent._reconnectDelay = 10; // don't make the test wait out the real 1s floor
    agent._proc.kill();
    await waitForStatus(agent, 'unreachable');
    await waitForStatus(agent, 'connected', 10000);

    const res = await agent.request('read', { root, path: 'a.txt' });
    expect(res.ok).toBe(true);
  });

  it('a deliberate disconnect() does not schedule a reconnect', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    await waitForStatus(agent, 'connected');
    agent.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(agent.status).toBe('connected'); // disconnect() doesn't emit a status change itself
    expect(agent._proc).toBeNull();
    expect(agent._reconnectTimer).toBeNull();
    await expect(agent.request('hello', {})).rejects.toThrow(/unreachable/);
  });

  it('ref-counts watch/unwatch so a second watcher does not tear down the first', async () => {
    agent = new HostAgent({ host: makeHost(), spawnFn: localAgentSpawner });
    await waitForStatus(agent, 'connected');

    await agent.watch(root);
    await agent.watch(root); // second ref
    await agent.unwatch(root); // drops to 1 ref, must NOT send unwatch yet

    const changeSeen = new Promise((resolve) => agent.once('change', resolve));
    fs.writeFileSync(path.join(root, 'b.txt'), 'x');
    await expect(changeSeen).resolves.toBeDefined();

    await agent.unwatch(root); // last ref
  });
});

describe('HostPool', () => {
  let tmpDir, root, pool;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-hostpool-pool-test-'));
    root = fs.realpathSync(tmpDir);
  });

  afterEach(() => {
    pool?.disconnectAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for an unknown host id', () => {
    pool = new HostPool({ resolveHost: () => null });
    expect(pool.get('nope')).toBeNull();
  });

  it('caches one HostAgent per host id across repeated get() calls', () => {
    pool = new HostPool({ resolveHost: () => makeHost(), spawnFn: localAgentSpawner });
    const a1 = pool.get('h1');
    const a2 = pool.get('h1');
    expect(a1).toBe(a2);
  });

  it('bubbles agent status events with hostId', async () => {
    pool = new HostPool({ resolveHost: () => makeHost(), spawnFn: localAgentSpawner });
    const events = [];
    pool.on('status', (evt) => events.push(evt));
    pool.get('h1');
    await new Promise((resolve) => {
      const check = () => {
        if (events.some((e) => e.status === 'connected')) return resolve();
        setTimeout(check, 20);
      };
      check();
    });
    expect(events.some((e) => e.hostId === 'h1' && e.status === 'connected')).toBe(true);
  });

  it('statuses() reports every host this pool has spawned an agent for', async () => {
    pool = new HostPool({ resolveHost: () => makeHost(), spawnFn: localAgentSpawner });
    pool.get('h1');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const statuses = pool.statuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ hostId: 'h1', name: 'devbox' });
  });

  it('disconnect(hostId) tears the agent down and a later get() spawns fresh', async () => {
    pool = new HostPool({ resolveHost: () => makeHost(), spawnFn: localAgentSpawner });
    const a1 = pool.get('h1');
    await new Promise((resolve) => {
      const check = () => (a1.status === 'connected' ? resolve() : setTimeout(check, 20));
      check();
    });
    pool.disconnect('h1');
    const a2 = pool.get('h1');
    expect(a2).not.toBe(a1);
    a2.disconnect();
  });
});
