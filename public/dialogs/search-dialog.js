/**
 * SearchDialog - project-wide content search backed by ripgrep on the server.
 *
 * Sends `search_project` over the WS, receives grouped results, renders
 * file-grouped match list with highlighted spans. Click a result to open the
 * file in the editor at the matching line.
 */

// Ripgrep search runs on a tight keystroke debounce — matches feel instant.
const SEARCH_DEBOUNCE_MS = 250;
// AI summarization runs on a longer settled-typing debounce. The LLM call is
// expensive (session create + tokens), so we wait for the user to stop typing
// before firing. Set so the user has clearly paused but the wait isn't long
// enough to feel sluggish after they've stopped.
const AI_SUMMARY_DEBOUNCE_MS = 700;

class SearchDialog extends DialogBase {
  constructor(container) {
    super(container, 'search-dialog');
    this.state = container.get('state');
    this.settings = container.has('settings') ? container.get('settings') : null;
    this.projectId = null;
    this._currentRequestId = null;
    this._debounceTimer = null;
    this._matches = [];
    this._truncated = false;
    this._selectedIndex = -1;
    this._resultRows = [];
    this._lastQuery = '';

    // AI summarization state
    this._aiRequestId = null;
    this._aiText = '';
    this._aiState = 'idle';      // idle | streaming | complete | error
    this._aiError = '';
    this._aiDebounceTimer = null;
    // True when the AI debounce has elapsed but results hadn't arrived yet —
    // _renderResults() will fire the summary as soon as matches land.
    this._aiPending = false;
    // Cached reference to the summary body div; updated incrementally during
    // streaming to avoid rebuilding the whole panel per text_delta.
    this._aiBodyEl = null;
  }

  init() {
    this.bus.on(EVT.DIALOG_SEARCH, (data) => {
      this.projectId = data.projectId;
      this.render();
      this.show();
    });

    this.bus.on(EVT.SEARCH_RESULTS, (data) => {
      if (!this.isVisible) return;
      if (data.requestId !== this._currentRequestId) return; // stale result
      if (data.projectId !== this.projectId) return;
      this._currentRequestId = null;
      this._matches = data.matches || [];
      this._truncated = !!data.truncated;
      this._renderResults();
    });

    this.bus.on(EVT.SEARCH_ERROR, (data) => {
      if (!this.isVisible) return;
      if (data.requestId !== this._currentRequestId) return;
      if (data.projectId !== this.projectId) return;
      this._currentRequestId = null;
      this._matches = [];
      this._truncated = false;
      this._renderError(data.error || 'Search failed');
    });

    // AI summarization stream — accumulate text from relay event frames and
    // re-render. Stale events from a cancelled requestId are ignored.
    this.bus.on(EVT.SEARCH_AI_STARTED, (data) => {
      if (!this.isVisible) return;
      if (data.requestId !== this._aiRequestId) return;
      this._aiState = 'streaming';
      this._aiText = '';
      this._aiError = '';
      this._renderAiSummary();
    });

    this.bus.on(EVT.SEARCH_AI_EVENT, (data) => {
      if (!this.isVisible) return;
      if (data.requestId !== this._aiRequestId) return;
      const added = accumulateAssistantText(data.event);
      if (!added) return;
      this._aiText += added;
      // Hot path: deltas fire 50+ times per response. Update only the body
      // textContent instead of rebuilding the whole panel.
      if (this._aiBodyEl) {
        this._aiBodyEl.textContent = this._aiText;
      } else {
        this._renderAiSummary();
      }
    });

    this.bus.on(EVT.SEARCH_AI_COMPLETED, (data) => {
      if (!this.isVisible) return;
      if (data.requestId !== this._aiRequestId) return;
      this._aiRequestId = null;
      this._aiState = this._aiText.trim() ? 'complete' : 'error';
      if (this._aiState === 'error') this._aiError = 'Model returned no text.';
      this._renderAiSummary();
    });

    this.bus.on(EVT.SEARCH_AI_FAILED, (data) => {
      if (!this.isVisible) return;
      if (data.requestId !== this._aiRequestId) return;
      this._aiRequestId = null;
      this._aiState = 'error';
      this._aiError = data.error || 'Summary failed';
      this._renderAiSummary();
    });
  }

