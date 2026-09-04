class ModuleActivityOrb {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ModuleOrb');

    this.invocations = new Map();
    this.activeId = null;
    this._userIsNearBottom = true;

    this.orbEl = null;
    this.dialogEl = null;
    this.dialogBody = null;
    this.tabsEl = null;
  }

  init() {
    this._buildOrb();
    this._buildDialog();
    this.bus.on(EVT.MODULE_AI_STARTED, (msg) => this._onStarted(msg));
    this.bus.on(EVT.MODULE_AI_EVENT, (msg) => this._onEvent(msg));
    this.bus.on(EVT.MODULE_AI_COMPLETED, (msg) => this._onTerminal(msg, 'completed'));
    this.bus.on(EVT.MODULE_AI_FAILED, (msg) => this._onTerminal(msg, 'failed'));
  }

  _buildOrb() {
    const orb = document.createElement('button');
    orb.type = 'button';
    orb.id = 'moduleActivityOrb';
    orb.className = 'module-orb hidden';
    orb.title = 'AI activity (click to inspect)';
    orb.setAttribute('aria-label', 'Module AI activity');
    orb.setAttribute('data-testid', 'module-activity-orb');
    orb.innerHTML = `
      <span class="module-orb__core" aria-hidden="true"></span>
      <span class="module-orb__count" hidden></span>
    `;
    orb.addEventListener('click', () => this.openDialog());
    document.body.appendChild(orb);
    this.orbEl = orb;
  }

  _buildDialog() {
    const dialog = document.createElement('div');
    dialog.id = 'moduleActivityDialog';
    dialog.className = 'module-orb-dialog hidden';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Module AI activity log');
    dialog.innerHTML = `
      <div class="module-orb-dialog__backdrop" data-orb-close></div>
      <div class="module-orb-dialog__panel" role="document">
        <header class="module-orb-dialog__header">
          <h3>Module AI Activity</h3>
          <button type="button" class="module-orb-dialog__close" data-orb-close aria-label="Close">&times;</button>
        </header>
        <nav class="module-orb-dialog__tabs" data-orb-tabs></nav>
        <div class="module-orb-dialog__body" data-orb-body></div>
      </div>
    `;
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-orb-close]')) this.closeDialog();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.dialogEl.classList.contains('hidden')) {
        this.closeDialog();
      }
    });
    document.body.appendChild(dialog);
    this.dialogEl = dialog;
    this.tabsEl = dialog.querySelector('[data-orb-tabs]');
    this.dialogBody = dialog.querySelector('[data-orb-body]');
  }

  _onStarted(msg) {
    const { requestId, projectId, moduleName, sessionId, model } = msg;
    if (!requestId) return;
    this.invocations.set(requestId, {
      requestId, projectId, moduleName, sessionId, model,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      eventCount: 0,
      rows: new Map(),
      rowElements: new Map(),
      finalResult: null,
      finalError: null,
    });
    this._refreshOrb();
    this._refreshTabs();
    if (this.dialogEl.classList.contains('hidden')) return;
    // Also covers a caller pre-selecting this requestId before the start
    // frame arrives (e.g. programmatic selection right after send).
    if (!this.activeId || this.activeId === requestId) {
      this._selectInvocation(requestId);
    }
  }

  _onEvent(msg) {
    const inv = this.invocations.get(msg.requestId);
    if (!inv) return;
    // Bounds memory on a chatty model; stops accepting events rather than
    // shifting the oldest ones out, which would be O(n) per event.
    if (inv.eventCount >= 2000) return;
    inv.eventCount++;

    const result = projectEventIntoRows(inv.rows, msg.event);
    if (result && this.activeId === msg.requestId) this._applyRowUpdate(result, inv);
  }

  _onTerminal(msg, kind) {
    const inv = this.invocations.get(msg.requestId);
    if (!inv) return;
    inv.status = kind;
    inv.endedAt = Date.now();
    if (kind === 'completed') {
      inv.finalResult = msg.result;
      inv.finalRawText = msg.rawText;
      inv.finalModel = msg.model;
    } else {
      inv.finalError = msg.error || 'Unknown error';
    }
    this._refreshOrb();
    this._refreshTabs();
    if (this.activeId === msg.requestId) this._renderActiveDetail();
  }

  _refreshOrb() {
    const running = this._runningCount();
    if (running === 0) {
      this.orbEl.classList.add('hidden');
      return;
    }
    this.orbEl.classList.remove('hidden');
    const badge = this.orbEl.querySelector('.module-orb__count');
    if (running >= 2) {
      badge.hidden = false;
      badge.textContent = String(running);
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }

  _runningCount() {
    let n = 0;
    for (const inv of this.invocations.values()) if (inv.status === 'running') n++;
    return n;
  }

  openDialog() {
    this.dialogEl.classList.remove('hidden');
    if (!this.activeId || !this.invocations.has(this.activeId)) {
      const running = [...this.invocations.values()].filter(i => i.status === 'running');
      const pick = running[running.length - 1] || [...this.invocations.values()].pop();
      if (pick) this._selectInvocation(pick.requestId);
      else this._renderEmpty();
    } else {
      this._renderActiveDetail();
    }
    this._refreshTabs();
  }

  closeDialog() {
    this.dialogEl.classList.add('hidden');
    for (const [id, inv] of [...this.invocations.entries()]) {
      if (inv.status !== 'running') this.invocations.delete(id);
    }
    this.activeId = null;
  }

  _refreshTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = '';
    const list = [...this.invocations.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const inv of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `module-orb-dialog__tab is-${inv.status}`;
      if (inv.requestId === this.activeId) btn.classList.add('is-active');
      btn.textContent = inv.moduleName || '(module)';
      const dot = document.createElement('span');
      dot.className = 'module-orb-dialog__tab-dot';
      btn.prepend(dot);
      btn.addEventListener('click', () => this._selectInvocation(inv.requestId));
      this.tabsEl.appendChild(btn);
    }
    this.tabsEl.style.display = list.length > 1 ? '' : 'none';
  }

  _selectInvocation(requestId) {
    this.activeId = requestId;
    this._refreshTabs();
    this._renderActiveDetail();
  }

  _renderEmpty() {
    this.dialogBody.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'module-orb-dialog__empty';
    empty.textContent = 'No module AI activity right now.';
    this.dialogBody.appendChild(empty);
  }

  _renderActiveDetail() {
    if (!this.activeId) return this._renderEmpty();
    const inv = this.invocations.get(this.activeId);
    if (!inv) return this._renderEmpty();

    this.dialogBody.innerHTML = '';
    inv.rowElements.clear();
    this._userIsNearBottom = true;

    this.dialogBody.appendChild(this._buildMeta(inv));
    this._appendActions(inv);

    const log = document.createElement('div');
    log.className = 'module-orb-dialog__log';
    log.setAttribute('data-orb-log', '');
    log.addEventListener('scroll', () => {
      this._userIsNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    });
    this.dialogBody.appendChild(log);
    for (const [key, row] of inv.rows) {
      const el = this._renderRowElement(row);
      inv.rowElements.set(key, el);
      log.appendChild(el);
    }

    if (inv.status === 'completed') this._appendFinalResult(inv);
  }

  _buildMeta(inv) {
    const meta = document.createElement('div');
    meta.className = 'module-orb-dialog__meta';
    const elapsed = ((inv.endedAt || Date.now()) - inv.startedAt) / 1000;
    const statusLabel = inv.status === 'running' ? 'Running'
      : inv.status === 'completed' ? 'Completed'
      : 'Failed';
    meta.innerHTML = `
      <div class="module-orb-dialog__meta-row">
        <span class="module-orb-dialog__label">Module:</span>
        <span class="module-orb-dialog__value">${escapeHtml(inv.moduleName || '')}</span>
      </div>
      <div class="module-orb-dialog__meta-row">
        <span class="module-orb-dialog__label">Model:</span>
        <span class="module-orb-dialog__value">${escapeHtml(inv.model || '(project default)')}</span>
      </div>
      <div class="module-orb-dialog__meta-row">
        <span class="module-orb-dialog__label">Session:</span>
        <span class="module-orb-dialog__value module-orb-dialog__value--mono">${escapeHtml((inv.sessionId || '').slice(0, 12))}</span>
      </div>
      <div class="module-orb-dialog__meta-row">
        <span class="module-orb-dialog__label">Status:</span>
        <span class="module-orb-dialog__value module-orb-dialog__status module-orb-dialog__status--${inv.status}">${statusLabel} (${elapsed.toFixed(1)}s)</span>
      </div>
    `;
    return meta;
  }

  _appendActions(inv) {
    if (inv.status === 'running') {
      const actions = document.createElement('div');
      actions.className = 'module-orb-dialog__actions';
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'btn-danger';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => this._handleStop(inv.requestId));
      actions.appendChild(stopBtn);
      this.dialogBody.appendChild(actions);
    } else if (inv.status === 'failed') {
      const err = document.createElement('div');
      err.className = 'module-orb-dialog__error';
      err.textContent = inv.finalError;
      this.dialogBody.appendChild(err);
    }
  }

  _appendFinalResult(inv) {
    const result = document.createElement('div');
    result.className = 'module-orb-dialog__result';
    const heading = document.createElement('div');
    heading.className = 'module-orb-dialog__result-heading';
    heading.textContent = 'Final result';
    const pre = document.createElement('pre');
    pre.className = 'module-orb-dialog__result-body';
    pre.textContent = typeof inv.finalResult === 'string'
      ? inv.finalResult
      : JSON.stringify(inv.finalResult, null, 2);
    result.appendChild(heading);
    result.appendChild(pre);
    this.dialogBody.appendChild(result);
  }

  _applyRowUpdate(result, inv) {
    const log = this.dialogBody.querySelector('[data-orb-log]');
    if (!log) return;

    if (result.op === 'new') {
      const row = inv.rows.get(result.key);
      const el = this._renderRowElement(row);
      inv.rowElements.set(result.key, el);
      log.appendChild(el);
    } else if (result.op === 'update') {
      const el = inv.rowElements.get(result.key);
      if (el) {
        const body = el.querySelector('.module-orb-dialog__event-body');
        const row = inv.rows.get(result.key);
        if (body && row) body.textContent = row.text;
      }
    }

    if (this._userIsNearBottom) log.scrollTop = log.scrollHeight;
  }

  _renderRowElement(row) {
    const el = document.createElement('div');
    el.className = `module-orb-dialog__event is-${row.kind}`;
    const tag = document.createElement('span');
    tag.className = 'module-orb-dialog__event-tag';
    tag.textContent = row.tag;
    el.appendChild(tag);
    const body = document.createElement('span');
    body.className = 'module-orb-dialog__event-body';
    body.textContent = row.text;
    el.appendChild(body);
    return el;
  }

  // Not routed through ModuleHost.stopInvoke: that path checks the SDK's
  // pending-invoke map, which is empty for invocations the orb learned about
  // purely from the server.
  _handleStop(requestId) {
    const wsClient = this.container.get('ws');
    wsClient?.send({ type: 'module_ai_stop', requestId });
  }
}

