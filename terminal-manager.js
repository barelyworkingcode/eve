const { v4: uuidv4 } = require('uuid');
const pty = require('node-pty');

const TERMINAL_BUFFER_SIZE = 100000; // ~100KB scrollback per terminal

class TerminalManager {
  constructor({ onLinkedSessionExit }) {
    this.terminals = new Map();
    this.onLinkedSessionExit = onLinkedSessionExit || (() => {});
  }

  createTerminal(ws, directory, command, terminalArgs, linkedSessionId, claudeConfig) {
    const terminalId = uuidv4();
    const shell = process.env.SHELL || '/bin/zsh';

    let cmd, cmdArgs;
    if (command === 'claude') {
      cmd = claudeConfig.path ||
        process.env.CLAUDE_PATH ||
        (process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : 'claude');
      cmdArgs = terminalArgs || [];
    } else {
      cmd = shell;
      cmdArgs = [];
    }

    const ptyProcess = pty.spawn(cmd, cmdArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: directory || process.env.HOME,
      env: process.env
    });

    const terminal = {
      ws,
      pty: ptyProcess,
      directory,
      command,
      buffer: '',
      exited: false,
      exitCode: null,
      linkedSessionId: linkedSessionId || null
    };

    this.terminals.set(terminalId, terminal);

    ptyProcess.onData((data) => {
      terminal.buffer += data;
      if (terminal.buffer.length > TERMINAL_BUFFER_SIZE) {
        terminal.buffer = terminal.buffer.slice(-TERMINAL_BUFFER_SIZE);
      }
      if (terminal.ws?.readyState === 1) {
        terminal.ws.send(JSON.stringify({
          type: 'terminal_output',
          terminalId,
          data
        }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      const exitMsg = `\r\n\x1b[90m[Process Terminated]\x1b[0m\r\n`;
      terminal.buffer += exitMsg;
      if (terminal.ws?.readyState === 1) {
        terminal.ws.send(JSON.stringify({
          type: 'terminal_exit',
          terminalId,
          exitCode
        }));
      }

      if (terminal.linkedSessionId) {
        this.onLinkedSessionExit(terminal.linkedSessionId);
      }
    });

    ws.send(JSON.stringify({
      type: 'terminal_created',
      terminalId,
      directory,
      command
    }));
  }

  handleInput(terminalId, data) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.pty.write(data);
    }
  }

  handleResize(terminalId, cols, rows) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.pty.resize(cols, rows);
    }
  }

  close(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      if (!terminal.exited) {
        terminal.pty.kill();
      }
      this.terminals.delete(terminalId);
    }
  }

  list(ws) {
    const terminalList = [];
    for (const [id, t] of this.terminals) {
      terminalList.push({
        terminalId: id,
        directory: t.directory,
        command: t.command,
        exited: t.exited,
        exitCode: t.exitCode
      });
    }
    ws.send(JSON.stringify({ type: 'terminal_list', terminals: terminalList }));
  }

  reconnect(ws, terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      terminal.ws = ws;
      if (terminal.buffer) {
        ws.send(JSON.stringify({
          type: 'terminal_output',
          terminalId,
          data: terminal.buffer
        }));
      }
      if (terminal.exited) {
        ws.send(JSON.stringify({
          type: 'terminal_exit',
          terminalId,
          exitCode: terminal.exitCode
        }));
      }
    }
  }

  detachAll(ws) {
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.ws === ws) {
        terminal.ws = null;
      }
    }
  }
}

module.exports = TerminalManager;
