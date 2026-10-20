/**
 * RovingFocus: one Tab stop per control, arrow keys inside it (WAI-ARIA
 * roving tabindex). Stops are non-button elements with an explicit tabindex,
 * because Safari skips buttons on Tab unless the user turned that on; row
 * buttons are reached by a key inside the control (Right, in a vertical one)
 * and carry tabindex -1.
 *
 * Usage: `capture()` before the container is cleared, `refresh(snap)` after
 * it is rebuilt. A render never pulls focus from outside the container.
 */
class RovingFocus {
  /**
   * Last input type on the page, shared by every instance. :focus-visible cannot answer
   * "did focus come from the keyboard": a script refocus after a click re-render is
   * marked focus-visible by Chromium once the clicked element was removed.
   */
  static _modalityTracked = false;
  static _lastInputKeyboard = false;
  static _trackModality() {
    if (RovingFocus._modalityTracked || typeof document === 'undefined') return;
    RovingFocus._modalityTracked = true;
    document.addEventListener('keydown', () => { RovingFocus._lastInputKeyboard = true; }, true);
    document.addEventListener('pointerdown', () => { RovingFocus._lastInputKeyboard = false; }, true);
  }

  /**
   * @param {HTMLElement} root container; persists across renders.
   * @param {object} opts
   * @param {string} opts.items selector of the stops, in DOM order; each carries data-roving-key.
   * @param {'horizontal'|'vertical'} [opts.orientation]
   * @param {boolean} [opts.wrap] past the last goes to the first.
   * @param {string} [opts.row] selector of a stop's row (vertical with row buttons).
   * @param {string} [opts.rowButtons] selector, inside the row; reached with Right.
   * @param {() => (string|null)} [opts.preferredKey]
   * @param {(event: KeyboardEvent, el: HTMLElement) => boolean} [opts.onKey] runs first; true = handled.
   * @param {() => void} [opts.onEmpty] refresh() calls it when focus was inside and no stop remains.
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = { orientation: 'vertical', wrap: false, ...opts };
    this._lastKey = null;
    this._focusByKeyboard = false;
    RovingFocus._trackModality();
    this._onKeydown = (e) => this._handleKeydown(e);
    this._onFocusin = (e) => this._handleFocusin(e);
    root.addEventListener('keydown', this._onKeydown);
    root.addEventListener('focusin', this._onFocusin);
  }

  /** True when focus is inside the root and arrived by a key, not a click (or a refocus after one). */
  focusIsFromKeyboard() {
    const el = document.activeElement;
    return !!(el && this.root.contains(el) && this._focusByKeyboard);
  }

  _stops() {
    return [...this.root.querySelectorAll(this.opts.items)];
  }

  _rowOf(el) {
    return this.opts.row ? el.closest(this.opts.row) : null;
  }

  _rowButtonsOf(stop) {
    const row = this._rowOf(stop);
    return row && this.opts.rowButtons ? [...row.querySelectorAll(this.opts.rowButtons)] : [];
  }

  /** The stop that owns `el`: itself, an ancestor stop, or the stop in the row of a row button. */
  _stopOf(el) {
    if (!el || !this.root.contains(el)) return null;
    const own = el.closest(this.opts.items);
    if (own && this.root.contains(own)) return own;
    if (this.opts.rowButtons && el.closest(this.opts.rowButtons)) {
      const row = this._rowOf(el);
      if (row) return row.querySelector(this.opts.items);
    }
    return null;
  }

  capture() {
    const active = document.activeElement;
    const stop = this._stopOf(active);
    if (!stop) return { key: null, index: -1, sub: -1, hadFocus: false };
    const sub = stop === active ? -1 : this._rowButtonsOf(stop).findIndex((b) => b === active || b.contains(active));
    return { key: stop.dataset.rovingKey ?? null, index: this._stops().indexOf(stop), sub, hadFocus: true };
  }

  refresh(snap) {
    const stops = this._stops();
    const byKey = (key) => (key == null ? null : stops.find((s) => s.dataset.rovingKey === key) || null);
    const hadFocus = !!snap?.hadFocus;

    if (!stops.length) {
      if (hadFocus && this.opts.onEmpty) this.opts.onEmpty();
      return;
    }

    const preferred = () => byKey(this.opts.preferredKey ? this.opts.preferredKey() : null);
    let chosen = null;
    let sameKey = false;
    if (hadFocus) {
      chosen = byKey(snap.key);
      sameKey = !!chosen;
      if (!chosen) chosen = preferred();
      if (!chosen && snap.index >= 0) chosen = stops[Math.min(snap.index, stops.length - 1)];
    } else {
      chosen = preferred() || byKey(this._lastKey);
    }
    if (!chosen) chosen = stops[0];

    this._setStop(chosen, stops);
    if (this.opts.rowButtons) {
      this.root.querySelectorAll(this.opts.rowButtons).forEach((b) => b.setAttribute('tabindex', '-1'));
    }

    if (hadFocus) {
      const buttons = sameKey && snap.sub >= 0 ? this._rowButtonsOf(chosen) : [];
      (buttons[snap.sub] || chosen).focus({ preventScroll: true });
    }
  }

  _setStop(el, stops = this._stops()) {
    for (const s of stops) s.setAttribute('tabindex', s === el ? '0' : '-1');
  }

  focusItem(el) {
    this._setStop(el);
    el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _handleFocusin(e) {
    this._focusByKeyboard = RovingFocus._lastInputKeyboard;
    const stop = this._stopOf(e.target);
    if (!stop) return;
    this._lastKey = stop.dataset.rovingKey ?? null;
    if (stop.getAttribute('tabindex') !== '0') this._setStop(stop);
  }

  _handleKeydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Tab') return;
    const target = e.target;
    const stop = this._stopOf(target);
    if (!stop) return;
    const onButton = target !== stop && !!this.opts.rowButtons && !!target.closest(this.opts.rowButtons);

    if (this.opts.onKey && !onButton && this.opts.onKey(e, stop)) {
      e.preventDefault();
      return;
    }

    const vertical = this.opts.orientation === 'vertical';
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
    const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
    const stops = this._stops();
    const idx = stops.indexOf(stop);
    const goto = (i) => {
      if (this.opts.wrap) i = (i + stops.length) % stops.length;
      else i = Math.max(0, Math.min(stops.length - 1, i));
      if (stops[i]) this.focusItem(stops[i]);
    };

    // Row buttons: Right/Left walk them, Up/Down return to the stops.
    const buttons = vertical ? this._rowButtonsOf(stop) : [];
    if (buttons.length) {
      const at = onButton ? buttons.findIndex((b) => b === target || b.contains(target)) : -1;
      if (e.key === 'ArrowRight') {
        if (at < buttons.length - 1) buttons[at + 1].focus();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowLeft' && onButton) {
        if (at > 0) buttons[at - 1].focus();
        else this.focusItem(stop);
        e.preventDefault();
        return;
      }
    }

    if (e.key === nextKey) goto(idx + 1);
    else if (e.key === prevKey) goto(idx - 1);
    else if (e.key === 'Home') goto(0);
    else if (e.key === 'End') goto(stops.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      // A native control already clicks itself on Enter/Space.
      if (!target.matches('button, a[href], input')) target.click();
      else return;
    } else return;
    e.preventDefault();
  }

  destroy() {
    this.root.removeEventListener('keydown', this._onKeydown);
    this.root.removeEventListener('focusin', this._onFocusin);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = RovingFocus;
