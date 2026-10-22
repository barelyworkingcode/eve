'use strict';

// The env and settings for the harness's "outside" Claude CLI processes in a stack run.
// A stack run must not use the host's Claude login (parallel stacks would race on its
// refresh token), so the outside claude gets the stack's Europa wiring, as the claude
// sessions relay starts already do. Without a broker in the stack file, nothing changes.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code reads this file from the session folder; relay's CLAUDE_CODE_* scrub does not
// reach a process the harness starts. The header's per-session hash defeats Europa's prefix cache.
const SETTINGS_LOCAL = { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' } };

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

const brokerOf = (env) => {
  const s = env && env.stack;
  return s && s.claudeBaseUrl && s.claudeTokenFile && s.claudeModel
    ? { baseUrl: s.claudeBaseUrl, tokenFile: s.claudeTokenFile, model: s.claudeModel } : null;
};

function readToken(file, readFile = fs.readFileSync) {
  const token = String(readFile(file, 'utf8')).trim();
  if (!token) throw new Error(`the broker token file ${file} is empty`);
  return token;
}

// cleanEnv() plus the stack's broker wiring. The token is read now and lives in memory only.
function outsideClaudeEnv(env, { readFile } = {}) {
  const b = brokerOf(env);
  if (!b) return cleanEnv();
  return { ...cleanEnv(), ANTHROPIC_BASE_URL: b.baseUrl, ANTHROPIC_AUTH_TOKEN: readToken(b.tokenFile, readFile), ANTHROPIC_DEFAULT_HAIKU_MODEL: b.model };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// For a tmux command line: tmux argv is visible to every local user, so the token must not be in it.
// The shell reads the file at start-up instead. Returns '' when the run has no broker.
function shellPrefix(env) {
  const b = brokerOf(env);
  if (!b) return '';
  // Fail loudly, as the spawn path does, rather than start claude with an empty token.
  const guard = `[ -s ${quote(b.tokenFile)} ] || { echo ${quote(`the broker token file ${b.tokenFile} is empty or unreadable`)} >&2; exit 1; }; `;
  return `${guard}ANTHROPIC_BASE_URL=${quote(b.baseUrl)} ANTHROPIC_DEFAULT_HAIKU_MODEL=${quote(b.model)} ANTHROPIC_AUTH_TOKEN="$(cat ${quote(b.tokenFile)})" `;
}

// The same for the outside pi: where its agent dir and transcripts live, and the broker key it reads as PI_STACK_KEY.
// Returns '' when the stack names no pi_agent_dir. sessionDir keeps the transcript where relay's adopt discovery reads it.
function piShellPrefix(env, sessionDir) {
  const s = env && env.stack;
  if (!s || !s.piAgentDir) return '';
  if (!s.claudeTokenFile) return '';
  const guard = `[ -s ${quote(s.claudeTokenFile)} ] || { echo ${quote(`the broker token file ${s.claudeTokenFile} is empty or unreadable`)} >&2; exit 1; }; `;
  return `${guard}PI_CODING_AGENT_DIR=${quote(s.piAgentDir)} PI_CODING_AGENT_SESSION_DIR=${quote(sessionDir)} PI_STACK_KEY="$(cat ${quote(s.claudeTokenFile)})" `;
}

// Writes <dir>/.claude/settings.local.json for a stack run; a run without a broker writes nothing.
async function writeOutsideSettings(env, dir) {
  if (!brokerOf(env)) return null;
  const file = path.join(dir, '.claude', 'settings.local.json');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(SETTINGS_LOCAL) + '\n');
  return file;
}

// A `verify-<nonce>-<kind>-XXXXXX` folder outside every project of the run, for an outside Claude that relay lists in no
// project. Answers { dir } or { problem } when the folder lands inside a project (a missing precondition, for BLOCKED). A stack run keeps it beside its record (stack.scratchDir), any other run in the system temp dir. The path is
// resolved, so it matches the text relay reads from the process. Removed by cleanup whatever the verdict.
async function outsideScratchFolder(env, kind) {
  const root = env.stack ? env.stack.scratchDir : os.tmpdir();
  await fs.promises.mkdir(root, { recursive: true });
  const realRoot = await fs.promises.realpath(root);
  const prefix = `verify-${env.nonce}-${kind}-`;
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(realRoot, prefix)));
  const projects = Object.values((env.world && env.world.projects) || {}).filter((p) => p && p.path).map((p) => path.resolve(p.path));
  const holder = projects.find((p) => dir === p || dir.startsWith(p + path.sep));
  env.cleanup(`remove ${kind} folder`, async () => {
    if (path.dirname(dir) !== realRoot || !path.basename(dir).startsWith(prefix)) throw new Error(`refusing to remove "${dir}": not a ${kind} scratch folder`);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  if (holder) return { problem: `the scratch folder ${dir} lies inside the project folder ${holder}, so relay would list the Claude in that project` };
  return { dir };
}

module.exports = { outsideScratchFolder, cleanEnv, outsideClaudeEnv, shellPrefix, piShellPrefix, writeOutsideSettings, SETTINGS_LOCAL };
