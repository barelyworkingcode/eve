#!/usr/bin/env node
'use strict';

// Builds the two Go programs the e2e suite runs eve against, from the commits
// in test/e2e/relay-pin.json: fakerelay (relay's repo) and relayScheduler.
// Both are built one way: fetch the exact commit, `go build`, cache by commit.
// Nothing here runs at require time, so `playwright test --list` stays cheap.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PIN_FILE = path.join(__dirname, '..', 'relay-pin.json');
const SHA_RE = /^[0-9a-f]{40}$/;

class BuildError extends Error {}

function cacheDir(env = process.env) {
  if (env.EVE_E2E_CACHE) return path.resolve(env.EVE_E2E_CACHE);
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'eve-e2e');
  return path.join(os.homedir(), '.cache', 'eve-e2e');
}

// A run inside a git hook carries GIT_DIR and friends; any of them would point
// these git calls at eve's own repository.
function withoutGitEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, out: '', err: err.message, spawnError: err });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ code: 127, out, err: e.message, spawnError: e }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function tail(text) {
  return text.trim().split('\n').slice(-6).join(' | ');
}

function readPin() {
  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
  } catch (err) {
    throw new BuildError(`cannot read ${PIN_FILE}: ${err.message}`);
  }
  for (const key of ['fakerelay', 'relayScheduler']) {
    const entry = pin[key];
    if (!entry || typeof entry.repo !== 'string' || typeof entry.dir !== 'string' || typeof entry.pkg !== 'string') {
      throw new BuildError(`relay-pin.json: ${key} needs repo, commit, dir and pkg`);
    }
    if (typeof entry.commit !== 'string' || !SHA_RE.test(entry.commit)) {
      throw new BuildError(`relay-pin.json: ${key}.commit must be a full 40-hex SHA, got "${entry.commit}"`);
    }
  }
  return pin;
}

async function buildOne(name, entry, cache, env) {
  const finalDir = path.join(cache, `${name}-${entry.commit}`);
  const finalBin = path.join(finalDir, name);
  if (fs.existsSync(finalBin)) return finalBin;

  fs.mkdirSync(cache, { recursive: true });
  const work = fs.mkdtempSync(path.join(cache, `.build-${name}-`));
  try {
    const src = path.join(work, 'src');
    fs.mkdirSync(src);
    const gitEnv = withoutGitEnv(env);
    const git = (...args) => run('git', args, { cwd: src, env: gitEnv });

    let res = await git('init', '--quiet');
    if (res.code === 0) res = await git('fetch', '--quiet', '--depth', '1', entry.repo, entry.commit);
    if (res.code !== 0) {
      throw new BuildError(`git fetch ${entry.repo} ${entry.commit} failed: ${tail(res.err || res.out)}`);
    }
    res = await git('-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD');
    if (res.code !== 0) {
      throw new BuildError(`git fetch ${entry.repo} ${entry.commit} failed: checkout: ${tail(res.err || res.out)}`);
    }

    const staged = path.join(work, 'out');
    fs.mkdirSync(staged);
    // -buildvcs=false: the throwaway checkout has no history to stamp.
    res = await run('go', ['build', '-C', path.join(src, entry.dir), '-buildvcs=false', '-o', path.join(staged, name), entry.pkg],
      { env: gitEnv });
    if (res.spawnError && res.spawnError.code === 'ENOENT') {
      throw new BuildError('go not found (Go 1.25+ builds fakerelay from test/e2e/relay-pin.json; or set EVE_FAKERELAY_BIN)');
    }
    if (res.code !== 0) throw new BuildError(`go build ${name} failed: ${tail(res.err || res.out)}`);

    try {
      fs.renameSync(staged, finalDir);
    } catch (err) {
      // A parallel run won the rename; its binary is the same commit.
      if (!fs.existsSync(finalBin)) throw err;
    }
    return finalBin;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

let announced = false;

function override(varName, env) {
  const value = env[varName];
  if (!value) return null;
  const abs = path.resolve(value);
  if (!fs.existsSync(abs)) throw new BuildError(`${varName}=${value} does not exist`);
  if (!announced) process.stderr.write(`using ${varName}=${abs}, not the pin\n`);
  return abs;
}

async function buildFakes(env = process.env) {
  const cache = cacheDir(env);
  const result = {};
  let pin = null;
  const need = () => (pin || (pin = readPin()));
  const targets = [
    ['fakerelay', 'fakerelay', 'EVE_FAKERELAY_BIN', 'fakerelay'],
    ['relayscheduler', 'relayScheduler', 'EVE_RELAYSCHEDULER_BIN', 'relayscheduler'],
  ];
  for (const [key, pinKey, envName] of targets) {
    const own = override(envName, env);
    result[key] = own || await buildOne(key, need()[pinKey], cache, env);
  }
  announced = true;
  return result;
}

async function cli() {
  try {
    const bins = await buildFakes();
    process.stdout.write(`fakerelay ${bins.fakerelay}\nrelayscheduler ${bins.relayscheduler}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof BuildError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (require.main === module) cli().then((code) => process.exit(code));

module.exports = { buildFakes, BuildError };
