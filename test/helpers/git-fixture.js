/**
 * Throwaway git repos for the Changes-panel tests (git-service, file-handlers,
 * integration). Every fixture git
 * call pins identity/branch/hook config on the command line and drops
 * inherited GIT_* env, so the developer's global config (default branch,
 * signing, hooks) can't change what a fixture looks like.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE_CONFIG = [
  '-c', 'user.name=Eve Test',
  '-c', 'user.email=test@example.com',
  '-c', 'init.defaultBranch=main',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.autocrlf=false',
  '-c', 'advice.detachedHead=false',
];

function fixtureEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

// Runs git in `cwd`; returns trimmed stdout. Throws on non-zero exit unless
// `allowFail` (then returns { status, stdout }).
function git(cwd, args, { allowFail = false, config = [] } = {}) {
  try {
    const out = execFileSync('git', [...FIXTURE_CONFIG, ...config, ...args], {
      cwd, env: fixtureEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return allowFail ? { status: 0, stdout: out } : out.trim();
  } catch (err) {
    if (allowFail) return { status: err.status, stdout: String(err.stdout || '') };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${err.stderr || err.message}`);
  }
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function makeTmp(prefix = 'eve-git-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// git init + one commit of `files` ({ rel: content }). `branch` overrides the
// initial branch name. With no files the repo is left unborn.
function initRepo(dir, files = {}, { branch = 'main', message = 'init' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch]);
  const names = Object.keys(files);
  if (names.length) {
    for (const rel of names) write(dir, rel, files[rel]);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', message]);
  }
  return dir;
}

function commitAll(dir, message = 'wip') {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function headSha(dir) {
  return git(dir, ['rev-parse', 'HEAD']);
}

// A RelayFileClient talking to the fake relay over HTTP, for tests that need
// real git behind the relay `git` op. filesFor(dir) registers a project whose
// files are the real directory `dir` (the fake's disk mode) and returns its
// ProjectFiles; gitRequests() lists the git ops relay saw, in order. The
// require()s are lazy so a test that never calls this loads none of it.
async function startDiskRelay() {
  const { createFakeRelay } = require('../integration/fake-relay');
  const { RelayTransport } = require('../../relay-transport');
  const { NullLogger } = require('../../logger');
  const mod = require('../../relay-file-client');
  const RelayFileClient = mod.RelayFileClient || mod;
  const relay = createFakeRelay({ token: null });
  const port = await relay.listen();
  const log = new NullLogger();
  const relayTransport = RelayTransport.fromEnv({ env: { RELAY_FRONTEND_URL: `http://127.0.0.1:${port}`, RELAY_FRONTEND_TOKEN: 'test-token' }, log });
  const client = new RelayFileClient({ relayTransport, log });
  let n = 0;
  return {
    relay,
    client,
    filesFor(dir) {
      const id = `disk${++n}`;
      relay.addProject({ id, name: id, path: dir });
      relay.files.useDisk(id, dir);
      return client.forProject({ id, name: id, path: dir });
    },
    gitRequests: () => relay.files.requests.filter((r) => r.op === 'git').map((r) => ({ projectId: r.projectId, cwdRel: r.body.cwd, args: r.body.args })),
    close: async () => { client.close(); await relay.close(); },
  };
}

module.exports = { git, write, makeTmp, initRepo, commitAll, headSha, startDiskRelay };
