/**
 * Regression: xterm v6 pauses its renderer via an IntersectionObserver and only
 * un-pauses when that observer fires an "intersecting" entry. Safari/WKWebView —
 * and Chrome after a long background/discard — don't reliably deliver that entry
 * when a tab returns to the foreground, so `_isPaused` stays true, every write
 * just marks the grid dirty (RenderService.refreshRows early-returns), and the
 * terminal accepts keystrokes but never repaints until reload. TerminalManager
 * drives the resume itself from visibility/focus events; these tests lock that
 * behaviour in without needing a DOM or a real xterm.
 */
const TerminalManager = require('../../public/terminal-manager');

/** Minimal stand-in for an xterm Terminal in its paused state. */
function fakeTerm({ paused = true, rows = 24 } = {}) {
  const calls = [];
  return {
    rows,
    _core: {
      _renderService: {
        _isPaused: paused,
        refreshRows: (start, end, redraw) => calls.push([start, end, redraw]),
      },
    },
    _refreshCalls: calls,
  };
}

describe('TerminalManager._resumeRenderer', () => {
  const resume = TerminalManager.prototype._resumeRenderer;

  it('clears the stuck pause flag and forces a full-grid repaint', () => {
    const term = fakeTerm({ paused: true, rows: 40 });
    resume.call(null, term);
    expect(term._core._renderService._isPaused).toBe(false);
    expect(term._refreshCalls).toEqual([[0, 39, undefined]]);
  });

  it('repaints even when not paused (recovers a dropped partial paint)', () => {
    const term = fakeTerm({ paused: false, rows: 10 });
    resume.call(null, term);
    expect(term._refreshCalls).toEqual([[0, 9, undefined]]);
  });

  it('no-ops without throwing when the xterm internals are absent', () => {
    // Guards a future xterm upgrade that renames/relocates the render service.
    expect(() => resume.call(null, null)).not.toThrow();
    expect(() => resume.call(null, {})).not.toThrow();
    expect(() => resume.call(null, { _core: {} })).not.toThrow();
    expect(() => resume.call(null, { _core: { _renderService: {} } })).not.toThrow();
  });
});

describe('TerminalManager._forceResumeActive', () => {
  const forceResume = TerminalManager.prototype._forceResumeActive;

  // The fit() is deferred to requestAnimationFrame so it measures a settled
  // viewport; run scheduled frames synchronously for the assertions.
  beforeEach(() => { global.requestAnimationFrame = (cb) => cb(); });
  afterEach(() => { delete global.requestAnimationFrame; });

  function ctx({ activeId = 't1', entry } = {}) {
    const terminals = new Map();
    if (entry) terminals.set('t1', entry);
    return {
      terminals,
      activeTerminalId: activeId,
      _resumeRenderer: jest.fn(),
    };
  }

  it('repaints immediately, then re-fits the visible terminal', () => {
    const term = fakeTerm();
    const fit = jest.fn();
    const self = ctx({ entry: { term, fitAddon: { fit } } });
    forceResume.call(self);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(self._resumeRenderer).toHaveBeenCalledWith(term);
    // The synchronous repaint precedes the deferred fit — a stuck-paused
    // renderer catches up without waiting for layout.
    expect(self._resumeRenderer.mock.invocationCallOrder[0])
      .toBeLessThan(fit.mock.invocationCallOrder[0]);
  });

  it('skips the deferred fit if the user switched terminals before the frame', () => {
    const term = fakeTerm();
    const fit = jest.fn();
    global.requestAnimationFrame = (cb) => { self.activeTerminalId = 'other'; cb(); };
    const self = ctx({ entry: { term, fitAddon: { fit } } });
    forceResume.call(self);
    expect(self._resumeRenderer).toHaveBeenCalledTimes(1); // the immediate one only
    expect(fit).not.toHaveBeenCalled();
  });

  it('no-ops when no terminal is visible', () => {
    const self = ctx({ activeId: null });
    expect(() => forceResume.call(self)).not.toThrow();
    expect(self._resumeRenderer).not.toHaveBeenCalled();
  });

  it('still repaints when fit() throws before layout', () => {
    const term = fakeTerm();
    const fit = jest.fn(() => { throw new Error('no dimensions'); });
    const self = ctx({ entry: { term, fitAddon: { fit } } });
    expect(() => forceResume.call(self)).not.toThrow();
    expect(self._resumeRenderer).toHaveBeenCalledWith(term);
  });
});