  render() {
    const project = this.state.getProject(this.projectId);
    const projectName = project?.name || 'Unknown';

    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '720px';
    this._panel.appendChild(this._createTitleBar('Search', projectName));

    const body = document.createElement('div');
    body.className = 'dialog__tab-content search-dialog__body';

    // Query input
    this._queryInput = document.createElement('input');
    this._queryInput.type = 'text';
    this._queryInput.className = 'dialog__input search-dialog__query';
    this._queryInput.placeholder = 'Search file contents…';
    this._queryInput.dataset.testid = 'search-dialog-query';
    this._queryInput.value = this._lastQuery || '';
    this._queryInput.addEventListener('input', () => this._scheduleSearch());
    this._queryInput.addEventListener('keydown', (e) => this._onKey(e));
    body.appendChild(this._queryInput);

    // Options row
    const options = document.createElement('div');
    options.className = 'search-dialog__options';

    this._regexToggle = this._createToggle('regex', 'Regex', () => this._scheduleSearch(true));
    this._wordToggle = this._createToggle('word', 'Whole word', () => this._scheduleSearch(true));
    options.appendChild(this._regexToggle.label);
    options.appendChild(this._wordToggle.label);

    this._globInput = document.createElement('input');
    this._globInput.type = 'text';
    this._globInput.className = 'dialog__input search-dialog__glob';
    this._globInput.placeholder = 'files to include (e.g. *.md, !node_modules)';
    this._globInput.dataset.testid = 'search-dialog-glob';
    this._globInput.addEventListener('input', () => this._scheduleSearch());
    options.appendChild(this._globInput);

    body.appendChild(options);

    // AI controls row: [AI enhanced checkbox] [model dropdown]
    const aiRow = document.createElement('div');
    aiRow.className = 'search-dialog__ai-row';

    const aiLabel = document.createElement('label');
    aiLabel.className = 'search-dialog__toggle';
    this._aiCheckbox = document.createElement('input');
    this._aiCheckbox.type = 'checkbox';
    this._aiCheckbox.dataset.testid = 'search-dialog-ai-toggle';
    this._aiCheckbox.checked = !!this.settings?.getLastSearchAiEnabled?.(this.projectId);
    this._aiCheckbox.addEventListener('change', () => {
      this.settings?.setLastSearchAiEnabled?.(this.projectId, this._aiCheckbox.checked);
      this._updateAiControlsEnabled();
      // If toggled ON and we already have matches, run a summary now.
      if (this._aiCheckbox.checked && this._matches.length > 0) {
        this._runAiSummary();
      } else if (!this._aiCheckbox.checked) {
        this._cancelAiSummary();
        this._aiState = 'idle';
        this._aiText = '';
        this._renderAiSummary();
      }
    });
    const aiText = document.createElement('span');
    aiText.textContent = 'AI enhanced';
    aiLabel.appendChild(this._aiCheckbox);
    aiLabel.appendChild(aiText);
    aiRow.appendChild(aiLabel);

    this._modelSelect = document.createElement('select');
    this._modelSelect.className = 'dialog__select search-dialog__model-select';
    this._modelSelect.dataset.testid = 'search-dialog-model';
    const remembered = this.settings?.getLastSearchModel?.(this.projectId);
    renderModelSelect(this._modelSelect, this.state.models, {
      selectedValue: remembered || undefined,
    });
    this._modelSelect.addEventListener('change', () => {
      this.settings?.setLastSearchModel?.(this.projectId, this._modelSelect.value);
      // Re-summarize with the new model if AI is on and we have matches.
      if (this._aiCheckbox.checked && this._matches.length > 0) {
        this._runAiSummary();
      }
    });
    aiRow.appendChild(this._modelSelect);

    body.appendChild(aiRow);
    this._updateAiControlsEnabled();

    // Status line
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'search-dialog__status';
    body.appendChild(this._statusEl);

    // AI summary panel (above the results scroller — always rendered, but
    // hidden when state === 'idle'). Updated by _renderAiSummary().
    this._aiSummaryEl = document.createElement('div');
    this._aiSummaryEl.className = 'search-dialog__ai-summary';
    this._aiSummaryEl.dataset.testid = 'search-dialog-ai-summary';
    this._aiSummaryEl.hidden = true;
    body.appendChild(this._aiSummaryEl);

    // Results pane
    this._resultsEl = document.createElement('div');
    this._resultsEl.className = 'search-dialog__results';
    this._resultsEl.dataset.testid = 'search-dialog-results';
    body.appendChild(this._resultsEl);

    this._panel.appendChild(body);

    if (this._queryInput.value.trim()) {
      // Re-running existing query on reopen
      this._runSearch();
    } else {
      this._renderEmpty('Type to search file contents.');
    }
  }

