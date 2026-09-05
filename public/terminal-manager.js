class TerminalManager {
  constructor(container) {
    this.app = container.get('app');
    this.log = container.get('logger').child('Terminal');
    this.terminals = new Map();
    this.allTerminals = new Map();
    this.activeTerminalId = null;
    this.xtermLoaded = false;
    this.Terminal = null;
    this.FitAddon = null;
    this.WebLinksAddon = null;
    this.resizeHandler = null;
    this._readyCallbacks = [];
    this.templates = [];

    this.initElements();
    this.loadXterm();
    this._listenForSettingsChanges();
    // Must not throw: this is an optional enhancement built during init, and a
    // failure here would otherwise abort init and take the whole UI down.
    try {
      this.keybar = new TerminalKeybar(this);
    } catch (err) {
      this.keybar = null;
      this.log.warn('Mobile key bar failed to initialize; terminal input unaffected:', err?.message || err);
    }

    // visibilitychange/pageshow/focus fire reliably on return, unlike xterm's
    // own IntersectionObserver resume trigger; see _resumeRenderer.
    this._onForeground = () => {
      if (document.visibilityState === 'visible') this._forceResumeActive();
    };
    document.addEventListener('visibilitychange', this._onForeground);
    window.addEventListener('pageshow', this._onForeground);
    window.addEventListener('focus', this._onForeground);
  }

  activeTerm() {
    return this.terminals.get(this.activeTerminalId)?.term || null;
  }

  focusActive() {
    this.activeTerm()?.focus();
  }

  fitActive() {
    const t = this.terminals.get(this.activeTerminalId);
    if (t) t.fitAddon.fit();
  }

  // xterm pauses its renderer via an IntersectionObserver and only un-pauses on
  // an "intersecting" entry — RenderService.refreshRows early-returns while
  // `_isPaused`, so writes mark the grid dirty but nothing repaints. Safari/
  // WKWebView, and Chrome after a long background/discard, don't reliably
  // deliver that entry on foreground return, leaving the terminal accepting
  // input but never repainting until reload; we force the resume ourselves
  // instead. The private-API walk is guarded so a future xterm upgrade
  // degrades to a no-op instead of throwing.
  _resumeRenderer(term) {
    const rs = term && term._core && term._core._renderService;
    if (!rs || typeof rs.refreshRows !== 'function') return;
    rs._isPaused = false;
    rs.refreshRows(0, term.rows - 1);
  }

  _forceResumeActive() {
    const t = this.terminals.get(this.activeTerminalId);
    if (!t) return;
    this._resumeRenderer(t.term);
    // Fitting synchronously inside a focus/visibility handler — before the
    // returning viewport has laid out — can measure a transient/zero size and
    // push a bogus terminal_resize to the PTY, corrupting a full-screen TUI
    // mid-redraw. rAF defers the measure until the dimensions are real.
    requestAnimationFrame(() => {
      if (this.terminals.get(this.activeTerminalId) !== t) return;
      try { t.fitAddon.fit(); } catch (_) { /* fit can throw before layout settles */ }
      this._resumeRenderer(t.term);
    });
  }

  sendInput(seq) {
    const terminal = this.terminals.get(this.activeTerminalId);
    if (!terminal || terminal.exited || !seq) return;
    // Flush buffered input first so a tapped special key can't jump ahead of
    // characters typed just before it.
    this._flushTerminalInput(this.activeTerminalId);
    this.app.wsClient.send({
      type: 'terminal_input',
      terminalId: this.activeTerminalId,
      data: this._encodeBase64(seq),
    });
  }

  _flushTerminalInput(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    if (terminal.inputTimer) {
      clearTimeout(terminal.inputTimer);
      terminal.inputTimer = null;
    }
    if (!terminal.inputBuf) return;
    const data = this._encodeBase64(terminal.inputBuf);
    terminal.inputBuf = '';
    this.app.wsClient.send({ type: 'terminal_input', terminalId, data });
  }

  _listenForSettingsChanges() {
    this.app.bus.on(EVT.SETTINGS_CHANGED, (s) => {
      const fontStack = this.app.settings.getTerminalFontStack();
      const light = this.app.settings.isLight();
      for (const t of this.terminals.values()) {
        const fontChanged = t.term.options.fontSize !== s.fontSize || t.term.options.fontFamily !== fontStack;
        t.term.options.fontSize = s.fontSize;
        t.term.options.fontFamily = fontStack;
        t.term.options.theme = {
          ...t.term.options.theme,
          background: s.bgPrimary,
          foreground: s.textPrimary,
          cursor: s.textPrimary,
          cursorAccent: s.bgPrimary,
          selectionBackground: light ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.3)',
        };
        if (fontChanged) t.fitAddon.fit();
      }
    });
  }

  initElements() {
    this.terminalContent = document.getElementById('terminal');
    this.terminalContainer = document.getElementById('terminalContainer');
  }

  async loadXterm() {
    try {
      const [xtermModule, fitModule, webLinksModule] = await Promise.all([
        import('/xterm/lib/xterm.mjs'),
        import('/xterm-addon-fit/lib/addon-fit.mjs'),
        import('/xterm-addon-web-links/lib/addon-web-links.mjs')
      ]);
      this.Terminal = xtermModule.Terminal;
      this.FitAddon = fitModule.FitAddon;
      this.WebLinksAddon = webLinksModule.WebLinksAddon;
      this.xtermLoaded = true;
      this.log.info('xterm loaded');
      for (const cb of this._readyCallbacks) cb();
      this._readyCallbacks = [];
    } catch (err) {
      this.log.error('Failed to load xterm:', err);
    }
  }

  onReady(fn) {
    if (this.xtermLoaded) {
      fn();
    } else {
      this._readyCallbacks.push(fn);
    }
  }

  requestTemplates() {
    this.app.wsClient.send({ type: 'terminal_templates' });
  }

  onTemplates(templates) {
    this.templates = templates || [];
  }

  showTemplatePicker(directory, projectId) {
    if (this.templates.length === 0) {
      this.requestTemplates();
      this._pendingPickerDirectory = directory;
      this._pendingPickerProjectId = projectId || '';
      return;
    }
    this._showPickerUI(directory, projectId);
  }

  _showPickerUI(directory, projectId) {
    const existing = document.getElementById('terminal-template-picker');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'terminal-template-picker';
    overlay.className = 'modal-overlay';

    overlay.innerHTML = `
      <div class="modal" style="max-width: 400px;">
        <div class="modal-header">
          <h3>New Terminal</h3>
          <button class="modal-close" id="templatePickerClose">&times;</button>
        </div>
        <div class="modal-body" style="padding: 0;">
          <div id="templateList" class="template-list"></div>
        </div>
      </div>
    `;

    // Build template buttons safely using DOM APIs (no innerHTML with user data).
    const list = overlay.querySelector('#templateList');
    for (const t of this.templates) {
      const btn = document.createElement('button');
      btn.className = 'template-item';
      btn.dataset.templateId = t.id;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'template-icon';
      iconSpan.innerHTML = this._iconForTemplate(t); // SVG literals, not user data

      const info = document.createElement('div');
      info.className = 'template-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'template-name';
      nameDiv.textContent = t.name;
      const descDiv = document.createElement('div');
      descDiv.className = 'template-desc';
      descDiv.textContent = t.description || '';
      info.appendChild(nameDiv);
      info.appendChild(descDiv);

      btn.appendChild(iconSpan);
      btn.appendChild(info);
      btn.addEventListener('click', () => {
        overlay.remove();
        this.createTerminal(t.id, directory, projectId);
      });
      list.appendChild(btn);
    }

    document.body.appendChild(overlay);

    overlay.querySelector('#templatePickerClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  _iconForTemplate(t) {
    switch (t.icon || t.id) {
      case 'claude-code': return '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>';
      case 'shell': return '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3l5 5-5 5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="8" y1="13" x2="14" y2="13" stroke="currentColor" stroke-width="1.5"/></svg>';
      default: return '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1" fill="none"/><path d="M4 6l3 2-3 2" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
    }
  }

  createTerminal(templateId, directory, projectId) {
    this.app.wsClient.send({
      type: 'terminal_create',
      templateId,
      directory: directory || '',
      // projectId lets relay resolve a project-scoped token for the PTY,
      // validated against the project's directory; empty is token-free.
      projectId: projectId || '',
      cols: 80,
      rows: 24
    });
  }

  createXtermInstance() {
    const settings = this.app.settings;
    const bgColor = settings.get('bgPrimary');
    const fgColor = settings.get('textPrimary');
    const fontStack = settings.getTerminalFontStack();
    const fontSize = settings.get('fontSize');
    const light = settings.isLight();

    const term = new this.Terminal({
      theme: {
        background: bgColor,
        foreground: fgColor,
        cursor: fgColor,
        cursorAccent: bgColor,
        selectionBackground: light ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.3)',
        black: '#000000',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#4d4d4d',
        brightRed: '#ff6e67',
        brightGreen: '#5af78e',
        brightYellow: '#f4f99d',
        brightBlue: '#caa9fa',
        brightMagenta: '#ff92d0',
        brightCyan: '#9aedfe',
        brightWhite: '#e6e6e6'
      },
      fontFamily: fontStack,
      fontSize: fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true
    });

    const fitAddon = new this.FitAddon();
    const webLinksAddon = new this.WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    this.registerGeneratedImageLinks(term);

    return { term, fitAddon };
  }

  // WebLinksAddon only linkifies http(s):// URLs, and xterm can't inline images,
  // so a CLI that prints a relative /api/generated/<file> token would otherwise
  // leave a dead string; this makes it clickable against Eve's own origin.
  // Matching is per visual row — a token wrapped across rows won't be
  // detected, which is acceptable since these URLs are short.
  registerGeneratedImageLinks(term) {
    if (typeof term.registerLinkProvider !== 'function') return;
    term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        // GENERATED_IMAGE_RE is a shared global-flag regex; reset lastIndex
        // or matches silently stop after the first call.
        GENERATED_IMAGE_RE.lastIndex = 0;
        const links = [];
        let m;
        while ((m = GENERATED_IMAGE_RE.exec(text)) !== null) {
          const url = m[0];
          links.push({
            text: url,
            // xterm link ranges are 1-based, end-inclusive.
            range: { start: { x: m.index + 1, y }, end: { x: m.index + url.length, y } },
            activate: () => this.app.messageRenderer?.openImageFullscreen(url, 'Generated image'),
          });
        }
        callback(links.length ? links : undefined);
      },
    });
  }

  // relayLLM auto-joins the creator, so no separate join_terminal is needed.
  onTerminalCreated(terminalId, templateId, name, directory) {
    this.setupTerminal(terminalId, templateId, name, directory, false);
    this.app.bus.emit(EVT.TERMINAL_LIST);
  }

  // By the time terminal_joined arrives, the PTY size is guaranteed to match
  // our xterm grid: fresh terminals are created at our requested cols/rows,
  // and every terminal_reconnect carries the grid xterm currently has — fitted
  // first when the pane is being shown — so relayLLM resizes the PTY before
  // capturing scrollback. Never resize during replay — that's what produced
  // the duplicate-screen bug.
  onTerminalJoined(data) {
    const terminalId = data.terminalId;
    let terminal = this.terminals.get(terminalId);

    // Fallback for terminal_joined arriving without prior setup.
    if (!terminal) {
      this.setupTerminal(terminalId, data.templateId, data.name, data.directory, data.state === 'stopped');
      this.app.bus.emit(EVT.TERMINAL_LIST);
      terminal = this.terminals.get(terminalId);
      if (terminal && Number.isInteger(data.cols) && data.cols > 0 &&
          Number.isInteger(data.rows) && data.rows > 0) {
        terminal.term.resize(data.cols, data.rows);
      }
    }
    if (!terminal) return;

    if (data.scrollback) {
      const bytes = this._decodeBase64(data.scrollback);
      if (bytes.length > 0) {
        // A join always replays the full scrollback. Re-joining a pane that is
        // already showing that content would stack a second copy underneath
        // the first, so clear the grid before the replay lands.
        if (terminal.replayPending) terminal.term.reset();
        terminal.term.write(new Uint8Array(bytes));
      }
    }
    terminal.replayPending = false;
  }

  showTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    this.activeTerminalId = terminalId;

    for (const t of this.terminals.values()) {
      t.container.style.display = 'none';
    }

    terminal.container.style.display = 'block';

    requestAnimationFrame(() => {
      terminal.fitAddon.fit();
      terminal.term.focus();

      this._resumeRenderer(terminal.term);

      // Now that xterm has measured itself against the visible container, tell
      // relayLLM to size the PTY to match before it sends scrollback — keeps
      // PTY, grid, and replayed bytes at the same dimensions so no
      // SIGWINCH-driven repaint lands on an already-rendered screen.
      this._sendReconnect(terminalId);
    });

    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    this.resizeHandler = () => {
      if (this.activeTerminalId === terminalId) {
        terminal.fitAddon.fit();
      }
    };
    window.addEventListener('resize', this.resizeHandler);
  }

  // relayLLM forwards terminal_output only to connections it has registered as
  // viewers, but it accepts terminal_input for any terminal by id from any
  // connection. A browser reconnect builds a whole new upstream connection
  // whose viewer set is empty, so an already-open pane keeps accepting
  // keystrokes into the live PTY and never receives another byte back. That
  // reads as "the UI froze", and only a reload clears it — a reload rebuilds
  // this.terminals from empty, which is the one path that re-joins. Marking
  // them here makes onTerminalList/showTerminal re-join instead. No-op on the
  // first connect, when nothing is open yet.
  markTerminalsForRejoin() {
    for (const terminal of this.terminals.values()) {
      if (!terminal.exited) terminal.needsReconnect = true;
    }
  }

  _sendReconnect(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || !terminal.needsReconnect) return;
    terminal.needsReconnect = false;
    terminal.replayPending = true;
    this.app.wsClient.send({
      type: 'terminal_reconnect',
      terminalId,
      cols: terminal.term.cols,
      rows: terminal.term.rows,
    });
  }

  onTerminalOutput(terminalId, data) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      const bytes = this._decodeBase64(data);
      terminal.term.write(new Uint8Array(bytes));
    }
  }

  onTerminalExit(terminalId, exitCode) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this._flushTerminalInput(terminalId);
      terminal.exited = true;
    }
    const at = this.allTerminals.get(terminalId);
    if (at) at.state = 'stopped';
    this.app.bus.emit(EVT.TERMINAL_LIST);
  }

  closeTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this._flushTerminalInput(terminalId);
      if (terminal.resizeTimer) { clearTimeout(terminal.resizeTimer); terminal.resizeTimer = null; }
      this.app.wsClient.send({ type: 'terminal_close', terminalId });

      terminal.container.remove();
      terminal.term.dispose();
      this.terminals.delete(terminalId);
      this.allTerminals.delete(terminalId);
      this.app.bus.emit(EVT.TERMINAL_LIST);

      if (this.activeTerminalId === terminalId) {
        this.activeTerminalId = null;
        if (this.resizeHandler) {
          window.removeEventListener('resize', this.resizeHandler);
          this.resizeHandler = null;
        }
      }
    }
  }

  requestTerminalList() {
    this.app.wsClient.send({ type: 'terminal_list' });
  }

  onTerminalList(terminalList) {
    this.allTerminals.clear();
    if (terminalList && terminalList.length > 0) {
      for (const t of terminalList) {
        this.allTerminals.set(t.id, t);
        if (!this.terminals.has(t.id)) {
          this.reconnectTerminal(t.id, t.templateId, t.name, t.directory, t.state === 'stopped');
        } else if (t.id === this.activeTerminalId) {
          // Being in the list proves it's still resident upstream, so this
          // can't draw a "terminal not found" error. Hidden panes wait for
          // showTerminal, which fits them against a real viewport first.
          this._sendReconnect(t.id);
        }
      }
    }
    this.app.bus.emit(EVT.TERMINAL_LIST);
  }

  reconnectTerminal(terminalId, templateId, name, directory, exited) {
    // terminal_reconnect is deferred until showTerminal so xterm can fit()
    // against the visible container first and report the real viewport size.
    this.setupTerminal(terminalId, templateId, name, directory, exited, /* needsReconnect */ true);
  }

  setupTerminal(terminalId, templateId, name, directory, exited, needsReconnect = false) {
    if (!this.xtermLoaded) {
      this.log.error('xterm not loaded yet');
      return;
    }

    if (this.terminals.has(terminalId)) return;

    const { term, fitAddon } = this.createXtermInstance();

    const containerDiv = document.createElement('div');
    containerDiv.className = 'terminal-instance';
    containerDiv.style.display = 'none';
    this.terminalContainer.appendChild(containerDiv);

    term.open(containerDiv);
    this._attachTouchScroll(containerDiv, term);

    this.terminals.set(terminalId, {
      term,
      fitAddon,
      container: containerDiv,
      directory,
      templateId,
      name,
      exited: !!exited,
      needsReconnect: !!needsReconnect,
      replayPending: false,
      inputBuf: '',
      inputTimer: null,
      pendingResize: null,
      resizeTimer: null,
    });
    this.allTerminals.set(terminalId, {
      id: terminalId, templateId, name, directory,
      state: exited ? 'stopped' : 'running'
    });

    // A modifier fold flushes immediately so a chord (^C, Option+x) is never
    // merged behind a following plain key. Concatenation stays byte-correct
    // because transformInput folds the one-shot modifier over its own chunk's
    // first byte, and _encodeBase64(a+b) equals base64 of a+b's UTF-8 bytes.
    term.onData((data) => {
      const terminal = this.terminals.get(terminalId);
      if (!terminal || terminal.exited) return;
      const out = this.keybar ? this.keybar.transformInput(data) : data;
      const folded = this.keybar && out !== data;
      terminal.inputBuf += out;
      if (folded) { this._flushTerminalInput(terminalId); return; }
      if (!terminal.inputTimer) {
        terminal.inputTimer = setTimeout(() => this._flushTerminalInput(terminalId), 12);
      }
    });

    term.onResize(({ cols, rows }) => {
      const terminal = this.terminals.get(terminalId);
      if (!terminal) return;
      // The mobile soft keyboard spams resize via fitActive().
      terminal.pendingResize = { cols, rows };
      if (terminal.resizeTimer) clearTimeout(terminal.resizeTimer);
      terminal.resizeTimer = setTimeout(() => {
        terminal.resizeTimer = null;
        const r = terminal.pendingResize;
        terminal.pendingResize = null;
        if (r) {
          this.app.wsClient.send({ type: 'terminal_resize', terminalId, cols: r.cols, rows: r.rows });
        }
      }, 120);
    });

    const label = name || templateId || 'Terminal';
    this.app.tabManager.openTerminal(terminalId, label, directory);
  }

  // xterm.js doesn't translate a touch drag into scrollback — the
  // `.xterm-screen` overlay swallows the gesture, and in this version
  // `.xterm-viewport` isn't a native scroll container (scrollHeight ===
  // clientHeight), so adjusting scrollTop does nothing. Drive scrollLines()
  // from accumulated drag pixels instead.
  _attachTouchScroll(containerDiv, term) {
    let cellHeight = 0;
    let lastY = 0;
    let accum = 0;

    containerDiv.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const viewport = containerDiv.querySelector('.xterm-viewport');
      const rows = term.rows || 1;
      cellHeight = viewport ? viewport.clientHeight / rows : 0;
      lastY = e.touches[0].clientY;
      accum = 0;
    }, { passive: true });

    containerDiv.addEventListener('touchmove', (e) => {
      if (!cellHeight || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      accum += y - lastY;
      lastY = y;
      const steps = Math.trunc(accum / cellHeight);
      if (steps !== 0) {
        term.scrollLines(-steps); // drag down (steps > 0) scrolls up into history
        accum -= steps * cellHeight;
        e.preventDefault();
      }
    }, { passive: false });
  }

  // Called by the dispatcher on a task_started broadcast, which arrives
  // before the next terminal_list — lets openTaskTerminal pick WS attach
  // over the disk-log fallback for a terminal relayLLM already knows about.
  registerKnownTerminal(meta) {
    if (!meta?.id) return;
    if (!this.allTerminals.has(meta.id)) {
      this.allTerminals.set(meta.id, {
        id: meta.id,
        templateId: meta.templateId || '',
        name: meta.name || '',
        directory: meta.directory || '',
        state: meta.state || 'running',
      });
    }
  }

  openTaskTerminal(terminalId, opts = {}) {
    if (this.terminals.has(terminalId)) {
      this.showTerminal(terminalId);
      return;
    }
    const meta = this.allTerminals.get(terminalId);
    if (meta) {
      this.reconnectTerminal(
        terminalId,
        meta.templateId || opts.templateId || '',
        meta.name || opts.name || 'Terminal',
        meta.directory || opts.directory || '',
        meta.state === 'stopped',
      );
      this.showTerminal(terminalId);
      return;
    }
    // Not resident in relayLLM (idle timeout or relayLLM restart evicted it).
    this.viewReadOnly(terminalId, opts);
  }

  async viewReadOnly(terminalId, opts = {}) {
    if (this.terminals.has(terminalId)) {
      this.showTerminal(terminalId);
      return;
    }

    const meta = this.allTerminals.get(terminalId) || {};
    const label = opts.name || meta.name || 'Past Run';
    this.setupTerminal(terminalId, meta.templateId || '', label, meta.directory || opts.directory || '', true);
    this.showTerminal(terminalId);

    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    try {
      const bytes = await this.app.api.getTerminalLog(terminalId);
      // Chunk writes to keep xterm responsive on large logs.
      const chunkSize = 64 * 1024;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        terminal.term.write(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
    } catch (err) {
      this.log.warn('view-only: failed to fetch terminal log', err);
      terminal.term.write(`\r\n\x1b[31m[Failed to load log: ${err.message}]\x1b[0m\r\n`);
    }
  }

  _encodeBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  _decodeBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  getTerminalsForPath(projectPath) {
    if (!projectPath) return [];
    const normPath = projectPath.toLowerCase();
    const result = [];
    for (const [id, t] of this.allTerminals) {
      if (t.directory && t.directory.toLowerCase().startsWith(normPath)) {
        result.push({ ...t, id });
      }
    }
    return result;
  }

  getDetachedCountForPath(projectPath) {
    if (!projectPath) return 0;
    const normPath = projectPath.toLowerCase();
    let count = 0;
    for (const [id, t] of this.allTerminals) {
      if (t.state === 'stopped') continue;
      // Case-insensitive match for macOS
      if (t.directory && t.directory.toLowerCase().startsWith(normPath)) {
        if (!this.terminals.has(id)) {
          count++;
        }
      }
    }
    return count;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TerminalManager;
}
