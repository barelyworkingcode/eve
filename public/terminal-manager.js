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

    // A host coming back is when its persistent sessions become reachable.
    if (typeof EVT !== 'undefined' && EVT.HOST_STATUS) {
      this.app.bus?.on?.(EVT.HOST_STATUS, ({ hostId } = {}) => this._onHostStatusForReattach(hostId));
    }
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
      await this._loadClipboardAddon();
      this.xtermLoaded = true;
      this.log.info('xterm loaded');
      for (const cb of this._readyCallbacks) cb();
      this._readyCallbacks = [];
    } catch (err) {
      this.log.error('Failed to load xterm:', err);
    }
  }

  // Optional: without it, OSC 52 copies (tmux copy-mode, Claude Code) are
  // dropped, but the terminal itself still works.
  async _loadClipboardAddon() {
    try {
      const mod = await import('/xterm-addon-clipboard/lib/addon-clipboard.mjs');
      this.ClipboardAddon = mod.ClipboardAddon;
    } catch (err) {
      this.ClipboardAddon = null;
      this.log.warn('Clipboard addon failed to load; OSC 52 copy disabled:', err?.message || err);
    }
  }

  // Write-only OSC 52: a program on the host may set the browser clipboard
  // but never read it back (a `?` query answers empty), or anything running
  // over ssh could exfiltrate whatever the user last copied.
  _clipboardProvider() {
    return {
      readText: () => '',
      writeText: (_selection, text) => this._writeClipboard(text),
    };
  }

  _writeClipboard(text) {
    if (!text || !navigator.clipboard?.writeText) return;
    return navigator.clipboard.writeText(text).catch((err) => {
      this.log.warn('Clipboard write refused:', err?.message || err);
    });
  }

  // Copy on select, iTerm-style. Called from mouseup/dblclick directly (not
  // from onSelectionChange, which fires on every drag step) so the write
  // stays inside the user gesture Safari requires.
  _copySelection(term) {
    if (term.hasSelection()) this._writeClipboard(term.getSelection());
  }

  onReady(fn) {
    if (this.xtermLoaded) {
      fn();
    } else {
      this._readyCallbacks.push(fn);
    }
  }

  // The template catalog is relay's own (GET /api/terminal/templates,
  // cmd/relay/template_routes.go) — not relay-sessions', and never was a
  // session-host WS concern. This used to round-trip over the shared
  // session-host WebSocket (`terminal_templates`), which relay-sessions
  // never actually mounted a handler for: the request went out, nothing
  // ever answered it, and showTemplatePicker's "still empty, keep waiting"
  // branch never got un-stuck — exactly the hang the Shell Launcher's "New"
  // tab was stuck on. HTTP, through the same api-client method
  // task-dialog.js already uses, has no such gap: it either resolves or
  // rejects.
  async requestTemplates(projectId) {
    if (this._templatesLoading === projectId) return;
    this._templatesLoading = projectId;
    try {
      const list = await this.app.api.getTerminalTemplates(projectId);
      this.onTemplates(Array.isArray(list) ? list : [], projectId);
    } catch (err) {
      this.log.error('Failed to load terminal templates:', err);
      this.onTemplates([], projectId);
    } finally {
      this._templatesLoading = undefined;
    }
  }

  onTemplates(templates, projectId) {
    this.templates = templates || [];
    // The shared store is what the home tiles, the shell launcher and the
    // task dialog read; it is tagged with the project the list is for.
    this.app.state?.setTerminalTemplates?.(this.templates, projectId || null);
    if (this._pendingPickerDirectory !== undefined) {
      const directory = this._pendingPickerDirectory;
      const projectId = this._pendingPickerProjectId;
      this._pendingPickerDirectory = undefined;
      this._pendingPickerProjectId = undefined;
      this._showPickerUI(directory, projectId);
    }
  }

  // The catalog is per project (relay lists only what the project may
  // launch), so it is fetched on every open rather than cached.
  showTemplatePicker(directory, projectId) {
    this._pendingPickerDirectory = directory;
    this._pendingPickerProjectId = projectId || '';
    this.requestTemplates(projectId);
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

    // Host projects: persistent sessions left running on the host, above the
    // templates so a returning user sees them first.
    const project = this.app.state?.getProject?.(projectId);
    if (project?.host && typeof RemoteSessionsSection === 'function') {
      const section = new RemoteSessionsSection({
        api: this.app.api,
        bus: this.app.bus,
        state: this.app.state,
        modalManager: this.app.modalManager,
        projectId,
        onReattach: (s) => {
          overlay.remove();
          this.createTerminal(s.template_id, directory, projectId, s.name);
        },
      });
      section.el.classList.add('remote-sessions--picker');
      list.parentNode.insertBefore(section.el, list);
      section.refresh();
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

  // persistSession reattaches to a named tmux session on a host project.
  createTerminal(templateId, directory, projectId, persistSession) {
    this.app.wsClient.send({
      type: 'terminal_create',
      templateId,
      ...(persistSession ? { persistSession } : {}),
      directory: directory || '',
      // projectId is required: relay permits a template per project and
      // resolves the project's token for the PTY, validated against the
      // project's directory.
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
      // A TUI with mouse reporting on (Claude Code, tmux) takes every drag, so
      // nothing can be selected. Option-drag forces a local selection on Mac;
      // Shift-drag already does elsewhere.
      macOptionClickForcesSelection: true,
      allowProposedApi: true
    });

    const fitAddon = new this.FitAddon();
    const webLinksAddon = new this.WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    if (this.ClipboardAddon) {
      term.loadAddon(new this.ClipboardAddon(undefined, this._clipboardProvider()));
    }

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
  // host ({id,name}) is present when relayLLM resolved the session onto an
  // SSH host (../relay/docs/ssh-hosts.md); undefined for a console terminal.
  onTerminalCreated(terminalId, templateId, name, directory, host) {
    const auto = this._autoReattachPending?.get(name);
    if (auto) {
      clearTimeout(auto.timer);
      this._autoReattachPending.delete(name);
      // Relay now reports it attached_here; let open Remote sessions lists catch up.
      this.app.bus.emit(EVT.PERSISTENT_SESSIONS_CHANGED, { projectId: auto.projectId });
    }
    this.setupTerminal(terminalId, templateId, name, directory, false, false, host, !auto || auto.focus);
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
      this.setupTerminal(terminalId, data.templateId, data.name, data.directory, data.state === 'stopped', false, data.host);
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
  // them here makes onTerminalList/showTerminal re-join instead.
  //
  // `onlyIds` scopes the marking to terminals that existed when the socket
  // opened. The caller runs after async project/session loads, and a terminal
  // created inside that window is already a viewer on the new socket —
  // relayLLM auto-joins the creator — so re-joining it would send a spurious
  // terminal_reconnect and a second replay. null marks everything (used for
  // an upstream-only relay reconnect, where every viewer set was lost).
  markTerminalsForRejoin(onlyIds = null) {
    for (const [id, terminal] of this.terminals) {
      if (terminal.exited) continue;
      if (onlyIds && !onlyIds.has(id)) continue;
      terminal.needsReconnect = true;
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
          this.reconnectTerminal(t.id, t.templateId, t.name, t.directory, t.state === 'stopped', t.host);
        } else if (t.id === this.activeTerminalId) {
          // Being in the list proves it's still resident upstream, so this
          // can't draw a "terminal not found" error. Hidden panes wait for
          // showTerminal, which fits them against a real viewport first.
          this._sendReconnect(t.id);
        }
      }
    }
    this.app.bus.emit(EVT.TERMINAL_LIST);
    this._autoReattachHostProjects?.();
  }

  // After a relay restart relay-sessions has forgotten its terminals, so
  // terminal_list comes back empty while the persistent (tmux) sessions still
  // run on the host (attached_here false). Reattach each one no open eve
  // terminal already holds (a persist terminal's name is its tmux session
  // name), in the background — unless no terminal is active, in which case the
  // first one takes focus. One run per project at a time; a session stays
  // pending until its terminal_created lands so a second run can't double it;
  // that landing also refreshes any open Remote sessions list.
  async autoReattachPersistentSessions(projectId) {
    this._autoReattachRunning ||= new Set();
    this._autoReattachPending ||= new Map();
    const project = this.app.state?.getProject?.(projectId);
    if (!project?.host || this._autoReattachRunning.has(projectId)) return;
    this._autoReattachRunning.add(projectId);
    try {
      let sessions;
      try {
        sessions = await this.app.api.getPersistentSessions(projectId);
      } catch (err) {
        // 404 not a host project, 409 no tmux, 502 host unreachable: nothing to do.
        const quiet = [404, 409, 502].includes(err?.status);
        this.log[quiet ? 'debug' : 'warn'](`Auto-reattach: listing persistent sessions for ${projectId} failed: ${err?.message || err}`);
        return;
      }
      // A pane relay no longer lists (stale after a restart) or that has exited
      // doesn't count as holding the session.
      const open = new Set();
      for (const [id, t] of this.terminals) {
        if (!t.exited && this.allTerminals.has(id)) open.add(t.name);
      }
      let focus = !this.activeTerminalId;
      let started = 0;
      for (const s of Array.isArray(sessions) ? sessions : []) {
        if (s.attached_here !== false || !s.name) continue;
        if (open.has(s.name) || this._autoReattachPending.has(s.name)) continue;
        // A create relay refuses never yields terminal_created; let it retry later.
        const timer = setTimeout(() => this._autoReattachPending.delete(s.name), 30000);
        timer?.unref?.();
        this._autoReattachPending.set(s.name, { focus, timer, projectId });
        focus = false;
        this.createTerminal(s.template_id, project.path, projectId, s.name);
        started++;
      }
      if (started) this.log.info(`Auto-reattaching ${started} persistent session(s) for ${projectId}`);
    } finally {
      this._autoReattachRunning.delete(projectId);
    }
  }

  // hostId null (a full hosts refresh) means every host project.
  _autoReattachHostProjects(hostId = null) {
    const projects = this.app.state?.projects?.values?.() || [];
    for (const p of projects) {
      if (!p.host || (hostId && p.host.id !== hostId)) continue;
      this.autoReattachPersistentSessions(p.id);
    }
  }

  _onHostStatusForReattach(hostId) {
    this._hostStatusSeen ||= new Map();
    const hostIds = hostId ? [hostId] : [...(this.app.state?.hosts?.keys?.() || [])];
    for (const id of hostIds) {
      const status = this.app.state?.hostStatus?.(id);
      const prev = this._hostStatusSeen.get(id);
      this._hostStatusSeen.set(id, status);
      if (status === 'connected' && prev !== 'connected') this._autoReattachHostProjects(id);
    }
  }

  // xterm forwards only text, and a CLI on an SSH host reads that host's
  // clipboard, never the browser's. So a pasted or dropped image is saved to
  // a temp file where the terminal runs and its path is pasted instead —
  // Claude Code attaches a pasted image path as [Image #n]. The paste
  // listener is capture-phase so it runs before xterm's own textarea handler;
  // text-only pastes fall through to xterm untouched.
  _attachImagePaste(containerDiv, terminalId) {
    containerDiv.addEventListener('paste', (e) => {
      const images = this._imageFilesFrom(e.clipboardData);
      if (!images.length) return;
      e.preventDefault();
      e.stopPropagation();
      this._pasteImages(terminalId, images);
    }, true);
    containerDiv.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes?.('Files')) e.preventDefault();
    });
    containerDiv.addEventListener('drop', (e) => {
      const images = this._imageFilesFrom(e.dataTransfer);
      if (!images.length) return;
      e.preventDefault();
      this._pasteImages(terminalId, images);
    });
  }

  _imageFilesFrom(dataTransfer) {
    const files = [];
    for (const item of dataTransfer?.items || []) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }

  async _pasteImages(terminalId, files) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.exited) return;
    const paths = [];
    for (const file of files) {
      try {
        const { path } = await this.app.api.pasteTerminalImage(file, terminal.host?.id);
        paths.push(path);
      } catch (err) {
        this.log.error('Terminal image paste failed:', err?.message || err);
        this.app.messageRenderer?.appendSystemMessage?.(`Image paste failed: ${err?.message || err}`, 'error');
      }
    }
    // The tab may have closed while the upload was in flight.
    if (!paths.length || this.terminals.get(terminalId) !== terminal) return;
    terminal.term.paste(paths.join(' '));
  }

  reconnectTerminal(terminalId, templateId, name, directory, exited, host) {
    // terminal_reconnect is deferred until showTerminal so xterm can fit()
    // against the visible container first and report the real viewport size.
    this.setupTerminal(terminalId, templateId, name, directory, exited, /* needsReconnect */ true, host);
  }

  // host ({id,name}) is present for a terminal opened on an SSH host
  // (../relay/docs/ssh-hosts.md); the tab title becomes "<host.name> · <name>"
  // and the raw object is stored on both terminal records so the sidebar
  // (someone else's file) can read `terminal.host`.
  // activate=false opens the tab without switching to it.
  setupTerminal(terminalId, templateId, name, directory, exited, needsReconnect = false, host = null, activate = true) {
    // A terminal_created can reach the browser before xterm's async imports
    // finish; queue the setup rather than drop the terminal.
    if (!this.xtermLoaded) {
      this.onReady(() => this.setupTerminal(terminalId, templateId, name, directory, exited, needsReconnect, host, activate));
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
    this._attachImagePaste(containerDiv, terminalId);
    containerDiv.addEventListener('mouseup', () => this._copySelection(term));
    containerDiv.addEventListener('dblclick', () => this._copySelection(term));

    this.terminals.set(terminalId, {
      term,
      fitAddon,
      container: containerDiv,
      directory,
      templateId,
      name,
      host: host || null,
      exited: !!exited,
      needsReconnect: !!needsReconnect,
      replayPending: false,
      inputBuf: '',
      inputTimer: null,
      pendingResize: null,
      resizeTimer: null,
    });
    this.allTerminals.set(terminalId, {
      id: terminalId, templateId, name, directory, host: host || null,
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

    // A persist terminal's name is relay's tmux session name; the tab shows
    // the friendly "<template> #n" and keeps the full name as its tooltip.
    const withHost = (text) => (host ? `${host.name} · ${text}` : text);
    const friendly = typeof persistSessionLabel === 'function'
      ? persistSessionLabel(name, this.app.state?.terminalTemplates)
      : name;
    const label = withHost(friendly || templateId || 'Terminal');
    const title = name && friendly !== name ? withHost(name) : '';
    this.app.tabManager.openTerminal(terminalId, label, directory, { activate, title });

    // A title the program sets (OSC 0/2) wins while the terminal lives; a
    // cleared or generic console title falls back to the label above.
    term.onTitleChange?.((raw) => {
      const t = (raw || '').trim();
      const useful = t && !/\.exe$/i.test(t);
      this.app.tabManager.updateTabLabel(terminalId, useful ? withHost(t) : label);
    });
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
        host: meta.host || null,
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
        meta.host,
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
    this.setupTerminal(terminalId, meta.templateId || '', label, meta.directory || opts.directory || '', true, false, meta.host);
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

  // hostId keys the match alongside directory (../relay/docs/ssh-hosts.md):
  // two hosts can share a directory string, and a console project must not
  // pick up a host terminal that merely happens to share its path text.
  // '' (the default) means "console" — matches a terminal with no host.
  getTerminalsForPath(projectPath, hostId = '') {
    if (!projectPath) return [];
    const normPath = projectPath.toLowerCase();
    const wantHostId = hostId || '';
    const result = [];
    for (const [id, t] of this.allTerminals) {
      if ((t.host?.id || '') !== wantHostId) continue;
      if (t.directory && t.directory.toLowerCase().startsWith(normPath)) {
        result.push({ ...t, id });
      }
    }
    return result;
  }

  getDetachedCountForPath(projectPath, hostId = '') {
    if (!projectPath) return 0;
    const normPath = projectPath.toLowerCase();
    const wantHostId = hostId || '';
    let count = 0;
    for (const [id, t] of this.allTerminals) {
      if (t.state === 'stopped') continue;
      if ((t.host?.id || '') !== wantHostId) continue;
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
