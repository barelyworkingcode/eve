class TerminalManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.log = container.get('logger').child('Terminal');
    this.terminals = new Map(); // terminalId -> { term, fitAddon, container, directory, templateId, name, exited }
    this.allTerminals = new Map(); // terminalId -> { id, templateId, name, directory, state } — all known from relayLLM
    this.activeTerminalId = null;
    this.xtermLoaded = false;
    this.Terminal = null;
    this.FitAddon = null;
    this.WebLinksAddon = null;
    this.resizeHandler = null;
    this._readyCallbacks = [];
    this.templates = []; // cached terminal templates from relayLLM

    this.initElements();
    this.loadXterm();
    this._listenForSettingsChanges();
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

  /**
   * Request available terminal templates from relayLLM.
   */
  requestTemplates() {
    this.app.wsClient.send({ type: 'terminal_templates' });
  }

  /**
   * Handle terminal_templates response from relayLLM.
   */
  onTemplates(templates) {
    this.templates = templates || [];
  }

  /**
   * Show a picker to select a terminal template and launch it.
   */
  showTemplatePicker(directory) {
    if (this.templates.length === 0) {
      // Fetch templates first, then show picker.
      this.requestTemplates();
      this._pendingPickerDirectory = directory;
      return;
    }
    this._showPickerUI(directory);
  }

  _showPickerUI(directory) {
    // Remove any existing picker.
    const existing = document.getElementById('terminal-template-picker');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'terminal-template-picker';
    overlay.className = 'modal-overlay';

    // Build modal shell (static content only).
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
        this.createTerminal(t.id, directory);
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

  /**
   * Creates a new terminal via relayLLM.
   */
  createTerminal(templateId, directory) {
    this.app.wsClient.send({
      type: 'terminal_create',
      templateId,
      directory: directory || '',
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

    return { term, fitAddon };
  }

  /**
   * Called when relayLLM confirms terminal creation (sent only to creator).
   * Server auto-joins the creator, so no join_terminal needed.
   */
  onTerminalCreated(terminalId, templateId, name, directory) {
    this.setupTerminal(terminalId, templateId, name, directory, false);
    this.app.bus.emit(EVT.TERMINAL_LIST);
  }

  /**
   * Called when we successfully join a terminal (with scrollback).
   */
  onTerminalJoined(data) {
    const terminalId = data.terminalId;
    let terminal = this.terminals.get(terminalId);

    // Reconnect case: terminal isn't set up yet.
    if (!terminal) {
      this.setupTerminal(terminalId, data.templateId, data.name, data.directory, data.state === 'stopped');
      this.app.bus.emit(EVT.TERMINAL_LIST);
      terminal = this.terminals.get(terminalId);
    }
    if (!terminal) return;

    // Match xterm's grid to the PTY before replaying scrollback so ANSI
    // cursor positions in the captured bytes resolve against the right size.
    if (Number.isInteger(data.cols) && data.cols > 0 &&
        Number.isInteger(data.rows) && data.rows > 0) {
      terminal.term.resize(data.cols, data.rows);
    }

    if (data.scrollback) {
      const bytes = this._decodeBase64(data.scrollback);
      if (bytes.length > 0) {
        terminal.term.write(new Uint8Array(bytes));
      }
    }
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

  /**
   * Handles terminal output from relayLLM (base64-encoded).
   */
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
      terminal.exited = true;
    }
    const at = this.allTerminals.get(terminalId);
    if (at) at.state = 'stopped';
    this.app.bus.emit(EVT.TERMINAL_LIST);
  }

  closeTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
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

  /**
   * Handle terminal list from relayLLM (for reconnection after refresh).
   */
  onTerminalList(terminalList) {
    // Track all known terminals for sidebar and badge counts.
    this.allTerminals.clear();
    if (terminalList && terminalList.length > 0) {
      for (const t of terminalList) {
        this.allTerminals.set(t.id, t);
        if (!this.terminals.has(t.id)) {
          this.reconnectTerminal(t.id, t.templateId, t.name, t.directory, t.state === 'stopped');
        }
      }
    }
    this.app.bus.emit(EVT.TERMINAL_LIST);
  }

  reconnectTerminal(terminalId, templateId, name, directory, exited) {
    this.setupTerminal(terminalId, templateId, name, directory, exited);

    // Request scrollback replay via reconnect.
    this.app.wsClient.send({ type: 'terminal_reconnect', terminalId });
  }

  setupTerminal(terminalId, templateId, name, directory, exited) {
    if (!this.xtermLoaded) {
      this.log.error('xterm not loaded yet');
      return;
    }

    // Don't create duplicate terminals.
    if (this.terminals.has(terminalId)) return;

    const { term, fitAddon } = this.createXtermInstance();

    const containerDiv = document.createElement('div');
    containerDiv.className = 'terminal-instance';
    containerDiv.style.display = 'none';
    this.terminalContainer.appendChild(containerDiv);

    term.open(containerDiv);

    this.terminals.set(terminalId, {
      term,
      fitAddon,
      container: containerDiv,
      directory,
      templateId,
      name,
      exited: !!exited
    });
    this.allTerminals.set(terminalId, {
      id: terminalId, templateId, name, directory,
      state: exited ? 'stopped' : 'running'
    });

    // Send input as base64 to relayLLM.
    term.onData((data) => {
      const terminal = this.terminals.get(terminalId);
      if (terminal && !terminal.exited) {
        this.app.wsClient.send({
          type: 'terminal_input',
          terminalId,
          data: this._encodeBase64(data)
        });
      }
    });

    term.onResize(({ cols, rows }) => {
      this.app.wsClient.send({
        type: 'terminal_resize',
        terminalId,
        cols,
        rows
      });
    });

    const label = name || templateId || 'Terminal';
    this.app.tabManager.openTerminal(terminalId, label, directory);
  }

  /**
   * Note a terminal that exists in relayLLM but isn't (yet) in our
   * allTerminals map. Used by the dispatcher when a scheduled PTY task
   * fires — we learn about the new terminalId via the task_started
   * broadcast before the next terminal_list arrives, and openTaskTerminal
   * needs to know the session is alive so it picks WS attach over the
   * disk-log fallback.
   */
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

  /**
   * Open a task's terminal output. The right entry point for TaskViewer's
   * "readonly" renderer — picks live WS attach when relayLLM still has the
   * session in memory, falls back to a disk-log replay otherwise. Either
   * way the user lands in an xterm tab.
   */
  openTaskTerminal(terminalId, opts = {}) {
    // Already attached in this Eve instance.
    if (this.terminals.has(terminalId)) {
      this.showTerminal(terminalId);
      return;
    }
    // Known to relayLLM (running or recently stopped, still resident).
    // reconnectTerminal sends a WS terminal_reconnect which streams
    // scrollback + any continued output.
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
    // Session has been evicted from memory (idle timeout or relayLLM
    // restart). Replay the on-disk byte stream instead.
    this.viewReadOnly(terminalId, opts);
  }

  /**
   * Open a read-only terminal tab and replay a completed (or live) PTY's
   * captured byte stream via the on-disk log file. Used by "View Last Run"
   * on scheduled PTY tasks. The fetched bytes pass through xterm.js so
   * ANSI escape codes (colors, cursor moves) render the same as they did
   * during the original run.
   */
  async viewReadOnly(terminalId, opts = {}) {
    // If we're already attached to this terminal in this tab, just focus.
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
      // Chunk writes to keep xterm responsive on large logs (~1MB cap).
      const chunkSize = 64 * 1024;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        terminal.term.write(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
    } catch (err) {
      this.log.warn('view-only: failed to fetch terminal log', err);
      terminal.term.write(`\r\n\x1b[31m[Failed to load log: ${err.message}]\x1b[0m\r\n`);
    }
  }

  /**
   * Encode a string to base64 (handles unicode properly).
   */
  _encodeBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  /**
   * Decode base64 to a byte array.
   */
  _decodeBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Return all terminals whose directory falls under a project path.
   */
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

  /**
   * Count running terminals for a project path that aren't currently in a tab.
   */
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

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TerminalManager;
}
