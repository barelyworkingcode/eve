// Fixtures pinned byte-for-byte from ../relay/docs/ssh-hosts.md's *Fixtures*
// section — shared with relay's internal/sshhost Go tests and relayLLM's
// vendored copy so the three implementations of RemoteCommand cannot drift.
const { remoteCommand, nodeLauncher, shQuote } = require('../../ssh-command');

function decodedScriptOf(launcher) {
  const m = launcher.match(/^sh -c 'eval "\$\(printf %s (\S+) \| base64 -d\)"'$/);
  expect(m).not.toBeNull();
  return Buffer.from(m[1], 'base64').toString('utf8');
}

describe('ssh-command remoteCommand (RemoteCommand fixtures)', () => {
  it('fixture 1: quotes cwd and argv, escaping an embedded apostrophe, with no env vars', () => {
    const launcher = remoteCommand('/home/a b', ['/usr/bin/claude', '--print', "it's"], {});
    expect(decodedScriptOf(launcher)).toBe(
      `cd '/home/a b' && exec env '/usr/bin/claude' '--print' 'it'\\''s'`
    );
  });

  it('fixture 2: omits the cd when cwd is empty, and quotes an env K=V pair', () => {
    const launcher = remoteCommand('', ['cat', '/x/y.jsonl'], { TERM: 'xterm-256color' });
    expect(decodedScriptOf(launcher)).toBe(
      `exec env 'TERM'='xterm-256color' 'cat' '/x/y.jsonl'`
    );
  });

  it('wraps every launcher in the exact fixed form with standard base64 and no line breaks', () => {
    const launcher = remoteCommand('/x', ['true'], {});
    expect(launcher.startsWith(`sh -c 'eval "$(printf %s `)).toBe(true);
    expect(launcher.endsWith(` | base64 -d)"'`)).toBe(true);
    expect(launcher).not.toContain('\n');
    const b64 = launcher.match(/printf %s (\S+) \|/)[1];
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/); // standard, padded alphabet only
  });

  it('is deterministic for identical input (byte-for-byte, not just semantically equal)', () => {
    const a = remoteCommand('/p', ['echo', 'hi'], { A: '1' });
    const b = remoteCommand('/p', ['echo', 'hi'], { A: '1' });
    expect(a).toBe(b);
  });
});

describe('ssh-command shQuote', () => {
  it('single-quotes a plain string', () => {
    expect(shQuote('hello')).toBe(`'hello'`);
  });

  it('escapes an embedded single quote with the close-escape-reopen idiom', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('never lets a value smuggle shell metacharacters unescaped', () => {
    const dangerous = `$(rm -rf /); echo pwned`;
    const quoted = shQuote(dangerous);
    // Everything outside the literal escape sequences stays inside single quotes.
    expect(quoted).toBe(`'${dangerous}'`);
  });
});

describe('ssh-command nodeLauncher', () => {
  it('produces the exact node -e / Buffer.from decode form', () => {
    const launcher = nodeLauncher('console.log(1)');
    const b64 = Buffer.from('console.log(1)', 'utf8').toString('base64');
    expect(launcher).toBe(`node -e "eval(Buffer.from('${b64}','base64').toString())"`);
  });

  it('round-trips arbitrary JS source through the base64 payload', () => {
    const source = "const x = 'a\\'b' + \"c\"; console.log(x);";
    const launcher = nodeLauncher(source);
    const b64 = launcher.match(/Buffer\.from\('([^']+)','base64'\)/)[1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(source);
  });

  it('uses only base64-alphabet characters inside the payload', () => {
    const launcher = nodeLauncher('/* anything */');
    const b64 = launcher.match(/Buffer\.from\('([^']+)','base64'\)/)[1];
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
