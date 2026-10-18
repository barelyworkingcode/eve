// Removes the conversation file a verify journey's interactive Claude leaves in
// Claude's session list. See README.md, "Transcript cleanup".
// Deliberate: nothing here rejects or throws. A cleanup that failed would turn
// a PASS into a FAIL, so every problem becomes one stderr line instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { poll } = require('./journey-kit');

const exec = promisify(execFile);

const EXIT_WITHIN_MS = 15000;
// Sits well above EXIT_WITHIN_MS plus the file work; a cleanup that times out reads as a FAIL.
const TRANSCRIPT_CLEANUP_MS = 30000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9-]+$/;

// True when the ps listing (`ps -axo pid=,ppid=,command=`) has a process whose
// executable base name is claude and whose argv holds `${flag} ${id}`. The
// executable is the text before the first flag, so a shell or ssh client that
// only carries the arguments is not matched.
function listed(psText, flag, id) {
  const needle = `${flag} ${id}`;
  return String(psText).split('\n').some((line) => {
    const m = /^\s*\d+\s+\d+\s+(.*)$/.exec(line);
    if (!m) return false;
    const command = m[1];
    const exe = command.split(' --')[0].trim().split(' ')[0];
    if (path.basename(exe) !== 'claude') return false;
    const at = command.indexOf(needle);
    return at >= 0 && (command.length === at + needle.length || command[at + needle.length] === ' ');
  });
}

// A short code for err, never a path.
const why = (err) => (err && /^[A-Z0-9_]+$/.test(String(err.code)) ? err.code : 'error');

async function psOut() {
  return (await exec('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 << 20, timeout: 10000 })).stdout;
}

// True while a claude process carries `${flag} ${id}`. Rejects when ps fails.
async function claudeRunning(flag, id) {
  return listed(await psOut(), flag, id);
}

const projectsRoot = () => path.join(os.homedir(), '.claude', 'projects');

// How Claude names a project folder: every character but a letter or digit becomes "-".
const folderName = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

// What marks a project folder as one this run made. `nonce` is the run's token
// stem (scratch folders are named verify-<nonce>-...); `slotPrefix` is a stack
// run's own directory (its world and Chief of Staff folders sit under it). A
// folder that matches neither is never removed, so the operator's own project
// folders (World-Acme-Corp, verify-cos) stay.
function runMarks(env) {
  const slotDir = env && env.stack && env.stack.scratchDir ? path.dirname(env.stack.scratchDir) : null;
  return { nonce: env && env.nonce ? String(env.nonce) : '', slotPrefix: slotDir ? `${folderName(slotDir)}-` : '' };
}

function runFolder(name, marks) {
  if (!marks) return false;
  if (marks.nonce && TOKEN.test(marks.nonce) && name.includes(`verify-${marks.nonce}-`)) return true;
  return !!marks.slotPrefix && name.startsWith(marks.slotPrefix);
}

// True when dir holds no file at all, however deep: Claude leaves an empty
// memory/ folder behind, which does not count. A symlink counts as a file.
async function holdsNoFile(dir) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return false;
    if (!(await holdsNoFile(path.join(dir, entry.name)))) return false;
  }
  return true;
}

// Removes each named project folder that this run made and that holds no file.
// Never throws: a folder that cannot be read or removed stays.
async function removeEmptyRunFolders(root, names, marks) {
  for (const name of new Set(names)) {
    if (!runFolder(name, marks)) continue;
    const dir = path.join(root, name);
    try {
      if (!(await fs.promises.lstat(dir)).isDirectory() || !(await holdsNoFile(dir))) continue;
      await fs.promises.rm(dir, { recursive: true });
    } catch { /* stays */ }
  }
}

// Deletes each ~/.claude/projects/*/<id>.jsonl once every one of them holds
// token, so a file the run did not write is never touched. Then removes the
// project folders the run made that this left empty. Returns the log text
// after the id.
async function removeFiles(id, token, marks) {
  const root = projectsRoot();
  let dirs;
  try { dirs = await fs.promises.readdir(root); } catch (err) { return err.code === 'ENOENT' ? 'absent' : `kept: ${why(err)}`; }
  const files = [];
  for (const dir of dirs) {
    const file = path.join(root, dir, `${id}.jsonl`);
    try { await fs.promises.access(file); } catch { continue; }
    files.push(file);
  }
  for (const file of files) {
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch (err) { return `kept: ${why(err)}`; }
    if (!text.includes(token)) return 'kept: no run token';
  }
  let deleted = 0;
  for (const file of files) {
    try { await fs.promises.unlink(file); } catch (err) {
      return deleted ? `kept: ${why(err)} after deleting ${deleted}` : `kept: ${why(err)}`;
    }
    deleted++;
  }
  await removeEmptyRunFolders(root, files.map((f) => path.basename(path.dirname(f))), marks);
  return deleted ? `deleted ${deleted}` : 'absent';
}

// Polls until running() is false, then deletes the conversation's files. Writes
// the one log line. `running` is async and answers true while the Claude lives.
// `marks` (runMarks) lets it remove the project folder the file leaves empty.
async function removeTranscript({ journey, id, token, running, marks }) {
  const line = (rest) => {
    try { process.stderr.write(`transcript ${journey}: ${rest}\n`); } catch { /* the log is best effort */ }
  };
  try {
    if (!UUID.test(String(id))) return line('id unknown: not a conversation id');
    if (!TOKEN.test(String(token))) return line(`${id} kept: bad token`);
    let ps = 'process still running';
    const gone = await poll(async () => {
      try { return !(await running()); } catch (err) { ps = `ps failed: ${why(err)}`; return null; }
    }, { timeoutMs: EXIT_WITHIN_MS, intervalMs: 500 });
    if (!gone) return line(`${id} kept: ${ps}`);
    line(`${id} ${await removeFiles(id, token, marks)}`);
  } catch (err) {
    line(`${id} kept: ${why(err)}`);
  }
}

