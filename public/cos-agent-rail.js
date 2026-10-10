// Chief of Staff agent rail (eve#274): every agent as a row to the right of the
// thread (wide), or a 44px strip that opens the same rows in a native <dialog>
// sheet (900px and narrower). On wide, a divider resizes the rail and folds it
// into the strip when dragged under FOLD_PX (eve#321). It is not a board: it hosts two AgentBoard mounts (prefix
// `rail` always, prefix `sheet` while the sheet is open) and the strip's counts.
// Row text is agent-derived and reaches the DOM through textContent only (the
// board does that); this file adds only fixed labels and numbers.
class CosAgentRail {
  static NARROW = '(max-width: 900px)';
  static CLOSE_DRAG_PX = 64;
  static FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  static STORE_KEY = 'eve-cos-rail';
  static DEFAULT_PX = 280;
  static MIN_PX = 220;
  static MAX_PX = 480;
  static FOLD_PX = 160;
  static THREAD_MIN_PX = 360;
  static KEY_STEP_PX = 16;
  static COUNT_KINDS = [
    { key: 'needs', cls: 'red', words: 'need you' },
    { key: 'working', cls: 'amber', words: 'working' },
    { key: 'idle', cls: 'green', words: 'idle' },
  ];

  // note: (sessionId) => CosRowNote|null, read at render time.
  constructor({ container, note }) {
    this.container = container;
    this.note = note;
    this.railEl = null;
    this.body = null;
    this.strip = null;
    this.board = null;
    this.sheetBoard = null;
    this.dialog = null;
    this.panel = null;
    this.sheetBody = null;
    this._sheetOpen = false;
    this._counts = null;
    this._mq = null;
    this.page = null;
    this.divider = null;
    this.width = CosAgentRail.DEFAULT_PX;
    this.folded = false;
    this._onMq = () => {
      if (!this.isNarrow() && this._sheetOpen) this.closeSheet({ returnFocus: false });
      if (this.isNarrow()) this.strip?.setAttribute('aria-expanded', 'false');
      else this._apply();
    };
  }

  isNarrow() {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(CosAgentRail.NARROW).matches;
  }

  // Pure: a dragged or typed rail width (px) on a page this wide -> what the rail does.
  static size(raw, pageWidth) {
    if (!Number.isFinite(raw)) return { width: CosAgentRail.DEFAULT_PX, folded: false };
    if (raw < CosAgentRail.FOLD_PX) return { width: null, folded: true };
    return { width: CosAgentRail.clampWidth(raw, pageWidth), folded: false };
  }

  static maxWidth(pageWidth) {
    const room = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth - CosAgentRail.THREAD_MIN_PX : Infinity;
    return Math.max(CosAgentRail.MIN_PX, Math.min(CosAgentRail.MAX_PX, room));
  }

  static clampWidth(w, pageWidth) {
    return Math.round(Math.max(CosAgentRail.MIN_PX, Math.min(CosAgentRail.maxWidth(pageWidth), w)));
  }

  // page: the .cos-page grid; divider: the separator between thread and rail (wide only).
  mount(railEl, stripHost, { page = null, divider = null } = {}) {
    this.railEl = railEl;
    railEl.textContent = '';
    const head = document.createElement('h3');
    head.className = 'cos-rail__head';
    head.textContent = 'AGENTS';
    this.body = document.createElement('div');
    this.body.className = 'cos-rail__body';
    this.body.dataset.testid = 'cos-agents-rail-body';
    railEl.append(head, this.body);
    this.board = this._board(this.body, 'rail', { onCounts: (c) => this._setCounts(c) });
    this.board.mount(this.body);
    this._buildStrip(stripHost);
    this.page = page;
    if (page && divider) this._mountDivider(divider);
    if (window.matchMedia) {
      this._mq = window.matchMedia(CosAgentRail.NARROW);
      this._mq.addEventListener?.('change', this._onMq);
    }
  }

  _board(el, prefix, extra) {
    return new AgentBoard({
      container: this.container,
      testidPrefix: prefix,
      showProject: false,
      filter: () => true,
      maxRows: Infinity,
      layout: 'rail',
      collapseDone: true,
      note: (id) => this.note(id),
      ...extra,
    });
  }

  render() {
    this.board?.render();
    this.sheetBoard?.render();
  }

  // ---- strip ----

