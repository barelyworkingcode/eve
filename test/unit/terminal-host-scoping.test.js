// Terminal-to-project association keys on (hostId, directory), not directory
// alone (../relay/docs/ssh-hosts.md) — two hosts (or a host and the console)
// can share a directory string, and a console project must not pick up a
// host terminal that merely happens to share its path text.
const TerminalManager = require('../../public/terminal-manager');

function entry({ directory, host = null, state = 'running' }) {
  return { directory, host, state };
}

function ctx(entries) {
  return { allTerminals: new Map(entries.map((e, i) => [`t${i}`, e])), terminals: new Map() };
}

describe('TerminalManager.getTerminalsForPath (hostId, directory)', () => {
  const getTerminalsForPath = TerminalManager.prototype.getTerminalsForPath;

  it('defaults to hostId "" (console) and matches only console terminals', () => {
    const self = ctx([
      entry({ directory: '/work/proj/sub' }),
      entry({ directory: '/work/proj/other', host: { id: 'h1', name: 'devbox' } }),
    ]);
    const result = getTerminalsForPath.call(self, '/work/proj');
    expect(result).toHaveLength(1);
    expect(result[0].directory).toBe('/work/proj/sub');
  });

  it('matches only terminals on the requested host, ignoring a console terminal at the same path', () => {
    const self = ctx([
      entry({ directory: '/work/proj/sub' }), // console
      entry({ directory: '/work/proj/sub', host: { id: 'h1', name: 'devbox' } }),
      entry({ directory: '/work/proj/sub', host: { id: 'h2', name: 'other-box' } }),
    ]);
    const result = getTerminalsForPath.call(self, '/work/proj', 'h1');
    expect(result).toHaveLength(1);
    expect(result[0].host).toEqual({ id: 'h1', name: 'devbox' });
  });

  it('is case-insensitive on the directory match (macOS)', () => {
    const self = ctx([entry({ directory: '/Work/Proj/Sub' })]);
    const result = getTerminalsForPath.call(self, '/work/proj');
    expect(result).toHaveLength(1);
  });

  it('returns [] for an empty projectPath', () => {
    const self = ctx([entry({ directory: '/work/proj' })]);
    expect(getTerminalsForPath.call(self, '')).toEqual([]);
  });
});

describe('TerminalManager.getDetachedCountForPath (hostId, directory)', () => {
  const getDetachedCountForPath = TerminalManager.prototype.getDetachedCountForPath;

  it('counts only running, un-attached terminals on the matching host', () => {
    const self = ctx([
      entry({ directory: '/work/proj/a' }),                                     // console, detached
      entry({ directory: '/work/proj/b', host: { id: 'h1', name: 'devbox' } }), // host h1, detached
      entry({ directory: '/work/proj/c', host: { id: 'h1', name: 'devbox' }, state: 'stopped' }), // stopped: excluded
    ]);
    expect(getDetachedCountForPath.call(self, '/work/proj')).toBe(1); // console only
    expect(getDetachedCountForPath.call(self, '/work/proj', 'h1')).toBe(1); // host h1 only
    expect(getDetachedCountForPath.call(self, '/work/proj', 'h2')).toBe(0); // no h2 terminals
  });

  it('excludes a terminal that is currently attached (present in this.terminals)', () => {
    const self = ctx([entry({ directory: '/work/proj/a', host: { id: 'h1', name: 'devbox' } })]);
    self.terminals.set('t0', {});
    expect(getDetachedCountForPath.call(self, '/work/proj', 'h1')).toBe(0);
  });
});
