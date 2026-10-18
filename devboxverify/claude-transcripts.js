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

// The project folders a stack run's own slot directory owns, as encoded names.
// Claude names a folder by turning every non-alphanumeric character of its cwd
// into "-", so the encoding is not injective: slot x1 and a slot x1-relay (or a
// path x1_relay) share a prefix. Two rules, both needed:
// 1. Only the directories a Claude runs in count: verify-cos (the Chief of
//    Staff) and each project directory under world. Not bin, relay, eve-data,
//    and not a folder named like a slot (x1-world-verify-cos).
// 2. A folder that also falls under another directory of the runs folder whose
//    encoded name is longer (a rival: slot x1-world, x1-verify-cos) is that
//    one's, never ours. slotRivals lists them.
// Together: a folder is ours only if it sits at or under one of those
// directories of this slot and under no longer-named sibling.
function slotOwnedPrefixes(slotDir) {
  if (!slotDir) return [];
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((k) => k.isDirectory()).map((k) => k.name); } catch { return []; } };
  const kids = dirs(slotDir);
  const cwds = [];
  if (kids.includes('verify-cos')) cwds.push(path.join(slotDir, 'verify-cos'));
  if (kids.includes('world')) for (const k of dirs(path.join(slotDir, 'world'))) cwds.push(path.join(slotDir, 'world', k));
  return cwds.map(folderName);
}

// Encoded names of the other directories beside slotDir that sit under its encoded name.
function slotRivals(slotDir) {
  if (!slotDir) return [];
  const parent = path.dirname(slotDir);
  const own = `${folderName(slotDir)}-`;
  let kids;
  try { kids = fs.readdirSync(parent, { withFileTypes: true }); } catch { return []; }
  return kids.filter((k) => k.isDirectory() && k.name !== path.basename(slotDir))
    .map((k) => folderName(path.join(parent, k.name))).filter((n) => n.startsWith(own));
}

const under = (name, p) => name === p || name.startsWith(`${p}-`);

function slotOwned(name, prefixes, rivals = []) {
  return !!prefixes && prefixes.some((p) => under(name, p)) && !rivals.some((r) => under(name, r));
}

function runFolder(name, marks) {
  if (!marks) return false;
  if (slotOwned(name, marks.slotOwn, marks.slotRivals)) return true;
  if (marks.nonce && TOKEN.test(marks.nonce) && name.includes(`verify-${marks.nonce}-`)) return true;
  return !!marks.slotPrefix && name.startsWith(marks.slotPrefix);
}

// Removes dir and the folders under it, bottom-up with rmdir, when none holds a
// file: Claude leaves an empty memory/ folder behind, which does not count. A
// symlink counts as a file. Deliberate: rmdir, not a recursive remove, so a
// file written between the check and the removal makes rmdir fail and stays.
async function removeEmptyTree(dir) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return false;
    if (!(await removeEmptyTree(path.join(dir, entry.name)))) return false;
  }
  await fs.promises.rmdir(dir);
  return true;
}

