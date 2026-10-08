const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const run = promisify(execFile);
const { changedFiles } = require('../../devboxverify/areas');
const { runSelection } = require('../../devboxverify/main');
const { journeys } = require('../../devboxverify/journeys');

// Deliberate: a git hook exports GIT_DIR and friends, which would point these
// calls at the real repo instead of the temp one.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) => run('git', ['-C', cwd, '-c', 'user.name=Tester', '-c', 'user.email=t@example.test',
  '-c', 'commit.gpgsign=false', ...args], { env });

describe('devboxverify selection against a real git repo', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-sel-')); });
  afterEach(() => {
    if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function initRepo() {
    await git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(dir, 'edit.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'gone\n');
    fs.writeFileSync(path.join(dir, 'old-name.txt'), 'a rename needs enough content to be detected\n'.repeat(5));
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'base');
  }

  it('lists added, modified, deleted and both ends of a rename', async () => {
    await initRepo();
    await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(dir, 'checkout', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    fs.writeFileSync(path.join(dir, 'edit.txt'), 'two\n');
    await git(dir, 'rm', '-q', 'gone.txt');
    await git(dir, 'mv', 'old-name.txt', 'new-name.txt');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'change');

    const res = await changedFiles(dir);
    expect([...res.files].sort()).toEqual(['edit.txt', 'gone.txt', 'new-name.txt', 'new.txt', 'old-name.txt']);
  });

  it('returns an error without origin/main, and runSelection then runs everything', async () => {
    await initRepo();
    const changed = await changedFiles(dir);
    expect(typeof changed.error).toBe('string');
    expect(changed.error.length).toBeGreaterThan(0);

    const mapText = fs.readFileSync(path.join(__dirname, '../../docs/areas.jsonc'), 'utf8');
    const sel = runSelection({ all: journeys, only: null, post: '7', mapText, changed });
    expect(sel.mode).toBe('full');
    expect(sel.why.startsWith('no diff:')).toBe(true);
    expect(sel.ids).toEqual(journeys.map((j) => j.id));
  });
});