  _createToggle(name, label, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'search-dialog__toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.testid = `search-dialog-toggle-${name}`;
    input.addEventListener('change', onChange);

    const text = document.createElement('span');
    text.textContent = label;

    wrap.appendChild(input);
    wrap.appendChild(text);
    return { label: wrap, input };
  }

  _scheduleSearch(immediate = false) {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    // Any pending AI fire is invalidated — the query has changed.
    if (this._aiDebounceTimer) clearTimeout(this._aiDebounceTimer);
    this._aiPending = false;

    if (immediate) {
      this._runSearch();
    } else {
      this._debounceTimer = setTimeout(() => this._runSearch(), SEARCH_DEBOUNCE_MS);
    }

    // AI summary runs on its own longer debounce so fast typing doesn't pay
    // for an LLM call on every committed keystroke. When this timer fires
    // we either kick off the summary (results already landed) or mark
    // pending so _renderResults() fires it when matches arrive.
    if (this._aiCheckbox?.checked) {
      this._aiDebounceTimer = setTimeout(() => {
        this._aiDebounceTimer = null;
        this._tryStartAiSummary();
      }, AI_SUMMARY_DEBOUNCE_MS);
    }
  }

  /**
   * Conditions checked at AI-debounce fire time: AI on, dialog visible,
   * matches present for the current query. If matches aren't here yet,
   * we set `_aiPending` so the deferred fire happens in `_renderResults()`.
   */
  _tryStartAiSummary() {
    if (!this._aiCheckbox?.checked) return;
    if (!this.isVisible) return;
    if (this._matches.length === 0) {
      this._aiPending = true;
      return;
    }
    this._aiPending = false;
    this._runAiSummary();
  }

