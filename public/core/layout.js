/**
 * Layout: which of wide / regular / compact the viewport is, whether the
 * pointer is coarse, and the compact navigation stack (Today -> one view).
 * Mirrors state onto <html> as data-layout and data-nav for scripts and
 * tests; CSS styles from media queries, never from data-layout.
 * Tabs stay in TabManager; navigating never closes one. Layout is the only
 * writer of tab history. Design: docs/design-today-s2.md.
 *
 * NAV_CHANGED source: 'app' means the view already changed (a navigate call);
 * 'history' means the URL moved first (browser or in-app Back, forward) and
 * the listener must show the matching view.
 */
class Layout {
  constructor({ bus, win = (typeof window !== 'undefined' ? window : null) } = {}) {
    this.bus = bus;
    this.win = win;
    this._depth = 0;
    this._tabId = null;
    this._owned = false; // this document pushed the depth-1 entry
    this._mqls = null;
    this._name = 'wide';
    this._started = false;
  }

  static classify(width) {
    if (width >= 1024) return 'wide';
    if (width >= 600) return 'regular';
    return 'compact';
  }

  get name() { return this._started ? this._name : this._measure(); }
  get coarse() { return !!this._mqls?.coarse.matches; }
  get depth() { return this._depth; }

  init() {
    if (this._started) return;
    const win = this.win;
    this._mqls = {};
    for (const [key, query] of Object.entries(Layout.QUERIES)) {
      this._mqls[key] = win.matchMedia(query);
    }
    this._name = this._measure();
    this._coarse = this.coarse;
    const state = win.history.state;
    if (state && state.eveNav === 1) {
      this._depth = 1;
      this._tabId = state.tabId ?? null;
    }
    this._started = true;
    this._apply();
    const onChange = () => this._onMediaChange();
    for (const mql of Object.values(this._mqls)) mql.addEventListener('change', onChange);
    win.addEventListener('popstate', (e) => this._onPopState(e));
  }

  _measure() {
    if (!this._mqls) return 'wide';
    if (this._mqls.compact.matches) return 'compact';
    return this._mqls.notWide.matches ? 'regular' : 'wide';
  }

  _apply() {
    const root = this.win.document?.documentElement;
    if (!root) return;
    root.dataset.layout = this._name;
    root.dataset.nav = this._depth === 1 ? 'pushed' : 'root';
  }

  _onMediaChange() {
    const name = this._measure();
    const coarse = this.coarse;
    if (name === this._name && coarse === this._coarse) return;
    const previous = this._name;
    this._name = name;
    this._coarse = coarse;
    this._apply();
    this.bus?.emit(EVT.LAYOUT_CHANGED, { name, previous, coarse });
  }

  _base() {
    const loc = this.win.location;
    return loc.pathname + loc.search;
  }

  _setDepth(depth, tabId, source) {
    const changed = depth !== this._depth || tabId !== this._tabId;
    this._depth = depth;
    this._tabId = tabId;
    this._apply();
    if (changed) this.bus?.emit(EVT.NAV_CHANGED, { depth, tabId, source });
  }

  /**
   * The view for `tabId` is now showing. `url` is its hash ('#session/x') or
   * a full path; null or '' means Today.
   */
  navigate(url, tabId = null) {
    const win = this.win;
    const hist = win.history;
    const target = url || this._base();
    const loc = win.location;
    const same = url
      ? (url.startsWith('#') ? loc.hash === url : loc.pathname + loc.search + loc.hash === url)
      : loc.hash === '';

    if (this.name !== 'compact') {
      if (!same) hist.replaceState(hist.state, '', target);
      this._setDepth(0, url ? tabId : null, 'app');
      return;
    }

    if (url) {
      if (this._depth === 0) {
        hist.pushState({ eveNav: 1, tabId }, '', target);
        this._owned = true;
      } else if (!same || tabId !== this._tabId) {
        hist.replaceState({ eveNav: 1, tabId }, '', target);
      }
      this._setDepth(1, tabId, 'app');
      return;
    }

    // Today, from a pushed view.
    if (this._depth === 1) {
      if (this._owned) {
        // popstate finishes the job and emits with source 'history'.
        this._owned = false;
        hist.back();
        return;
      }
      hist.replaceState({ eveNav: 0 }, '', target);
    } else if (!same) {
      hist.replaceState(hist.state, '', target);
    }
    this._setDepth(0, null, 'app');
  }

  /** In-app Back: from a pushed view to Today, through history when this document pushed it. */
  back() {
    if (this._depth !== 1) return;
    if (this._owned) {
      this._owned = false;
      this.win.history.back();
      return;
    }
    this.win.history.replaceState({ eveNav: 0 }, '', this._base());
    this._setDepth(0, null, 'history');
  }

  _onPopState(e) {
    if (this.name !== 'compact') return;
    const state = e.state;
    if (state && state.eveNav === 1) {
      this._owned = true;
      this._setDepth(1, state.tabId ?? null, 'history');
      return;
    }
    // Back at the Today entry: it may carry the hash of a deep link.
    if (this.win.location.hash) {
      this.win.history.replaceState(state, '', this._base());
    }
    this._setDepth(0, null, 'history');
  }
}

Layout.QUERIES = {
  notWide: '(max-width: 1023.98px)',
  compact: '(max-width: 599.98px)',
  coarse: '(pointer: coarse)',
};

if (typeof module !== 'undefined' && module.exports) module.exports = Layout;