// relayLLM streams text/thinking as deltas against a stable content-block
// index; text/thinking rows key on `text-<index>`/`think-<index>` so deltas
// for the same block coalesce into one row, and tool rows key on
// `tool-<index>`, absorbing the input_json_delta stream into a placeholder
// until the resolved args arrive in content_block_stop.
function projectEventIntoRows(rows, msg) {
  if (!msg || typeof msg !== 'object') return null;
  const topLevel = projectTopLevelFrame(rows, msg);
  if (topLevel !== undefined) return topLevel;
  return projectLlmEvent(rows, msg.event);
}

// Returns a result for frames Eve adds itself (session_joined / message_complete
// / stats_update / etc), or `undefined` to fall through to the relayLLM event
// projection. Distinct from `null` (which means "skip this frame entirely").
function projectTopLevelFrame(rows, msg) {
  if (msg.type === 'session_joined') {
    return pushNew(rows, { tag: 'join', text: `session ${(msg.sessionId || '').slice(0, 8)}`, kind: 'meta' });
  }
  if (msg.type === 'message_complete') {
    return pushNew(rows, {
      tag: 'done',
      text: msg.error ? `error: ${msg.error}` : '(message_complete)',
      kind: msg.error ? 'error' : 'done',
    });
  }
  if (msg.type === 'error') {
    return pushNew(rows, { tag: 'error', text: msg.message || 'error', kind: 'error' });
  }
  if (msg.type === 'stats_update') {
    // Coalesce into one row that mutates in place — thousands of stats
    // frames would otherwise dominate the log.
    const s = msg.stats || {};
    const ctx = s.contextPercent != null ? `ctx ${s.contextPercent.toFixed(1)}%` : '';
    const cost = s.costUsd != null ? `$${s.costUsd.toFixed(4)}` : '';
    return upsertByKey(rows, 'stats', { tag: 'stats', text: [ctx, cost].filter(Boolean).join(' · '), kind: 'meta' });
  }
  if (msg.type === 'user_message') {
    const text = (msg.text || '').replace(/\s+/g, ' ').slice(0, 160);
    return pushNew(rows, { tag: 'user', text: text + (msg.text?.length > 160 ? '…' : ''), kind: 'meta' });
  }
  if (msg.type !== 'llm_event' || !msg.event) {
    return pushNew(rows, { tag: msg.type || '?', text: JSON.stringify(msg).slice(0, 160), kind: 'other' });
  }
  return undefined;
}

