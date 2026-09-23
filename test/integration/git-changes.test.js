/**
 * Changes panel over the real WebSocket (docs/design-git-changes.md,
 * "WebSocket frames"): git_changes / git_file_versions / git_error against a
 * real git repo, the git_changed push once a Changes tab has asked, and the
 * two-connection isolation guarantee (C1, docs/decisions/003-ws-message-registry.md)
 * for the git arms. Kept out of ws-dispatch.test.js, which is frozen.
 */
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');
const { makeTmp, initRepo, write } = require('../helpers/git-fixture');

describe('git changes over WS', () => {
  let eve;
  let projectDir;
  let wsA;
  let wsB;

  beforeAll(async () => {
    projectDir = makeTmp('eve-it-git-');
    initRepo(projectDir, { 'a.txt': 'AAA-ORIG\n', 'b.txt': 'BBB-ORIG\n' });
    write(projectDir, 'a.txt', 'AAA-NEW\n');
    write(projectDir, 'b.txt', 'BBB-NEW\n');
    write(projectDir, 'untracked.txt', 'u\n');
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    wsA = await eve.connectWs();
    wsB = await eve.connectWs();
  });

  afterAll(async () => {
    if (wsA) await wsA.close();
    if (wsB) await wsB.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('git_changes lists the project repo and its changed files', async () => {
    const from = wsA.mark();
    wsA.send({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' });
    const reply = await wsA.waitFor((f) => f.type === 'git_changes', 10000, from);
    expect(reply).toMatchObject({ projectId: 'p1', scope: 'uncommitted' });
    expect(reply.repos).toHaveLength(1);
    expect(reply.repos[0]).toMatchObject({ path: '/', name: path.basename(projectDir), branch: 'main', base: null, truncated: false });
    expect([...reply.repos[0].files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', status: 'M', staged: false },
      { path: 'b.txt', status: 'M', staged: false },
      { path: 'untracked.txt', status: '?', staged: false },
    ]);
    // The browser only ever sees project-relative paths.
    expect(JSON.stringify(reply)).not.toContain(projectDir);
  });

  it('git_file_versions returns both sides of a file', async () => {
    const from = wsA.mark();
    wsA.send({ type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'a.txt', scope: 'uncommitted' });
    const reply = await wsA.waitFor((f) => f.type === 'git_file_versions', 10000, from);
    expect(reply).toEqual({
      type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'a.txt', scope: 'uncommitted',
      original: 'AAA-ORIG\n', modified: 'AAA-NEW\n', binary: false, tooLarge: false, originalSize: 9, modifiedSize: 8,
    });
  });

  it('bad input and unknown projects come back as git_error', async () => {
    const from = wsA.mark();
    wsA.send({ type: 'git_changes', projectId: 'p1', scope: 'everything' });
    const invalid = await wsA.waitFor((f) => f.type === 'git_error' && f.code === 'INVALID', 5000, from);
    expect(invalid.projectId).toBe('p1');

    wsA.send({ type: 'git_file_versions', projectId: 'ghost', repo: '/', path: 'a.txt', scope: 'uncommitted' });
    const notFound = await wsA.waitFor((f) => f.type === 'git_error' && f.code === 'NOT_FOUND', 5000, from);
    expect(notFound.projectId).toBe('ghost');

    wsA.send({ type: 'git_file_versions', projectId: 'p1', repo: '/', path: '../../etc/passwd', scope: 'uncommitted' });
    const traversal = await wsA.waitFor((f) => f.type === 'git_error' && f.path === '../../etc/passwd', 5000, from);
    expect(traversal.code).toBe('FAILED');
    expect(JSON.stringify(traversal)).not.toContain(projectDir);
  });

  it('git_file_versions on each connection replies only to the connection that asked', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    wsA.send({ type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'a.txt', scope: 'uncommitted' });
    wsB.send({ type: 'git_file_versions', projectId: 'p1', repo: '/', path: 'b.txt', scope: 'uncommitted' });

    const replyA = await wsA.waitFor((f) => f.type === 'git_file_versions' && f.path === 'a.txt', 10000, fromA);
    const replyB = await wsB.waitFor((f) => f.type === 'git_file_versions' && f.path === 'b.txt', 10000, fromB);

    expect(replyA.modified).toBe('AAA-NEW\n');
    expect(replyB.modified).toBe('BBB-NEW\n');
    expect(wsA.frames.slice(fromA).some((f) => f.type === 'git_file_versions' && f.path === 'b.txt')).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.type === 'git_file_versions' && f.path === 'a.txt')).toBe(false);
  });

  it('git_changes on each connection replies only to the connection that asked', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    wsA.send({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' });
    wsB.send({ type: 'git_changes', projectId: 'p1', scope: 'base' });

    const replyA = await wsA.waitFor((f) => f.type === 'git_changes', 10000, fromA);
    const replyB = await wsB.waitFor((f) => f.type === 'git_changes', 10000, fromB);

    expect(replyA.scope).toBe('uncommitted');
    expect(replyB.scope).toBe('base');
    expect(wsA.frames.slice(fromA).some((f) => f.type === 'git_changes' && f.scope === 'base')).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.type === 'git_changes' && f.scope === 'uncommitted')).toBe(false);
  });

  it('after git_changes, a write in the repo pushes git_changed to that connection', async () => {
    const from = wsA.mark();
    wsA.send({ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' });
    await wsA.waitFor((f) => f.type === 'git_changes', 10000, from);
    // Let the recursive watcher settle before generating the event.
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(projectDir, 'pushed.txt'), 'p\n', 'utf8');
    const pushed = await wsA.waitFor((f) => f.type === 'git_changed' && f.repo === '/', 5000, from);
    expect(pushed).toEqual({ type: 'git_changed', projectId: 'p1', repo: '/' });
  });
});