// The ids among `ids` that a claude process in the ps listing carries in its argv.
function runningIds(psText, ids) {
  const live = new Set();
  for (const line of String(psText).split('\n')) {
    const m = /^\s*\d+\s+\d+\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[1];
    if (path.basename(command.split(' --')[0].trim().split(' ')[0]) !== 'claude') continue;
    for (const id of ids) if (command.includes(id)) live.add(id);
  }
  return live;
}

// What the sweep already logged, so a Claude that stays up across journeys is
// reported once, not once per journey.
const logged = new Map();

// Deletes every session file this run wrote, whichever journey or probe started
// it: a file under ~/.claude/projects, changed since sinceMs, that holds the
// run token (verify-<nonce>). A file without it is never deleted, and a file whose Claude still runs
// stays (logged once). Then removes the project folders the run made that are
// now empty. Never throws; one stderr line per session.
async function sweepTranscripts({ journey, nonce, marks, sinceMs, only = null, ps = psOut }) {
  const waiting = [];
  const line = (id, rest) => {
    if (logged.get(id) === rest) return;
    logged.set(id, rest);
    try { process.stderr.write(`transcript ${journey}: ${id} ${rest}\n`); } catch { /* the log is best effort */ }
  };
  try {
    if (!TOKEN.test(String(nonce))) return;
    // A prompt names the run as verify-<nonce> or, in a sentence, "verify <nonce>".
    const tokens = [`verify-${nonce}`, `verify ${nonce}`];
    const root = projectsRoot();
    let dirs;
    try { dirs = await fs.promises.readdir(root); } catch { return; }
    const found = [];
    for (const dir of dirs) {
      let names;
      try { names = await fs.promises.readdir(path.join(root, dir)); } catch { continue; }
      for (const name of names) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
        if (!UUID.test(id) || (only && !only.includes(id))) continue;
        const file = path.join(root, dir, name);
        try {
          if ((await fs.promises.stat(file)).mtimeMs < sinceMs) continue;
          const text = await fs.promises.readFile(file, 'utf8');
          if (tokens.some((t) => text.includes(t))) found.push({ id, file });
        } catch { /* gone or unreadable: not ours to judge */ }
      }
    }
    let live = new Set();
    let psFailed = '';
    if (found.length) {
      try { live = runningIds(await ps(), found.map((f) => f.id)); } catch (err) { psFailed = `ps failed: ${why(err)}`; }
    }
    for (const { id, file } of found) {
      if (psFailed) { line(id, `kept: ${psFailed}`); continue; }
      if (live.has(id)) { waiting.push(id); line(id, 'kept: process still running'); continue; }
      try { await fs.promises.unlink(file); line(id, 'deleted 1'); } catch (err) {
        if (err && err.code !== 'ENOENT') line(id, `kept: ${why(err)}`);
      }
    }
    await removeEmptyRunFolders(root, dirs.filter((d) => runFolder(d, marks)), marks);
  } catch (err) {
    try { process.stderr.write(`transcript ${journey}: sweep kept: ${why(err)}\n`); } catch { /* best effort */ }
  }
  return waiting;
}

const REAP_EVERY_MS = 2000;
const REAP_FOR_MS = 30 * 60 * 1000;

// Runs in the detached process below. Sweeps only `ids`, the sessions a sweep
// had to leave, until none waits on a living Claude or the bound passes. Other
// files are not its business: a Claude without --session-id in its argv would
// look gone while a journey still reads its file. Returns how many still wait.
async function reap({ ids, nonce, marks, sinceMs, everyMs = REAP_EVERY_MS, forMs = REAP_FOR_MS, ps = psOut }) {
  const until = Date.now() + forMs;
  for (;;) {
    const waiting = await sweepTranscripts({ journey: 'after-run', nonce, marks, sinceMs, only: ids, ps });
    if (!waiting.length || Date.now() >= until) return waiting.length;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

// The Chief of Staff's Claude lives until the stack goes down, after the last
// journey: its session file cannot go while it runs. A detached process, with
// no stdio so no caller waits on it, deletes that file the moment the Claude is
// gone. Each id is handed over once.
const handedOver = new Set();
function reapAfterRun(ids, args) {
  const fresh = ids.filter((id) => !handedOver.has(id));
  if (!fresh.length) return false;
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [__filename, '--reap', JSON.stringify({ ...args, ids: fresh })], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    fresh.forEach((id) => handedOver.add(id));
    return true;
  } catch { return false; }
}

if (require.main === module && process.argv[2] === '--reap') {
  reap(JSON.parse(process.argv[3])).then(() => process.exit(0), () => process.exit(1));
}

// Wraps a journey so that, after the journey's own cleanups (this one is
// registered last, so it runs last), every session file the run wrote is swept.
// A fixture starts no Claude and is left alone.
function withTranscriptSweep(journey, startedAtMs) {
  if (journey.fixture) return journey;
  return {
    ...journey,
    run: async (env) => {
      try {
        return await journey.run(env);
      } finally {
        env.cleanup(`${journey.id}: sweep the run's Claude session files`, async () => {
          const args = { nonce: env.nonce, marks: runMarks(env), sinceMs: startedAtMs };
          reapAfterRun(await sweepTranscripts({ journey: journey.id, ...args }), args);
        }, TRANSCRIPT_CLEANUP_MS);
      }
    },
  };
}

module.exports = { claudeRunning, removeTranscript, sweepTranscripts, reap, withTranscriptSweep, runMarks, runningIds, TRANSCRIPT_CLEANUP_MS };
