const FileWatcher = require('../../file-watcher');
const { shouldWatchDir, watchBackend } = FileWatcher;

describe('shouldWatchDir', () => {
  it.each([
    ['src', true],
    ['src/deep/er', true],
    ['node_modules', false],
    ['src/node_modules/pkg', false],
    ['.git', true],
    ['.git/objects', false],
    ['.git/refs/heads', false],
    ['.git/worktrees', true],
    ['.git/worktrees/feat', true],
    ['.git/worktrees/feat/logs', false],
    ['feat-login/.git', true],
    ['feat-login/.git/objects', false],
    ['node_modules/pkg/.git', false],
  ])('%s -> %s', (rel, expected) => {
    expect(shouldWatchDir(rel)).toBe(expected);
  });
});

describe('watchBackend', () => {
  it.each([
    [{}, 'linux', 'pruned'],
    [{}, 'darwin', 'native'],
    [{}, 'win32', 'native'],
    [{ EVE_WATCH_BACKEND: 'native' }, 'linux', 'native'],
    [{ EVE_WATCH_BACKEND: 'pruned' }, 'darwin', 'pruned'],
    [{ EVE_WATCH_BACKEND: 'bogus' }, 'linux', 'pruned'],
  ])('%j on %s -> %s', (env, platform, expected) => {
    expect(watchBackend(env, platform)).toBe(expected);
  });
});
