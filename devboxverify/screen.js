'use strict';
// The real screen, for journeys marked `screen: true`: a desktop Terminal for
// console-only commands, and relay's presence helper for the dialogs they
// raise. Drives input through the `computer` CLI, never AppleScript, which
// would block on an Automation consent dialog. Eve never reads the account
// password; the helper does, and checks the dialog is relay's before typing.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTLE_MS = 1500;
const COMMAND_TIMEOUT_MS = 15000;
const HELPER_BUILD_TIMEOUT_MS = 120000;
const HELPER_GRACE_MS = 10000;

// Deliberate: relay has not pinned the helper's exit codes yet. This table is
// the one place to change when it does. Any code not listed is an error.
const PRESENCE_EXIT = {
  0: 'answered',
  2: 'no-prompt',
  3: 'locked',
};

function presenceOutcome(code) {
  const outcome = PRESENCE_EXIT[code];
  if (!outcome) throw new Error(`presence helper exited ${code === null ? 'on a signal' : code}`);
  return outcome;
}

function shellQuote(argv) {
  return argv.map(a => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(cmd, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err) => {
      if (err) reject(new Error(`${path.basename(cmd)} ${args[0] || ''} failed: ${String(err.message).split('\n')[0]}`));
      else resolve();
    });
  });
}

function helperDir(relayDir) {
  return relayDir && fs.existsSync(path.join(relayDir, 'cmd', 'devboxpresence')) ? relayDir : null;
}

// `relayDir` is a relay checkout that holds cmd/devboxpresence.
function createScreen({ relayDir, computer = 'computer' } = {}) {
  const act = (...args) => run(computer, args);

  async function consoleRun(argv) {
    await run('open', ['-a', 'Terminal']);
    await sleep(SETTLE_MS);
    await act('key', 'cmd+n');
    await sleep(SETTLE_MS);
    await act('type', shellQuote(argv));
    await act('key', 'return');
  }

  // The presence dialog takes focus, so Terminal is brought back first.
  async function closeConsole() {
    await run('open', ['-a', 'Terminal']);
    await sleep(SETTLE_MS);
    await act('key', 'ctrl+c');
    await act('type', 'exit');
    await act('key', 'return');
  }

  // Deliberate: the helper is built, then run, rather than `go run`: `go run`
  // turns every non-zero exit into 1, which would hide which outcome it was.
  async function answerPresence({ timeoutMs = 30000 } = {}) {
    const dir = helperDir(relayDir);
    if (!dir) return 'no-helper';
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devboxpresence-'));
    try {
      const bin = path.join(scratch, 'devboxpresence');
      await run('go', ['build', '-o', bin, './cmd/devboxpresence'], { cwd: dir, timeoutMs: HELPER_BUILD_TIMEOUT_MS });
      const code = await new Promise((resolve, reject) => {
        // Deliberate: the helper's output is not forwarded, so nothing it
        // prints can reach a log.
        const child = spawn(bin, ['--timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`], { cwd: dir, stdio: 'ignore' });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + HELPER_GRACE_MS);
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      });
      return presenceOutcome(code);
    } finally {
      if (scratch && scratch.startsWith(os.tmpdir())) fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  return { consoleRun, closeConsole, answerPresence };
}

module.exports = { createScreen, presenceOutcome, shellQuote, PRESENCE_EXIT };