  _runSearch() {
    const query = this._queryInput.value.trim();
    this._lastQuery = query;

    if (this._currentRequestId) {
      this.container.get('ws').send({ type: 'search_cancel', requestId: this._currentRequestId });
    }
    // Drop any in-flight AI summary — its match list is now stale.
    this._cancelAiSummary();
    this._aiState = 'idle';
    this._aiText = '';
    this._renderAiSummary();

    if (!query) {
      this._currentRequestId = null;
      this._matches = [];
      this._truncated = false;
      this._renderEmpty('Type to search file contents.');
      return;
    }

    const requestId = (window.crypto?.randomUUID && window.crypto.randomUUID())
      || `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._currentRequestId = requestId;

    const globs = this._globInput.value
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);

    this.container.get('ws').send({
      type: 'search_project',
      requestId,
      projectId: this.projectId,
      query,
      options: {
        regex: this._regexToggle.input.checked,
        word: this._wordToggle.input.checked,
        globs,
      },
    });

    this._renderLoading();
  }

  _renderLoading() {
    this._statusEl.textContent = 'Searching…';
    this._resultsEl.innerHTML = '';
    this._resultRows = [];
    this._selectedIndex = -1;
  }

  _renderEmpty(message) {
    this._statusEl.textContent = '';
    this._resultsEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'search-dialog__empty';
    empty.textContent = message;
    this._resultsEl.appendChild(empty);
    this._resultRows = [];
    this._selectedIndex = -1;
  }

  _renderError(message) {
    this._statusEl.textContent = '';
    this._resultsEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'search-dialog__error';
    err.textContent = message;
    this._resultsEl.appendChild(err);
    this._resultRows = [];
    this._selectedIndex = -1;
  }

  _renderResults() {
    this._resultsEl.innerHTML = '';
    this._resultRows = [];
    this._selectedIndex = -1;

    if (this._matches.length === 0) {
      this._statusEl.textContent = 'No matches.';
      // Drop any prior AI summary — nothing to summarize.
      this._cancelAiSummary();
      this._aiPending = false;
      this._aiState = 'idle';
      this._aiText = '';
      this._renderAiSummary();
      return;
    }

    // AI is debounced independently of ripgrep. If the AI debounce already
    // elapsed while we were waiting on results, fire the summary now.
    // Otherwise the AI timer will fire shortly and pick this up via
    // _tryStartAiSummary().
    if (this._aiPending && this._aiCheckbox?.checked) {
      this._aiPending = false;
      this._runAiSummary();
    }

    // Group by file
    const groups = new Map();
    for (const m of this._matches) {
      if (!groups.has(m.file)) groups.set(m.file, []);
      groups.get(m.file).push(m);
    }

    this._statusEl.textContent =
      `${this._matches.length} match${this._matches.length === 1 ? '' : 'es'} in ${groups.size} file${groups.size === 1 ? '' : 's'}` +
      (this._truncated ? ' (truncated — refine your query for more)' : '');

    for (const [file, list] of groups) {
      const group = document.createElement('div');
      group.className = 'search-dialog__file-group';

      const header = document.createElement('div');
      header.className = 'search-dialog__file-header';
      header.textContent = `${file}  (${list.length})`;
      header.title = file;
      group.appendChild(header);

      for (const match of list) {
        const row = this._buildResultRow(file, match);
        group.appendChild(row);
        this._resultRows.push(row);
      }

      this._resultsEl.appendChild(group);
    }
  }

  _buildResultRow(file, match) {
    const row = document.createElement('button');
    row.className = 'search-dialog__result-row';
    row.dataset.testid = `search-dialog-result-${file}-${match.lineNumber}`;
    row.type = 'button';

    const lineNo = document.createElement('span');
    lineNo.className = 'search-dialog__line-no';
    lineNo.textContent = String(match.lineNumber);
    row.appendChild(lineNo);

    const preview = document.createElement('span');
    preview.className = 'search-dialog__preview';
    this._appendHighlightedPreview(preview, match.lineText || '', match.submatches || []);
    row.appendChild(preview);

    row.addEventListener('click', () => this._openMatch(file, match.lineNumber));
    row.addEventListener('mouseenter', () => this._setSelected(this._resultRows.indexOf(row)));
    return row;
  }

  /**
   * Append the matched line to `el`, wrapping each submatch range in <mark>.
   * Built with textContent so file content is never injected as HTML.
   * Long lines are trimmed around the first match to keep rows readable.
   */
  _appendHighlightedPreview(el, lineText, submatches) {
    const MAX_LEN = 200;
    let start = 0;
    let text = lineText;
    let offset = 0;
    let subs = submatches;

    if (text.length > MAX_LEN && subs.length > 0) {
      const firstStart = subs[0].start;
      // Center the window around the first match
      const half = Math.floor(MAX_LEN / 2);
      offset = Math.max(0, firstStart - half);
      text = text.slice(offset, offset + MAX_LEN);
      if (offset > 0) {
        text = '…' + text;
        offset -= 1; // account for the ellipsis we just prepended
      }
      if (lineText.length > offset + MAX_LEN + 1) text += '…';
      subs = subs
        .map(s => ({ start: s.start - offset, end: s.end - offset }))
        .filter(s => s.end > 0 && s.start < text.length);
    }

    for (const sub of subs) {
      const s = Math.max(0, sub.start);
      const e = Math.min(text.length, sub.end);
      if (s > start) el.appendChild(document.createTextNode(text.slice(start, s)));
      if (e > s) {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(s, e);
        el.appendChild(mark);
      }
      start = e;
    }
    if (start < text.length) {
      el.appendChild(document.createTextNode(text.slice(start)));
    }
  }

  _openMatch(filePath, lineNumber) {
    const absolutePath = filePath.startsWith('/') ? filePath : '/' + filePath;
    const filename = filePath.split('/').pop();
    this.bus.emit(EVT.FILE_CONTENT, {
      projectId: this.projectId,
      path: absolutePath,
      filename,
      requestLoad: true,
      lineNumber,
    });
    this.hide();
  }

  _onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._move(-1);
    } else if (e.key === 'Enter') {
      if (this._selectedIndex >= 0 && this._resultRows[this._selectedIndex]) {
        e.preventDefault();
        this._resultRows[this._selectedIndex].click();
      } else if (this._debounceTimer) {
        e.preventDefault();
        this._scheduleSearch(true);
      }
    }
  }

  _move(delta) {
    if (this._resultRows.length === 0) return;
    let next = this._selectedIndex + delta;
    if (next < 0) next = 0;
    if (next >= this._resultRows.length) next = this._resultRows.length - 1;
    this._setSelected(next);
    this._resultRows[next].scrollIntoView({ block: 'nearest' });
  }

  _setSelected(idx) {
    if (this._selectedIndex >= 0 && this._resultRows[this._selectedIndex]) {
      this._resultRows[this._selectedIndex].classList.remove('search-dialog__result-row--selected');
    }
    this._selectedIndex = idx;
    if (idx >= 0 && this._resultRows[idx]) {
      this._resultRows[idx].classList.add('search-dialog__result-row--selected');
    }
  }

  _updateAiControlsEnabled() {
    if (!this._modelSelect) return;
    const enabled = !!this._aiCheckbox?.checked;
    this._modelSelect.disabled = !enabled;
  }

  _runAiSummary() {
    // Cancel any in-flight summary before starting a new one.
    this._cancelAiSummary();

    const requestId = (window.crypto?.randomUUID && window.crypto.randomUUID())
      || `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._aiRequestId = requestId;
    this._aiText = '';
    this._aiError = '';
    this._aiState = 'streaming';
    this._renderAiSummary();

    this.container.get('ws').send({
      type: 'search_ai_summarize',
      requestId,
      projectId: this.projectId,
      query: this._lastQuery,
      matches: this._matches,           // server clamps to 50
      model: this._modelSelect?.value || '',
    });
  }