function projectLlmEvent(rows, ev) {
  if (!ev) return null;
  if (ev.type === 'assistant') return projectAssistantEvent(rows, ev);
  if (ev.type === 'result' && ev.subtype === 'tool_result') {
    const preview = typeof ev.content === 'string' ? ev.content.slice(0, 200)
      : Array.isArray(ev.content) ? ev.content.map(c => c.text || c.type).join(' ').slice(0, 200)
      : '';
    return pushNew(rows, { tag: 'result', text: preview, kind: 'tool' });
  }
  if (ev.type === 'system') {
    return pushNew(rows, { tag: 'sys', text: ev.message || ev.subtype || '(system)', kind: 'meta' });
  }
  return pushNew(rows, { tag: ev.type || '?', text: JSON.stringify(ev).slice(0, 200), kind: 'other' });
}

function projectAssistantEvent(rows, ev) {
  const idx = ev.index;
  if (ev.delta?.type === 'text_delta' && idx !== undefined) {
    const fragment = ev.delta.text || '';
    return fragment ? appendByKey(rows, `text-${idx}`, fragment, { tag: 'text', kind: 'text' }) : null;
  }
  if (ev.delta?.type === 'thinking_delta' && idx !== undefined) {
    const fragment = ev.delta.thinking || '';
    return fragment ? appendByKey(rows, `think-${idx}`, fragment, { tag: 'think', kind: 'thinking' }) : null;
  }
  if (ev.delta?.type === 'input_json_delta' && idx !== undefined) {
    // The args stream as raw JSON fragments — too noisy to render literally.
    // Show a placeholder; the resolved input lands in content_block_stop.
    return upsertByKey(rows, `tool-${idx}`, { tag: 'tool', text: '(streaming args…)', kind: 'tool' });
  }
  if (ev.content_block?.type === 'tool_use' && idx !== undefined) {
    const name = ev.content_block.name || '';
    const text = ev.content_block.input
      ? `${name} ${JSON.stringify(ev.content_block.input)}`.slice(0, 200)
      : name;
    return upsertByKey(rows, `tool-${idx}`, { tag: 'tool', text, kind: 'tool' });
  }
  if (ev.content_block?.type === 'text' && idx !== undefined) {
    return upsertByKey(rows, `text-${idx}`, { tag: 'text', text: '', kind: 'text' });
  }
  if (ev.content_block?.type === 'thinking' && idx !== undefined) {
    return upsertByKey(rows, `think-${idx}`, { tag: 'think', text: '', kind: 'thinking' });
  }
  if (ev.content_block_stop) {
    if (ev.content_block?.type === 'tool_use' && idx !== undefined && ev.content_block.input) {
      const name = ev.content_block.name || '';
      const text = `${name} ${JSON.stringify(ev.content_block.input)}`.slice(0, 200);
      return upsertByKey(rows, `tool-${idx}`, { tag: 'tool', text, kind: 'tool' });
    }
    return null;
  }
  if (ev.message?.content) {
    const parts = ev.message.content.map(b =>
      b.type === 'text' ? (b.text || '').slice(0, 200)
      : b.type === 'tool_use' ? `tool=${b.name}`
      : b.type
    );
    return pushNew(rows, { tag: 'asst', text: parts.join(' | '), kind: 'text' });
  }
  return null;
}

function pushNew(rows, fields) {
  const key = `e-${rows.size}`;
  rows.set(key, fields);
  return { key, op: 'new' };
}

function appendByKey(rows, key, fragment, seed) {
  const existing = rows.get(key);
  if (existing) {
    existing.text += fragment;
    return { key, op: 'update' };
  }
  rows.set(key, { ...seed, text: fragment });
  return { key, op: 'new' };
}

function upsertByKey(rows, key, fields) {
  const existing = rows.get(key);
  if (existing) {
    Object.assign(existing, fields);
    return { key, op: 'update' };
  }
  rows.set(key, fields);
  return { key, op: 'new' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModuleActivityOrb;
}
