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
const HELPER_GRACE_MS = 10000;
const DEFAULT_HELPER = path.join(os.homedir(), '.local', 'share', 'devboxverify', 'bin', 'devboxpresence');

// `devboxpresence answer` exit codes. 2 is a usage error, 4 an unusable
// password file, 5 a dialog still open 5 s after the helper acted; those and
// any unlisted code are 'error'.
const PRESENCE_EXIT = {
  0: 'answered',
  1: 'no-prompt',
  3: 'refused',
};

function presenceOutcome(code) {
  return PRESENCE_EXIT[code] || 'error';
}

// The helper prints one line, `DIALOG\t<word>\t<detail>`.
function dialogDetail(stdout) {
  const line = String(stdout).split('\n').find(l => l.startsWith('DIALOG\t'));
  if (!line) return '';
  const [, word, ...rest] = line.split('\t');
  return [word, rest.join(' ')].filter(Boolean).join(': ').slice(0, 200);
}

function shellQuote(argv) {
  return argv.map(a => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(' ');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(cmd, args, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err) => {
      if (err) reject(new Error(`${path.basename(cmd)} ${args[0] || ''} failed: ${String(err.message).split('\n')[0]}`));
      else resolve();
    });
  });
}

function createScreen({ helperBin = process.env.DEVBOXPRESENCE_BIN || DEFAULT_HELPER, computer = 'computer' } = {}) {
  const act = (...args) => run(computer, args);
  const haveHelper = () => fs.existsSync(helperBin);

  async function consoleRun(argv) {
    await run('open', ['-a', 'Terminal']);
    await sleep(SETTLE_MS);
    await act('key', 'cmd+n');
    await sleep(SETTLE_MS);
    await act('type', shellQuote(argv));
    await act('key', 'return');
  }

  // A stray dialog is cancelled first; it holds focus over Terminal.
  async function closeConsole() {
    if (haveHelper()) await new Promise(resolve => execFile(helperBin, ['cancel', '--any'], { timeout: COMMAND_TIMEOUT_MS }, () => resolve()));
    await run('open', ['-a', 'Terminal']);
    await sleep(SETTLE_MS);
    await act('key', 'ctrl+c');
    await act('type', 'exit');
    await act('key', 'return');
  }

  // This is subtle: it starts the helper now and returns the promise, and the
  // caller triggers the dialog after. The helper refuses a dialog that was
  // already open when it started.
  function answerPresence({ expect, timeoutMs = 20000 }) {
    if (!haveHelper()) return Promise.resolve({ state: 'no-helper', code: null, detail: '' });
    return new Promise((resolve) => {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const child = spawn(helperBin, ['answer', '--expect', expect, '--timeout', `${seconds}s`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), seconds * 1000 + HELPER_GRACE_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ state: 'error', code: null, detail: `presence helper did not start: ${err.code || err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ state: presenceOutcome(code), code, detail: dialogDetail(out) });
      });
    });
  }

  return { consoleRun, closeConsole, answerPresence };
}

module.exports = { createScreen, presenceOutcome, dialogDetail, shellQuote, PRESENCE_EXIT };
