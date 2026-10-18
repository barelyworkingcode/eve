'use strict';

// The env and settings for the harness's "outside" Claude CLI processes in a stack run.
// A stack run must not use the host's Claude login (parallel stacks would race on its
// refresh token), so the outside claude gets the stack's Europa wiring, as the claude
// sessions relay starts already do. Without a broker in the stack file, nothing changes.

const fs = require('fs');
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
  return `ANTHROPIC_BASE_URL=${quote(b.baseUrl)} ANTHROPIC_DEFAULT_HAIKU_MODEL=${quote(b.model)} ANTHROPIC_AUTH_TOKEN="$(cat ${quote(b.tokenFile)})" `;
}

// Writes <dir>/.claude/settings.local.json for a stack run; a run without a broker writes nothing.
async function writeOutsideSettings(env, dir) {
  if (!brokerOf(env)) return null;
  const file = path.join(dir, '.claude', 'settings.local.json');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(SETTINGS_LOCAL) + '\n');
  return file;
}

module.exports = { cleanEnv, outsideClaudeEnv, shellPrefix, writeOutsideSettings, SETTINGS_LOCAL };