// Removes each named project folder that this run made and that holds no file.
// Never throws: a folder that cannot be read or removed stays.
async function removeEmptyRunFolders(root, names, marks) {
  for (const name of new Set(names)) {
    if (!runFolder(name, marks)) continue;
    const dir = path.join(root, name);
    try {
      if ((await fs.promises.lstat(dir)).isDirectory()) await removeEmptyTree(dir);
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

// Deletes every session file in the project folders the slot owns (marks.slotOwn),
// whatever it holds: those folders sit under the run's own directory, so the
// Chief of Staff's bootstrap prompt, which carries no run token, belongs to the
// run. A file whose Claude still runs stays and is returned as waiting. Then
// removes the folders this left empty. `only` limits it to those ids. Never throws.
async function sweepSlotSessions({ journey, marks, only = null, ps = psOut }) {
  const waiting = [];
  const line = (id, rest) => {
    if (logged.get(id) === rest) return;
    logged.set(id, rest);
    try { process.stderr.write(`transcript ${journey}: ${id} ${rest}\n`); } catch { /* the log is best effort */ }
  };
  try {
    const own = marks && marks.slotOwn;
    const rivals = (marks && marks.slotRivals) || [];
    if (!own || !own.length) return waiting;
    const root = projectsRoot();
    let dirs;
    try { dirs = (await fs.promises.readdir(root)).filter((d) => slotOwned(d, own, rivals)); } catch { return waiting; }
    const found = [];
    for (const dir of dirs) {
      let names;
      try { names = await fs.promises.readdir(path.join(root, dir)); } catch { continue; }
      for (const name of names) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
        if (UUID.test(id) && (!only || only.includes(id))) found.push({ id, file: path.join(root, dir, name) });
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
        if (err && err.code !== 'ENOENT') { line(id, `kept: ${why(err)}`); continue; }
      }
      // The session's own folder (subagents/, tool-results/) goes with it.
      const side = path.join(path.dirname(file), id);
      try { if ((await fs.promises.lstat(side)).isDirectory()) await fs.promises.rm(side, { recursive: true }); } catch { /* stays */ }
    }
    await removeEmptyRunFolders(root, dirs, { slotOwn: own, slotRivals: rivals });
  } catch (err) {
    try { process.stderr.write(`transcript ${journey}: slot sweep kept: ${why(err)}\n`); } catch { /* best effort */ }
  }
  return waiting;
}

const REAP_EVERY_MS = 2000;
const REAP_FOR_MS = 30 * 60 * 1000;

// Runs in the detached process below. Sweeps only `ids`, the sessions a sweep
// had to leave, until none waits on a living Claude or the bound passes. Other
// files are not its business: a Claude without --session-id in its argv would
// look gone while a journey still reads its file. Returns how many still wait.
async function reap({ ids, nonce, marks, sinceMs, slot = false, everyMs = REAP_EVERY_MS, forMs = REAP_FOR_MS, ps = psOut }) {
  const until = Date.now() + forMs;
  for (;;) {
    const waiting = slot
      ? await sweepSlotSessions({ journey: 'after-run', marks, only: ids, ps })
      : await sweepTranscripts({ journey: 'after-run', nonce, marks, sinceMs, only: ids, ps });
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

// The end of a stack run: sweeps the slot's own project folders (see
// sweepSlotSessions) and hands any session whose Claude still runs, the Chief
// of Staff's, to the detached reaper, which deletes it once that Claude exits.
// A solo --only run needs this: no journey of it puts the run token in that file.
// `stack` is the parsed --stack file. Deletes nothing unless the directory
// holding it is the slot's own run directory: named for the slot and holding the
// marker the stack file names, so a stack.json copied elsewhere cannot widen it.
async function sweepSlotAtRunEnd(env, stack) {
  if (!env || !env.stack || !env.stack.scratchDir || !stack) return;
  const slotDir = path.dirname(env.stack.scratchDir);
  const markerOk = typeof stack.marker === 'string' && path.normalize(stack.marker) === path.join(slotDir, 'marker.json') && fs.existsSync(stack.marker);
  if (!stack.slot || path.basename(slotDir) !== stack.slot || !markerOk) {
    try { process.stderr.write('transcript end-of-run: kept: the stack file is not in a slot run directory\n'); } catch { /* best effort */ }
    return;
  }
  const marks = { ...runMarks(env), slotOwn: slotOwnedPrefixes(slotDir), slotRivals: slotRivals(slotDir) };
  const waiting = await sweepSlotSessions({ journey: 'end-of-run', marks });
  reapAfterRun(waiting, { nonce: env.nonce, marks, sinceMs: 0, slot: true, logFile: reaperLog(env) });
}

// Where the detached reaper writes its lines, since it has no stdio: the run
// record folder of a stack run, else the nightly's run folder.
function reaperLog(env) {
  const dir = env && env.stack && env.stack.scratchDir
    ? env.stack.scratchDir
    : path.join(process.env.NIGHTLY_LOG_DIR || path.join(os.homedir(), 'Library', 'Logs', 'devboxverify'), 'runs');
  return path.join(dir, 'transcript-reaper.log');
}

if (require.main === module && process.argv[2] === '--reap') {
  const args = JSON.parse(process.argv[3]);
  if (args.logFile) {
    const write = (text) => { try { fs.mkdirSync(path.dirname(args.logFile), { recursive: true }); fs.appendFileSync(args.logFile, text); } catch { /* best effort */ } };
    process.stderr.write = (text) => { write(String(text)); return true; };
  }
  reap(args).then((left) => {
    if (left) process.stderr.write(`transcript after-run: ${left} kept: process still running when the reaper gave up\n`);
    process.exit(0);
  }, () => process.exit(1));
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
          const args = { nonce: env.nonce, marks: runMarks(env), sinceMs: startedAtMs, logFile: reaperLog(env) };
          reapAfterRun(await sweepTranscripts({ journey: journey.id, ...args }), args);
        }, TRANSCRIPT_CLEANUP_MS);
      }
    },
  };
}

module.exports = { claudeRunning, removeTranscript, sweepTranscripts, sweepSlotSessions, sweepSlotAtRunEnd, slotOwnedPrefixes, slotRivals, slotOwned, reapAfterRun, reap, withTranscriptSweep, runMarks, runningIds, TRANSCRIPT_CLEANUP_MS };
