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

// Deletes each ~/.claude/projects/*/<id>.jsonl once every one of them holds
// token, so a file the run did not write is never touched. Returns the log
// text after the id.
async function removeFiles(id, token) {
  const root = path.join(os.homedir(), '.claude', 'projects');
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
  return deleted ? `deleted ${deleted}` : 'absent';
}

// Polls until running() is false, then deletes the conversation's files. Writes
// the one log line. `running` is async and answers true while the Claude lives.
async function removeTranscript({ journey, id, token, running }) {
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
    line(`${id} ${await removeFiles(id, token)}`);
  } catch (err) {
    line(`${id} kept: ${why(err)}`);
  }
}

module.exports = { claudeRunning, removeTranscript, TRANSCRIPT_CLEANUP_MS };
