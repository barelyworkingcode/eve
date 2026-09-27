#!/usr/bin/env node
'use strict';

// One advisory lock shared by every browser test run on the machine.
// Node has no flock and macOS has no flock(1), so a perl child holds the
// kernel lock and keeps it until its stdin pipe closes. Any death of the
// Node holder, SIGKILL included, closes that pipe, so a stale lock cannot
// outlive its process and there is no liveness heuristic to get wrong.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_MS = 1000;
const COMMAND_MAX = 200;

// Ignores INT/TERM/HUP so a Ctrl-C to the process group cannot drop the
// lock while the wrapped run is still shutting down. Opens for append so a
// busy attempt never truncates the holder's record.
const HELPER = `
use strict;
use Fcntl qw(:flock);
$SIG{$_} = 'IGNORE' for qw(INT TERM HUP);
$| = 1;
open(my $fh, '>>', $ARGV[0]) or die "open: $!\\n";
unless (flock($fh, LOCK_EX | LOCK_NB)) {
  die "flock: $!\\n" unless $!{EWOULDBLOCK};
  print "busy\\n";
  exit 0;
}
print "locked\\n";
my $buf;
1 while sysread(STDIN, $buf, 4096);
exit 0;
`;

function lockPath(env = process.env) {
  if (env.EVE_BROWSER_LOCK) return path.resolve(env.EVE_BROWSER_LOCK);
  return path.join(os.homedir(), '.cache', 'eve', 'browser-tests.lock');
}

function lockTimeoutMs(env = process.env) {
  const raw = env.EVE_BROWSER_LOCK_TIMEOUT;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  throw lockError('ELOCKCONFIG', `EVE_BROWSER_LOCK_TIMEOUT must be a whole number of seconds, got "${raw}"`);
}

function lockError(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

function printable(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, COMMAND_MAX);
}

function readHolder(file) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!rec || !Number.isInteger(rec.pid) || typeof rec.command !== 'string') return null;
  return { pid: rec.pid, command: printable(rec.command), since: printable(rec.since) };
}

function describe(holder) {
  return holder ? `pid ${holder.pid} (${holder.command}) since ${holder.since}` : 'an unknown holder';
}

function attempt(file) {
  return new Promise((resolve, reject) => {
    const unavailable = reason => reject(lockError('ELOCKUNAVAILABLE', `cannot take ${file}: ${reason}`));
    let helper;
    try {
      helper = spawn('perl', ['-e', HELPER, file], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      unavailable(err.code === 'ENOENT' ? 'perl not found on PATH' : err.message);
      return;
    }
    let out = '';
    let errText = '';
    let answered = false;
    helper.stdin.on('error', () => {});
    helper.stderr.on('data', chunk => { errText += chunk; });
    helper.stdout.on('data', chunk => {
      if (answered) return;
      out += chunk;
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      answered = true;
      const line = out.slice(0, nl).trim();
      if (line === 'locked') resolve({ state: 'locked', helper });
      else if (line === 'busy') resolve({ state: 'busy' });
      else {
        helper.kill('SIGKILL');
        unavailable(`lock helper answered "${printable(line)}"`);
      }
    });
    helper.on('error', err => {
      if (answered) return;
      answered = true;
      unavailable(err.code === 'ENOENT' ? 'perl not found on PATH' : err.message);
    });
    helper.on('close', (code, signal) => {
      if (answered) return;
      answered = true;
      const detail = errText.trim().split('\n')[0] || `exit ${signal || code}`;
      unavailable(`lock helper died before answering (${printable(detail)})`);
    });
  });
}

function hold(file, helper, command, log) {
  let released = null;
  let lost = false;
  const exited = new Promise(resolve => {
    if (helper.exitCode !== null || helper.signalCode !== null) resolve();
    else helper.once('exit', resolve);
  });
  exited.then(() => {
    if (released) return;
    lost = true;
    log(`browser-lock: lost ${file}: lock helper exited`);
  });

  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, command, since: new Date().toISOString() }) + '\n');
  } catch (err) {
    released = exited;
    try { helper.stdin.end(); } catch {}
    throw err;
  }

  return function release() {
    if (!released) {
      released = (async () => {
        // Once the lock is lost the record may belong to the next holder.
        if (!lost) try { fs.truncateSync(file, 0); } catch {}
        try { helper.stdin.end(); } catch {}
        await exited;
      })();
    }
    return released;
  };
}

async function acquire({
  command,
  file = lockPath(),
  timeoutMs = lockTimeoutMs(),
  log = line => process.stderr.write(line + '\n'),
}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    throw lockError('ELOCKUNAVAILABLE', `cannot take ${file}: ${err.message}`);
  }

  const start = Date.now();
  let waited = false;
  let lastSeen;
  for (;;) {
    const result = await attempt(file);
    if (result.state === 'locked') {
      let release;
      try {
        release = hold(file, result.helper, String(command), log);
      } catch (err) {
        throw lockError('ELOCKUNAVAILABLE', `cannot take ${file}: ${err.message}`);
      }
      if (waited) log(`browser-lock: acquired ${file} after ${Math.round((Date.now() - start) / 1000)}s`);
      return release;
    }

    const holder = readHolder(file);
    const seen = describe(holder);
    if (seen !== lastSeen) {
      log(`browser-lock: ${file} is held by ${seen}; waiting up to ${Math.round(timeoutMs / 1000)}s`);
      lastSeen = seen;
    }
    if (Date.now() - start >= timeoutMs) {
      throw lockError('ELOCKTIMEOUT', `gave up after ${Math.round(timeoutMs / 1000)}s; ${file} is held by ${seen}`, { holder });
    }
    waited = true;
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
}

const EXIT = { ELOCKCONFIG: 64, ELOCKUNAVAILABLE: 70, ELOCKTIMEOUT: 75 };

async function cli(argv) {
  if (argv.length === 0) {
    process.stderr.write('usage: node scripts/browser-lock.js <command> [args...]\n');
    return 64;
  }

  let release;
  try {
    release = await acquire({ command: argv.join(' ') });
  } catch (err) {
    process.stderr.write(`browser-lock: ${err.message}\n`);
    return EXIT[err.code] || 70;
  }

  const cannotRun = err => process.stderr.write(`browser-lock: cannot run ${printable(argv[0])}: ${err.message}\n`);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
  } catch (err) {
    cannotRun(err);
    await release();
    return 127;
  }
  const forward = signal => () => { try { child.kill(signal); } catch {} };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  const code = await new Promise(resolve => {
    child.once('error', err => {
      cannotRun(err);
      resolve(127);
    });
    child.once('exit', (exitCode, signal) => {
      resolve(signal ? 128 + (os.constants.signals[signal] || 0) : exitCode);
    });
  });
  await release();
  return code;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = { acquire, lockPath, lockTimeoutMs };