  _buildStrip(host) {
    const strip = document.createElement('button');
    strip.type = 'button';
    strip.className = 'cos-strip';
    strip.dataset.testid = 'cos-agents-strip';
    strip.setAttribute('aria-haspopup', 'dialog');
    this._countEls = {};
    for (const { key, cls } of CosAgentRail.COUNT_KINDS) {
      const c = document.createElement('span');
      c.className = `cos-strip__count cos-strip__count--${cls}`;
      c.dataset.testid = `cos-agents-strip-${cls}`;
      c.hidden = true;
      const num = document.createElement('span');
      const sr = document.createElement('span');
      sr.className = 'cos-sr';
      c.append(num, sr);
      strip.appendChild(c);
      this._countEls[key] = { c, num, sr };
    }
    const label = document.createElement('span');
    label.className = 'cos-strip__label';
    label.textContent = 'Agents';
    const chev = document.createElement('span');
    chev.className = 'cos-strip__chevron';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '⌃';
    strip.append(label, chev);
    strip.addEventListener('click', () => {
      if (this.isNarrow()) this.openSheet();
      else this.unfold({ focus: true });
    });
    host.appendChild(strip);
    this.strip = strip;
    this._renderCounts();
  }

  // null: relay is unreachable or the list is loading, so no counts show.
  _setCounts(counts) {
    this._counts = counts;
    this._renderCounts();
  }

  _renderCounts() {
    if (!this._countEls) return;
    for (const { key, words } of CosAgentRail.COUNT_KINDS) {
      const n = this._counts ? this._counts[key] | 0 : 0;
      const { c, num, sr } = this._countEls[key];
      c.hidden = n === 0;
      num.textContent = String(n);
      sr.textContent = ` ${words}`;
    }
  }

  // ---- needs ----

  showNeeds() {
    if (this.isNarrow()) this.openSheet();
    else if (this.folded) this.unfold();
    const prefix = this.isNarrow() ? 'sheet' : 'rail';
    const root = this.isNarrow() ? this.sheetBody : this.body;
    const head = root?.querySelector(`[data-testid="${prefix}-agents-group-needs-head"]`);
    if (!head) return;
    head.scrollIntoView?.({ block: 'start' });
    head.focus?.({ preventScroll: true });
  }

  // ---- divider (wide) ----

  _load() {
    try {
      const v = JSON.parse(localStorage.getItem(CosAgentRail.STORE_KEY) || 'null');
      if (v && Number.isFinite(v.width)) this.width = CosAgentRail.clampWidth(v.width, Infinity);
      this.folded = !!v?.folded;
    } catch { /* storage blocked or bad JSON: defaults */ }
  }

  _save() {
    try {
      localStorage.setItem(CosAgentRail.STORE_KEY, JSON.stringify({ width: this.width, folded: this.folded }));
    } catch { /* storage blocked: the size lasts for this page only */ }
  }

  _pageWidth() {
    return this.page?.getBoundingClientRect().width || Infinity;
  }

  _apply() {
    if (!this.page) return;
    this.page.style.setProperty('--cos-rail-w', `${this.width}px`);
    if (this.folded) this.page.setAttribute('data-rail-folded', '');
    else this.page.removeAttribute('data-rail-folded');
    const d = this.divider;
    if (d) {
      d.setAttribute('aria-valuenow', String(this.folded ? 0 : this.width));
      d.setAttribute('aria-valuemax', String(CosAgentRail.maxWidth(this._pageWidth())));
      d.setAttribute('aria-valuetext', this.folded ? 'Agents folded' : `${this.width} pixels`);
      d.setAttribute('aria-expanded', String(!this.folded));
    }
    if (!this.isNarrow()) this.strip?.setAttribute('aria-expanded', String(!this.folded));
  }

  setWidth(raw, { save = true } = {}) {
    const next = CosAgentRail.size(raw, this._pageWidth());
    this.folded = next.folded;
    if (next.width !== null) this.width = next.width;
    this._apply();
    if (save) this._save();
  }

  fold() {
    this.folded = true;
    this._apply();
    this._save();
  }

  unfold({ focus = false } = {}) {
    this.folded = false;
    this.width = CosAgentRail.clampWidth(this.width, this._pageWidth());
    this._apply();
    this._save();
    if (focus) this.divider?.focus();
  }

