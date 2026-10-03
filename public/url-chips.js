/**
 * Pasted-URL chips for a text box (Today's Ask and the chat input).
 * A paste of exactly one http(s) URL becomes a removable chip instead of text;
 * every other paste is left to the browser. Chips are sent as `urls`, never as text.
 * Rule and label live in core/source-urls.js. All chip text goes through textContent.
 */
class UrlChips {
  constructor({ input, before, testid, onChange }) {
    this.input = input;
    this.testid = testid;
    this.onChange = onChange || null;
    this._urls = [];
    this.row = document.createElement('div');
    this.row.className = 'url-chips';
    this.row.dataset.testid = `${testid}s`;
    this.row.hidden = true;
    before.parentNode.insertBefore(this.row, before);
    input.addEventListener('paste', (e) => this._onPaste(e));
  }

  list() { return this._urls.slice(); }

  consume() {
    const urls = this.list();
    this.clear();
    return urls;
  }

  clear() {
    if (!this._urls.length) return;
    this._urls = [];
    this._render();
  }

  _onPaste(e) {
    if (e.defaultPrevented) return;
    const cd = e.clipboardData;
    if (!cd) return;
    if (Array.from(cd.items || []).some(i => i.kind === 'file') || (cd.files && cd.files.length)) return;
    const href = SourceUrls.fromPaste(cd.getData('text/plain'));
    if (!href) return;
    if (this._urls.includes(href)) { e.preventDefault(); return; }
    if (this._urls.length >= SourceUrls.MAX) return;
    e.preventDefault();
    this._urls.push(href);
    this._render();
  }

  _remove(href) {
    this._urls = this._urls.filter(u => u !== href);
    this._render();
    this.input.focus();
  }

  _render() {
    this.row.textContent = '';
    this._urls.forEach((href, i) => {
      const n = i + 1;
      const label = SourceUrls.label(href);
      const chip = document.createElement('div');
      chip.className = 'ask-chip';
      chip.dataset.testid = `${this.testid}-${n}`;
      chip.title = href;
      const text = document.createElement('span');
      text.className = 'ask-chip__label';
      text.textContent = label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ask-chip__remove';
      remove.dataset.testid = `${this.testid}-remove-${n}`;
      remove.setAttribute('aria-label', `Remove link ${label}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => this._remove(href));
      chip.append(text, remove);
      this.row.appendChild(chip);
    });
    this.row.hidden = this._urls.length === 0;
    if (this.onChange) this.onChange();
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = UrlChips;
