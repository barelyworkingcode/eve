class TerminalManager {
  constructor(client) {
    this.client = client;
    this.terminals = new Map(); // terminalId -> { term, fitAddon, container, directory, command, exited }
    this.activeTerminalId = null;
    this.xtermLoaded = false;
    this.Terminal = null;
    this.FitAddon = null;
    this.WebLinksAddon = null;
    this.resizeHandler = null;

    this.initElements();
    this.loadXterm();
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
      console.log('xterm loaded successfully');
    } catch (err) {
      console.error('Failed to load xterm:', err);
    }
  }

  /**
   * Creates a new terminal and requests server to spawn pty
   */
  createTerminal(directory, command, args, sessionId) {
    const msg = { type: 'terminal_create', directory, command };
    if (args) msg.args = args;
    if (sessionId) msg.sessionId = sessionId;
    this.client.ws.send(JSON.stringify(msg));
  }

  /**
   * Creates xterm instance with standard configuration
   */
  createXtermInstance() {
    const term = new this.Terminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#fafafa',
        cursorAccent: '#0a0a0a',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
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
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
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
   * Called when server confirms terminal creation
   */
  onTerminalCreated(terminalId, directory, command) {
    if (!this.xtermLoaded) {
      console.error('xterm not loaded yet');
      return;
    }

    const { term, fitAddon } = this.createXtermInstance();

    // Create dedicated container for this terminal
    const containerDiv = document.createElement('div');
    containerDiv.className = 'terminal-instance';
    containerDiv.style.display = 'none';
    this.terminalContainer.appendChild(containerDiv);

    // Open terminal ONCE into its container
    term.open(containerDiv);
    fitAddon.fit();

    // Store terminal instance
    this.terminals.set(terminalId, {
      term,
      fitAddon,
      container: containerDiv,
      directory,
      command,
      exited: false
    });

    // Handle input from terminal
    term.onData((data) => {
      this.client.ws.send(JSON.stringify({
        type: 'terminal_input',
        terminalId,
        data
      }));
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      this.client.ws.send(JSON.stringify({
        type: 'terminal_resize',
        terminalId,
        cols,
        rows
      }));
    });

    // Create tab label
    const label = command === 'claude' ? 'Claude CLI' : 'Terminal';

    // Open as tab
    this.client.tabManager.openTerminal(terminalId, label, directory);
  }

  /**
   * Shows a terminal in the terminal content area
   */
  showTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    this.activeTerminalId = terminalId;

    // Hide all terminal containers
    for (const t of this.terminals.values()) {
      t.container.style.display = 'none';
    }

    // Show active terminal container
    terminal.container.style.display = 'block';

    // Fit and focus
    requestAnimationFrame(() => {
      terminal.fitAddon.fit();
      terminal.term.focus();
    });

    // Update resize handler
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
   * Handles terminal output from server
   */
  onTerminalOutput(terminalId, data) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.term.write(data);
    }
  }

  /**
   * Handles terminal exit from server
   */
  onTerminalExit(terminalId, exitCode) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.exited = true;
      // Don't write exit message here - server already added it to buffer
    }
  }

  /**
   * Closes a terminal
   */
  closeTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      // Notify server
      this.client.ws.send(JSON.stringify({
        type: 'terminal_close',
        terminalId
      }));

      // Remove container from DOM
      terminal.container.remove();

      // Dispose xterm
      terminal.term.dispose();
      this.terminals.delete(terminalId);

      if (this.activeTerminalId === terminalId) {
        this.activeTerminalId = null;
        if (this.resizeHandler) {
          window.removeEventListener('resize', this.resizeHandler);
          this.resizeHandler = null;
        }
      }
    }
  }

  /**
   * Re-fits the active terminal (call after tab switch)
   */
  refitActiveTerminal() {
    if (this.activeTerminalId) {
      const terminal = this.terminals.get(this.activeTerminalId);
      if (terminal) {
        requestAnimationFrame(() => {
          terminal.fitAddon.fit();
          terminal.term.focus();
        });
      }
    }
  }

  /**
   * Request list of existing terminals from server (for reconnection)
   */
  requestTerminalList() {
    this.client.ws.send(JSON.stringify({ type: 'terminal_list' }));
  }

  /**
   * Handle terminal list from server (for reconnection after refresh)
   */
  onTerminalList(terminalList) {
    if (!terminalList || terminalList.length === 0) return;

    for (const t of terminalList) {
      this.reconnectTerminal(t.terminalId, t.directory, t.command, t.exited);
    }
  }

  /**
   * Reconnect to an existing terminal
   */
  reconnectTerminal(terminalId, directory, command, exited) {
    if (!this.xtermLoaded) {
      console.error('xterm not loaded yet');
      return;
    }

    const { term, fitAddon } = this.createXtermInstance();

    // Create dedicated container for this terminal
    const containerDiv = document.createElement('div');
    containerDiv.className = 'terminal-instance';
    containerDiv.style.display = 'none';
    this.terminalContainer.appendChild(containerDiv);

    // Open terminal into its container
    term.open(containerDiv);

    // Store terminal instance
    this.terminals.set(terminalId, {
      term,
      fitAddon,
      container: containerDiv,
      directory,
      command,
      exited
    });

    // Handle input from terminal (only if not exited)
    term.onData((data) => {
      const terminal = this.terminals.get(terminalId);
      if (terminal && !terminal.exited) {
        this.client.ws.send(JSON.stringify({
          type: 'terminal_input',
          terminalId,
          data
        }));
      }
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      this.client.ws.send(JSON.stringify({
        type: 'terminal_resize',
        terminalId,
        cols,
        rows
      }));
    });

    // Create tab label
    const label = command === 'claude' ? 'Claude CLI' : 'Terminal';

    // Open as tab
    this.client.tabManager.openTerminal(terminalId, label, directory);

    // Request buffered output replay
    this.client.ws.send(JSON.stringify({
      type: 'terminal_reconnect',
      terminalId
    }));
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TerminalManager;
}
