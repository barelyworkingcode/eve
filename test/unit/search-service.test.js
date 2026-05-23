// Mock child_process before requiring SearchService — the service reads
// spawn at module load and we want to capture every invocation.
// Jest hoists jest.mock() above all requires, so the factory can't close
// over outer-scope vars. Stash state on globalThis and require EventEmitter
// inside the factory.
globalThis.__spawnCalls = [];
globalThis.__nextSpawnHandler = null;

jest.mock('child_process', () => {
  const { EventEmitter } = require('events');
  return {
    spawn: (...args) => {
      globalThis.__spawnCalls.push(args);
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      if (globalThis.__nextSpawnHandler) globalThis.__nextSpawnHandler(proc);
      return proc;
    },
  };
});

jest.mock('@vscode/ripgrep', () => ({ rgPath: '/fake/rg' }));

const SearchService = require('../../search-service');
const spawnCalls = globalThis.__spawnCalls;

function emitMatchLine(proc, { file, lineNumber, lineText, submatches }) {
  const payload = {
    type: 'match',
    data: {
      path: { text: file },
      line_number: lineNumber,
      lines: { text: lineText + '\n' },
      submatches: submatches.map(s => ({ start: s.start, end: s.end, match: { text: lineText.slice(s.start, s.end) } })),
    },
  };
  proc.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n'));
}

describe('SearchService', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    globalThis.__nextSpawnHandler =null;
  });

  it('rejects empty query', async () => {
    const svc = new SearchService();
    await expect(svc.run('/proj', '')).rejects.toThrow('Search query is empty');
  });

  it('passes query after -- separator (literal mode by default)', async () => {
    const svc = new SearchService();
    globalThis.__nextSpawnHandler =(proc) => {
      setImmediate(() => {
        emitMatchLine(proc, { file: 'a.txt', lineNumber: 1, lineText: 'hello world', submatches: [{ start: 0, end: 5 }] });
        proc.emit('close', 0);
      });
    };
    const result = await svc.run('/proj', '-hello');
    const [bin, args, opts] = spawnCalls[0];
    expect(bin).toBe('/fake/rg');
    expect(args).toContain('--fixed-strings');
    // -- separator must come right before the query so leading '-' isn't a flag
    const dashIdx = args.lastIndexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    expect(args[dashIdx + 1]).toBe('-hello');
    expect(opts.cwd).toBe('/proj');
    expect(opts.shell).toBeUndefined();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({
      file: 'a.txt',
      lineNumber: 1,
      lineText: 'hello world',
      submatches: [{ start: 0, end: 5 }],
    });
  });

  it('omits --fixed-strings when regex enabled, includes --word-regexp on word', async () => {
    const svc = new SearchService();
    globalThis.__nextSpawnHandler =(proc) => setImmediate(() => proc.emit('close', 1));
    await svc.run('/proj', 'foo', { regex: true, word: true });
    const [, args] = spawnCalls[0];
    expect(args).not.toContain('--fixed-strings');
    expect(args).toContain('--word-regexp');
  });

  it('forwards validated globs as --glob args', async () => {
    const svc = new SearchService();
    globalThis.__nextSpawnHandler =(proc) => setImmediate(() => proc.emit('close', 1));
    await svc.run('/proj', 'foo', { globs: ['*.md', '!node_modules'] });
    const [, args] = spawnCalls[0];
    const globPositions = args
      .map((a, i) => (a === '--glob' ? args[i + 1] : null))
      .filter(Boolean);
    expect(globPositions).toEqual(['*.md', '!node_modules']);
  });

  it('rejects globs with parent-dir traversal', async () => {
    const svc = new SearchService();
    globalThis.__nextSpawnHandler =(proc) => setImmediate(() => proc.emit('close', 1));
    await expect(svc.run('/proj', 'foo', { globs: ['../secrets/*'] }))
      .rejects.toThrow(/Invalid glob/);
    expect(spawnCalls).toHaveLength(0);
  });

  it('treats exit code 1 (no matches) as success', async () => {
    const svc = new SearchService();
    globalThis.__nextSpawnHandler =(proc) => setImmediate(() => proc.emit('close', 1));
    const result = await svc.run('/proj', 'nothing');
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('truncates at the result cap and reports truncated=true', async () => {
    const svc = new SearchService();
    globalThis.__nextSpawnHandler =(proc) => {
      setImmediate(() => {
        // Emit 501 matches — service caps at 500 and kills the process
        for (let i = 1; i <= 501; i++) {
          emitMatchLine(proc, { file: 'a.txt', lineNumber: i, lineText: 'x', submatches: [{ start: 0, end: 1 }] });
        }
        // After the cap, the service triggers kill() — we still emit close to
        // resolve the promise (simulating proc death).
        proc.emit('close', null);
      });
    };
    const result = await svc.run('/proj', 'x');
    expect(result.matches.length).toBe(500);
    expect(result.truncated).toBe(true);
  });

  it('cancel() kills an in-flight search by requestId', async () => {
    const svc = new SearchService();
    let captured;
    globalThis.__nextSpawnHandler = (proc) => { captured = proc; };
    const pending = svc.run('/proj', 'foo', { requestId: 'req-1' });
    expect(captured).toBeDefined();
    const ok = svc.cancel('req-1');
    expect(ok).toBe(true);
    expect(captured.kill).toHaveBeenCalledWith('SIGTERM');
    // Resolve the still-pending promise by simulating the process close.
    captured.emit('close', null);
    await pending;
  });
});
