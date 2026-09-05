'use strict';

/**
 * The one Node implementation of relay's RemoteCommand derivation (decision 8
 * in ../relay/docs/ssh-hosts.md). A login shell may be sh, bash, zsh or fish;
 * restricting every remote command to base64 inside a single-quoted string
 * means the only characters any of them ever parses are [A-Za-z0-9+/=], which
 * every POSIX shell treats identically. Go has the same function
 * (`internal/sshhost`, vendored into relayLLM) — the three test suites share
 * the doc's Fixtures section so the implementations cannot drift apart.
 */

// Single-quote escape: close the quote, emit an escaped literal quote, reopen
// the quote. Applied to every argv element and to both sides of each K=V pair
// so nothing in a value (spaces, quotes, $, backticks) is ever shell-parsed.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Builds `cd '<cwd>' && exec env 'K'='v' … '<argv0>' '<arg1>' …` (the `cd` is
// omitted when cwd is falsy) and wraps it as the fixed launcher form so the
// remote login shell only ever sees base64.
function remoteCommand(cwd, argv, env) {
  const parts = [];
  if (cwd) parts.push(`cd ${shQuote(cwd)} &&`);

  const envParts = Object.entries(env || {}).map(([k, v]) => `${shQuote(k)}=${shQuote(v)}`);
  const argvParts = (argv || []).map(shQuote);
  parts.push('exec', 'env', ...envParts, ...argvParts);

  return wrapShLauncher(parts.join(' '));
}

function wrapShLauncher(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `sh -c 'eval "$(printf %s ${b64} | base64 -d)"'`;
}

// eve's own agent launches the same way (decision 8's last sentence) but as
// `node -e` rather than `sh -c`: the base64 payload only ever contains
// [A-Za-z0-9+/=], which is safe unescaped inside the double-quoted -e
// argument on every login shell, so no further wrapping is needed.
function nodeLauncher(scriptSource) {
  const b64 = Buffer.from(scriptSource, 'utf8').toString('base64');
  return `node -e "eval(Buffer.from('${b64}','base64').toString())"`;
}

module.exports = { remoteCommand, nodeLauncher, shQuote, wrapShLauncher };
