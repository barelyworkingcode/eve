/**
 * PaneDnd — drag a tab toward an edge of the content area to dock it as a
 * second pane (split). Built on Pointer Events so mouse, trackpad, and touch
 * (iPad) share one path.
 *
 * Gesture: press a tab → drag past a threshold → a ghost follows the pointer
 * and a shaded overlay previews where the dragged tab will land. Releasing over
 * an outer edge band splits the active tab (left/right → side-by-side,
 * top/bottom → stacked); releasing in the inner region cancels. A plain tap
 * (no drag) falls through to the tab label's normal switch handler.
 *
 * The model lives in TabManager; this class only detects the gesture and calls
 * back: `tm._canSplit(draggedId)` for the blocked/allowed overlay state and
 * `tm.commitSplit(draggedId, edge)` to apply the drop.
 *
 * Listeners live on `document` so a fast drag that leaves the tab is still
 * tracked; the pointer is only captured once a drag begins (to suppress touch
 * scroll/gestures on iPad without breaking tap-to-switch).
 */
class PaneDnd {
  constructor(tabManager) {
    this.tm = tabManager;
    this.tabBar = tabManager.tabBar;
    this.contentArea = tabManager.contentArea;
    this.THRESHOLD = 8;

    this._reset();
    this._didDrag = false;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onCancel = this._onCancel.bind(this);

    this.tabBar.addEventListener('pointerdown', this._onDown);
    // Suppress the click that fires after a real drag so it doesn't also switch tabs.
    this.tabBar.addEventListener('click', (e) => {
      if (this._didDrag) { e.stopPropagation(); e.preventDefault(); this._didDrag = false; }
    }, true);
  }

  _reset() {
    this._tabId = null;
    this._tabEl = null;
    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this._dragging = false;
    this._zone = null;
    this._ghost = null;
    this._overlay = null;
    this._longPress = null;
  }

  _onDown(e) {
    if (this._tabId != null) return;                 // a press is already in flight
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const tabEl = e.target.closest('.tab');
    if (!tabEl || e.target.closest('.tab-close')) return;
    const tabId = tabEl.dataset.tabId;
    if (!tabId) return;

    this._tabId = tabId;
    this._tabEl = tabEl;
    this._pointerId = e.pointerId;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._dragging = false;

    document.addEventListener('pointermove', this._onMove);
    document.addEventListener('pointerup', this._onUp);
    document.addEventListener('pointercancel', this._onCancel);

    // Touch users can start a drag by holding still, without horizontal motion.
    this._longPress = setTimeout(() => {
      if (!this._dragging && this._tabId) this._beginDrag();
    }, 200);
  }

  _onMove(e) {
    if (e.pointerId !== this._pointerId) return;
    if (!this._dragging) {
      if (Math.hypot(e.clientX - this._startX, e.clientY - this._startY) < this.THRESHOLD) return;
      this._beginDrag();
    }
    this._moveGhost(e.clientX, e.clientY);
    this._updateZone(e.clientX, e.clientY);
  }

  _beginDrag() {
    clearTimeout(this._longPress);
    this._longPress = null;
    this._dragging = true;
    this._didDrag = true;
    // Capture now (not on pointerdown) so taps still produce a click, but a real
    // drag suppresses iPad scroll/gestures while it's in progress.
    try { this._tabEl?.setPointerCapture(this._pointerId); } catch { /* unsupported */ }

    const ghost = document.createElement('div');
    ghost.className = 'pane-drag-ghost';
    ghost.textContent = this._tabEl?.querySelector('.tab-label')?.textContent || 'Tab';
    document.body.appendChild(ghost);
    this._ghost = ghost;

    const overlay = document.createElement('div');
    overlay.className = 'pane-drop-overlay hidden';
    this.contentArea.appendChild(overlay);
    this._overlay = overlay;
  }

  _moveGhost(x, y) {
    if (!this._ghost) return;
    this._ghost.style.left = x + 'px';
    this._ghost.style.top = y + 'px';
  }

  _updateZone(x, y) {
    const rect = this.contentArea.getBoundingClientRect();
    const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const px = (x - rect.left) / rect.width;
    const py = (y - rect.top) / rect.height;

    let edge = null;
    if (inside && !(px > 0.2 && px < 0.8 && py > 0.2 && py < 0.8)) {
      const d = { left: px, right: 1 - px, top: py, bottom: 1 - py };
      edge = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
    }
    this._zone = edge;
    this._renderOverlay(edge);
  }

  _renderOverlay(edge) {
    const o = this._overlay;
    if (!o) return;
    if (!edge) { o.classList.add('hidden'); return; }

    o.classList.toggle('blocked', !this.tm._canSplit(this._tabId));
    o.classList.remove('hidden');

    // Overlay covers the half where the dragged tab (pane B) would land.
    const css = { left: '0', top: '0', width: '100%', height: '100%' };
    if (edge === 'left') { css.width = '50%'; }
    else if (edge === 'right') { css.left = '50%'; css.width = '50%'; }
    else if (edge === 'top') { css.height = '50%'; }
    else if (edge === 'bottom') { css.top = '50%'; css.height = '50%'; }
    Object.assign(o.style, css);
  }

  _onUp(e) {
    if (e.pointerId !== this._pointerId) return;
    const edge = this._zone;
    const tabId = this._tabId;
    const dragged = this._dragging;
    this._cleanup();
    if (dragged && edge && tabId) this.tm.commitSplit(tabId, edge);
    // Clear the drag flag after the synchronous click (if any) has been suppressed.
    setTimeout(() => { this._didDrag = false; }, 0);
  }

  _onCancel(e) {
    if (e.pointerId !== this._pointerId) return;
    this._cleanup();
  }

  _cleanup() {
    clearTimeout(this._longPress);
    document.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerup', this._onUp);
    document.removeEventListener('pointercancel', this._onCancel);
    if (this._tabEl) {
      try { this._tabEl.releasePointerCapture(this._pointerId); } catch { /* already released */ }
    }
    if (this._ghost?.parentNode) this._ghost.parentNode.removeChild(this._ghost);
    if (this._overlay?.parentNode) this._overlay.parentNode.removeChild(this._overlay);
    this._reset();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PaneDnd;
}
