class TerminalManager {
  constructor(client) {
    this.client = client;
    this.terminals = new Map(); // terminalId -> { term, fitAddon, container }
    this.activeTerminalId = null;
    this.xtermLoaded = false;
    this.Terminal = null;
    this.FitAddon = null;
    this.WebLinksAddon = null;

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
  createTerminal(directory, command) {
    this.client.ws.send(JSON.stringify({
      type: 'terminal_create',
      directory,
      command
    }));
  }

  /**
   * Called when server confirms terminal creation
   */
  onTerminalCreated(terminalId, directory, command) {
    if (!this.xtermLoaded) {
      console.error('xterm not loaded yet');
      return;
    }

    // Create xterm instance
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

    // Store terminal instance
    this.terminals.set(terminalId, {
      term,
      fitAddon,
      directory,
      command
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

    // Clear container and attach terminal
    this.terminalContainer.innerHTML = '';
    terminal.term.open(this.terminalContainer);

    // Fit terminal to container
    requestAnimationFrame(() => {
      terminal.fitAddon.fit();
      terminal.term.focus();
    });

    // Handle window resize
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
      terminal.term.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
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

      // Dispose xterm
      terminal.term.dispose();
      this.terminals.delete(terminalId);

      if (this.activeTerminalId === terminalId) {
        this.activeTerminalId = null;
        window.removeEventListener('resize', this.resizeHandler);
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
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TerminalManager;
}