  _cancelAiSummary() {
    if (!this._aiRequestId) return;
    try {
      this.container.get('ws').send({ type: 'search_ai_stop', requestId: this._aiRequestId });
    } catch { /* ws may already be closed */ }
    this._aiRequestId = null;
  }

  /**
   * Re-render the summary panel based on `_aiState`. The streaming hot path
   * (SEARCH_AI_EVENT) doesn't call this — it updates `_aiBodyEl.textContent`
   * directly to avoid a full DOM rebuild on every text_delta.
   */
  _renderAiSummary() {
    if (!this._aiSummaryEl) return;
    this._aiSummaryEl.innerHTML = '';
    this._aiBodyEl = null;
    this._aiSummaryEl.classList.remove(
      'search-dialog__ai-summary--streaming',
      'search-dialog__ai-summary--error',
    );

    if (this._aiState === 'idle') {
      this._aiSummaryEl.hidden = true;
      return;
    }
    this._aiSummaryEl.hidden = false;

    const header = document.createElement('div');
    header.className = 'search-dialog__ai-summary-header';
    header.textContent = this._aiState === 'error' ? 'AI summary error' : 'AI summary';
    this._aiSummaryEl.appendChild(header);

    const body = document.createElement('div');
    body.className = 'search-dialog__ai-summary-body';

    if (this._aiState === 'error') {
      this._aiSummaryEl.classList.add('search-dialog__ai-summary--error');
      body.textContent = this._aiError || 'Summary failed.';
      this._aiSummaryEl.appendChild(body);

      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'dialog__btn dialog__btn--secondary search-dialog__ai-retry';
      retry.textContent = 'Retry';
      retry.dataset.testid = 'search-dialog-ai-retry';
      retry.addEventListener('click', () => this._runAiSummary());
      this._aiSummaryEl.appendChild(retry);
      return;
    }

    body.textContent = this._aiText || (this._aiState === 'streaming' ? 'Thinking…' : '');
    this._aiSummaryEl.appendChild(body);
    this._aiBodyEl = body;

    if (this._aiState === 'streaming') {
      this._aiSummaryEl.classList.add('search-dialog__ai-summary--streaming');
    }
  }

  hide() {
    if (this._currentRequestId) {
      try {
        this.container.get('ws').send({ type: 'search_cancel', requestId: this._currentRequestId });
      } catch { /* ws may already be closed */ }
      this._currentRequestId = null;
    }
    this._cancelAiSummary();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._aiDebounceTimer) {
      clearTimeout(this._aiDebounceTimer);
      this._aiDebounceTimer = null;
    }
    this._aiPending = false;
    super.hide();
  }
}

/**
 * Walk a relay assistant event (same shape as module_ai_event's `event`)
 * and return any newly-arrived text. Mirrors
 * `module-invoker.js#accumulateAssistantText` server-side.
 */
function accumulateAssistantText(msg) {
  if (!msg || msg.type !== 'llm_event' || msg.event?.type !== 'assistant') return '';
  const ev = msg.event;
  let out = '';
  if (ev.delta?.type === 'text_delta' && ev.delta.text) out += ev.delta.text;
  if (ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) out += block.text;
    }
  }
  if (ev.content_block?.type === 'text' && ev.content_block.text) {
    out += ev.content_block.text;
  }
  return out;
}
