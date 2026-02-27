/**
 * Manages the Claude CLI child process lifecycle:
 * spawning, stdio handling, activity monitoring, retry logic, kill.
 */
const { spawn } = require('child_process');
const pidRegistry = require('../pid-registry');

class ClaudeProcess {
  constructor(provider) {
    this.provider = provider;
  }

  get session() {
    return this.provider.session;
  }

  get config() {
    return this.provider.config;
  }

  startProcess() {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', this.session.model
    ];

    if (this.provider.customArgs.length > 0) {
      args.push(...this.provider.customArgs);
    }

    if (this.provider.claudeSessionId) {
      args.push('--resume', this.provider.claudeSessionId);
    }

    const claudePath = this.config.path ||
      process.env.CLAUDE_PATH ||
      (process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : 'claude');

    if (this.config.debug) {
      console.log('[Claude] Using path:', claudePath);
    }
    const resumeFlag = this.provider.claudeSessionId ? ` --resume ${this.provider.claudeSessionId.substring(0, 8)}...` : '';
    console.log('[SPAWN]', claudePath, args.slice(0, 7).join(' ') + resumeFlag);

    const proc = spawn(claudePath, args, {
      cwd: this.session.directory,
      env: {
        ...process.env,
        EVE_HOOK_URL: `http://localhost:${process.env.PORT || 3000}`,
        EVE_SESSION_ID: this.session.sessionId,
        EVE_AUTH_TOKEN: process.env.AUTH_TOKEN || '',
        EVE_SKIP_PERMISSIONS: this.provider.customArgs.includes('--dangerously-skip-permissions') ? '1' : ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.provider.claudeProcess = proc;
    const spawnedPid = proc.pid;
    pidRegistry.add(spawnedPid);

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      console.log('[STDOUT]', chunk);
      this.provider.buffer += chunk;
      this.provider.recordActivity();

      const lines = this.provider.buffer.split('\n');
      this.provider.buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) this.provider.processLine(line);
      }
    });

    proc.stderr.on('data', (data) => {
      console.log('[STDERR]', data.toString());
      this.provider.recordActivity();
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'stderr',
          sessionId: this.session.sessionId,
          text: data.toString()
        }));
      }
    });

    proc.on('close', (code) => {
      console.log('[EXIT]', 'Provider process exited with code:', code);
      pidRegistry.remove(spawnedPid);
      this.provider.claudeProcess = null;
      this.provider.stopActivityMonitor();

      // Save partial message if process crashed mid-response
      if (this.provider.currentAssistantMessage && this.session.processing) {
        const textBlock = this.provider.currentAssistantMessage.content.find(b => b.type === 'text');
        if (textBlock && textBlock.text) {
          this.provider.currentAssistantMessage.incomplete = true;
          this.session.messages.push(this.provider.currentAssistantMessage);
          if (this.session.saveHistory) this.session.saveHistory();
          console.log('[Claude] Saved partial response:', textBlock.text.substring(0, 100));

          if (this.session.ws && this.session.ws.readyState === 1) {
            this.session.ws.send(JSON.stringify({
              type: 'warning',
              sessionId: this.session.sessionId,
              message: 'Response was interrupted. Partial content has been saved.'
            }));
          }
        }
        this.provider.currentAssistantMessage = null;
      }

      this.session.processing = false;

      if (code === 0) this.provider.retryCount = 0;

      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'process_exited',
          sessionId: this.session.sessionId,
          code
        }));
      }
    });

    proc.on('error', (err) => {
      console.error('[ERROR]', err);
      pidRegistry.remove(spawnedPid);
      this.provider.claudeProcess = null;
      this.session.processing = false;

      if (err.code === 'ENOENT') {
        this.provider.fatalError = `Claude CLI not found. Ensure 'claude' is installed and in PATH, or set CLAUDE_PATH environment variable.`;
      } else if (err.code === 'EACCES') {
        this.provider.fatalError = `Permission denied executing Claude CLI. Check file permissions.`;
      }

      const errorMessage = this.provider.fatalError || err.message;
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: errorMessage
        }));
      }
    });
  }

  kill() {
    this.provider.stopActivityMonitor();
    const proc = this.provider.claudeProcess;
    if (!proc) return;

    // Persist partial response and session state before killing
    if (this.provider.currentAssistantMessage) {
      const textBlock = this.provider.currentAssistantMessage.content.find(b => b.type === 'text');
      if (textBlock && textBlock.text) {
        this.provider.currentAssistantMessage.incomplete = true;
        this.session.messages.push(this.provider.currentAssistantMessage);
      }
      this.provider.currentAssistantMessage = null;
    }

    this.session.providerState = this.provider.getSessionState();
    if (this.session.saveHistory) this.session.saveHistory();

    try { proc.stdin.end(); } catch (e) { /* already closed */ }

    proc.kill('SIGTERM');
    const killTimeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
    }, 3000);

    proc.once('close', () => clearTimeout(killTimeout));
  }
}

module.exports = ClaudeProcess;