  _mountDivider(d) {
    this.divider = d;
    d.setAttribute('role', 'separator');
    d.setAttribute('aria-orientation', 'vertical');
    d.setAttribute('aria-label', 'Resize agents');
    d.setAttribute('aria-valuemin', String(CosAgentRail.MIN_PX));
    d.tabIndex = 0;
    this._load();
    this._apply();

    let pointerId = null;
    let startWidth = this.width;
    d.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      pointerId = e.pointerId;
      startWidth = this.width;
      try { d.setPointerCapture(pointerId); } catch { /* synthetic pointer */ }
      d.classList.add('resizing');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
    d.addEventListener('pointermove', (e) => {
      if (pointerId === null || !this.page) return;
      // The rail is the page's right edge, so its width is the distance from the pointer to it.
      this.setWidth(this.page.getBoundingClientRect().right - e.clientX, { save: false });
    });
    const end = () => {
      if (pointerId === null) return;
      try { d.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
      d.classList.remove('resizing');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // A drag that folds passes through the minimum on its way; unfold at the width it started from.
      if (this.folded) this.width = startWidth;
      this._save();
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    d.addEventListener('dblclick', () => this.setWidth(CosAgentRail.DEFAULT_PX));
    d.addEventListener('keydown', (e) => {
      const step = CosAgentRail.KEY_STEP_PX;
      let next = null;
      // Left widens the rail (the divider moves left); keys never fold it, Enter does.
      if (e.key === 'ArrowLeft') next = this.folded ? this.width : this.width + step;
      else if (e.key === 'ArrowRight') next = this.folded ? null : Math.max(this.width - step, CosAgentRail.MIN_PX);
      else if (e.key === 'Home') next = CosAgentRail.MIN_PX;
      else if (e.key === 'End') next = CosAgentRail.MAX_PX;
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (this.folded) this.unfold(); else this.fold();
        return;
      } else return;
      e.preventDefault();
      if (next !== null) this.setWidth(next);
    });
  }

  // ---- sheet ----

  _buildSheet() {
    const dialog = document.createElement('dialog');
    dialog.className = 'cos-sheet';
    dialog.dataset.testid = 'cos-agents-sheet';
    dialog.setAttribute('aria-label', 'Agents');

    const panel = document.createElement('div');
    panel.className = 'cos-sheet__panel';
    const grab = document.createElement('div');
    grab.className = 'cos-sheet__grab';
    const handle = document.createElement('div');
    handle.className = 'cos-sheet__handle';
    handle.dataset.testid = 'cos-agents-sheet-handle';
    const head = document.createElement('div');
    head.className = 'cos-sheet__head';
    const title = document.createElement('h3');
    title.className = 'cos-sheet__title';
    title.textContent = 'AGENTS';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cos-sheet__close';
    close.dataset.testid = 'cos-agents-sheet-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeSheet());
    head.append(title, close);
    grab.append(handle, head);
    this._dragOn(grab, panel, close);

    const body = document.createElement('div');
    body.className = 'cos-sheet__body';
    panel.append(grab, body);
    dialog.appendChild(panel);

    // Backdrop: a click on the dialog itself, outside the panel's box.
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = panel.getBoundingClientRect();
      const outside = e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right;
      if (outside) this.closeSheet();
    });
    // Escape arrives as the native close event.
    dialog.addEventListener('close', () => this.closeSheet());
    dialog.addEventListener('keydown', (e) => this._trapTab(e));
    document.body.appendChild(dialog);
    this.dialog = dialog;
    this.panel = panel;
    this.sheetBody = body;
  }

  // Pointer drag (mouse or touch) on the handle or header: down 64px or more closes.
  _dragOn(grab, panel, close) {
    let startY = null;
    let dy = 0;
    const end = (e, commit) => {
      if (startY === null) return;
      startY = null;
      panel.style.transform = '';
      panel.style.transition = '';
      try { grab.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
      if (commit && dy >= CosAgentRail.CLOSE_DRAG_PX) this.closeSheet();
    };
    grab.addEventListener('pointerdown', (e) => {
      if (e.target === close || e.button > 0) return;
      startY = e.clientY;
      dy = 0;
      try { grab.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    });
    grab.addEventListener('pointermove', (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.clientY - startY);
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${dy}px)`;
    });
    grab.addEventListener('pointerup', (e) => end(e, true));
    grab.addEventListener('pointercancel', (e) => end(e, false));
  }

  _trapTab(e) {
    if (e.key !== 'Tab' || !this.dialog) return;
    const items = [...this.dialog.querySelectorAll(CosAgentRail.FOCUSABLE)].filter(el => !el.hidden && el.offsetParent !== null);
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !this.dialog.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !this.dialog.contains(active))) { e.preventDefault(); first.focus(); }
  }

  openSheet() {
    if (this._sheetOpen) return;
    if (!this.dialog) this._buildSheet();
    this._sheetOpen = true;
    this.dialog.showModal();
    this.sheetBoard = this._board(this.sheetBody, 'sheet', { onOpen: () => this.closeSheet({ returnFocus: false }) });
    this.sheetBoard.mount(this.sheetBody);
    this.dialog.querySelector('[data-testid="cos-agents-sheet-close"]')?.focus();
    this.strip?.setAttribute('aria-expanded', 'true');
  }

  closeSheet({ returnFocus = true } = {}) {
    if (!this._sheetOpen) return;
    this._sheetOpen = false;
    if (this.dialog.open) this.dialog.close();
    this.sheetBoard?.destroy();
    this.sheetBoard = null;
    if (this.sheetBody) this.sheetBody.textContent = '';
    if (this.panel) { this.panel.style.transform = ''; this.panel.style.transition = ''; }
    this.strip?.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.strip?.focus();
  }

  destroy() {
    this.closeSheet({ returnFocus: false });
    this._mq?.removeEventListener?.('change', this._onMq);
    this._mq = null;
    this.board?.destroy();
    this.board = null;
    this.dialog?.remove();
    this.dialog = null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CosAgentRail;
}
