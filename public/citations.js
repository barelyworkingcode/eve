/**
 * Citations: the sources row above a research answer, numbered chips for links
 * to those sources, and one popover that shows the excerpt the model read.
 * Source data is untrusted: every piece of it goes in through textContent, and
 * nothing here builds an img, iframe or script from it (monograms, no favicons).
 */
class Citations {
  constructor(messagesEl) {
    this.messagesEl = messagesEl;
    this.toolNames = new Map();
    this.resetTurn();
    this._row = null;
  }

  resetTurn() {
    this.turn = Sources.turn();
    this.toolNames = new Map();
    // The finished turn's row stays in the transcript; only the handle is dropped.
    this._row = null;
  }

  noteToolUse(id, name) {
    if (id) this.toolNames.set(id, name);
  }

  noteToolResult(id, content) {
    const name = this.toolNames.get(id);
    if (name) this.turn.add(name, content);
  }

  // Called with the finished assistant message's .message-content element.
  decorate(contentEl) {
    const sources = this.turn.list();
    if (!contentEl || !sources.length) return;
    const messageEl = contentEl.closest('.message') || contentEl;
    this._chipLinks(contentEl, sources);
    // One row per turn, kept above the latest text message.
    if (this._row) this._row.remove();
    this._row = this._buildRow(sources);
    messageEl.parentNode.insertBefore(this._row, messageEl);
  }

  _buildRow(sources) {
    const row = document.createElement('div');
    row.className = 'answer-sources';
    row.dataset.testid = 'answer-sources';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Sources');
    for (const s of sources) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `answer-source answer-source-${s.n}`;
      card.dataset.testid = `answer-source-${s.n}`;
      card.setAttribute('aria-label', `Source ${s.n}: ${Citations._host(s)}`);
      card.appendChild(Citations._span('cite-mono', Citations._mono(s)));
      card.appendChild(Citations._span('answer-source__host', Citations._host(s)));
      card.appendChild(Citations._span('answer-source__n', String(s.n)));
      card.addEventListener('click', () => this._toggle(card, s));
      row.appendChild(card);
    }
    return row;
  }

  _chipLinks(contentEl, sources) {
    const bySource = new Map(sources.map(s => [s.n, s]));
    for (const a of contentEl.querySelectorAll('a[href]')) {
      const n = this.turn.match(a.getAttribute('href'));
      const s = n && bySource.get(n);
      if (!s) continue;
      const text = a.textContent.trim();
      const dropText = !text || /^[\s\[\]\d]*$/.test(text) ||
        text === a.getAttribute('href').trim() || Sources.normalizeUrl(text) === s.key;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cite-chip';
      chip.dataset.testid = `cite-chip-${s.n}`;
      chip.setAttribute('aria-label', `Source ${s.n}: ${Citations._host(s)}`);
      chip.textContent = String(s.n);
      chip.addEventListener('click', () => this._toggle(chip, s));
      a.replaceWith(...(dropText ? [chip] : [document.createTextNode(text), chip]));
    }
  }

  static _host(s) { return s.host.replace(/^www\./i, ''); }
  static _mono(s) { return (Citations._host(s)[0] || '?').toUpperCase(); }
  static _span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // One popover per document.
  static _popover() {
    if (Citations._pop) return Citations._pop;
    const pop = document.createElement('div');
    pop.className = 'cite-popover';
    pop.dataset.testid = 'cite-popover';
    pop.setAttribute('role', 'dialog');
    pop.hidden = true;
    document.body.appendChild(pop);
    Citations._pop = pop;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); Citations._close(); }
    }, true);
    document.addEventListener('pointerdown', (e) => {
      if (pop.hidden || pop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.cite-chip, .answer-source')) return;
      const anchor = Citations._anchor;
      Citations._close(false);
      // The press's own default action moves focus to the target after this
      // handler (after pointerup on touch), so refocus once the click lands.
      if (anchor && anchor.isConnected) {
        const refocus = () => { clearTimeout(t); if (anchor.isConnected) anchor.focus(); };
        const t = setTimeout(() => document.removeEventListener('click', refocus, true), 1000);
        document.addEventListener('click', refocus, { capture: true, once: true });
      }
    }, true);
    const reposition = () => { if (!pop.hidden) Citations._place(pop, Citations._anchor); };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return pop;
  }

  static _close(restoreFocus = true) {
    const pop = Citations._pop;
    if (!pop || pop.hidden) return;
    const anchor = Citations._anchor;
    pop.hidden = true;
    pop.replaceChildren();
    Citations._anchor = null;
    if (restoreFocus && anchor && anchor.isConnected) anchor.focus();
  }

  _toggle(anchor, s) {
    const pop = Citations._popover();
    if (!pop.hidden && Citations._anchor === anchor) { Citations._close(); return; }
    pop.replaceChildren();
    const head = document.createElement('div');
    head.className = 'cite-head';
    head.appendChild(Citations._span('cite-mono', Citations._mono(s)));
    head.appendChild(Citations._span('cite-host', Citations._host(s)));
    head.appendChild(Citations._span('cite-n', String(s.n)));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cite-close';
    close.dataset.testid = 'cite-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => Citations._close());
    head.appendChild(close);
    const title = Citations._span('cite-title', s.title.slice(0, 160));
    const excerpt = Citations._span('cite-excerpt', s.excerpt);
    const open = document.createElement('a');
    open.className = 'cite-open';
    open.dataset.testid = 'cite-open';
    open.href = s.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open source';
    pop.append(head, title, excerpt, open);
    pop.setAttribute('aria-label', `Source ${s.n}: ${Citations._host(s)}`);
    pop.hidden = false;
    Citations._anchor = anchor;
    Citations._place(pop, anchor);
    close.focus({ preventScroll: true });
  }

  // Anchored under the chip (above when there is no room), clamped to the viewport.
  static _place(pop, anchor) {
    if (!anchor || !anchor.isConnected) { Citations._close(); return; }
    const m = 8;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(360, vw - 2 * m);
    const below = vh - r.bottom - m;
    const above = r.top - m;
    const useBelow = below >= Math.min(220, above) || below >= above;
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${Math.max(120, useBelow ? below : above) - 4}px`;
    pop.style.left = `${Math.max(m, Math.min(r.left, vw - width - m))}px`;
    if (useBelow) {
      pop.style.top = `${r.bottom + 4}px`;
    } else {
      pop.style.top = `${Math.max(m, r.top - 4 - pop.offsetHeight)}px`;
    }
  }
}
