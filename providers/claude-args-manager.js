/**
 * Manages custom CLI arguments for Claude provider sessions:
 * parsing, validation, persistence, and the /args-edit command.
 */
class ClaudeArgsManager {
  // Args managed internally by startProcess() -- cannot be set via /args-edit
  static PROTECTED_ARGS = new Set([
    '--print', '--output-format', '--input-format', '--verbose', '--resume', '-p', '-r'
  ]);

  constructor(provider) {
    this.provider = provider;
  }

  get customArgs() {
    return this.provider.customArgs;
  }

  set customArgs(args) {
    this.provider.customArgs = args;
  }

  handleArgsEdit(rawText, sendSystemMessage) {
    const afterCommand = rawText.replace(/^\/args-edit\s*/, '');

    if (!afterCommand) {
      sendSystemMessage(
        'Usage:\n' +
        '  /args-edit --flag [value]   Add or update a CLI flag\n' +
        '  /args-edit --remove --flag  Remove a flag\n' +
        '  /args-edit --clear          Remove all custom args'
      );
      return;
    }

    const parsed = this.parseQuotedArgs(afterCommand);

    if (parsed[0] === '--clear') {
      if (this.customArgs.length === 0) {
        sendSystemMessage('No custom args to clear.');
        return;
      }
      this.customArgs = [];
      this.persistCustomArgs();
      this.restartProcess(sendSystemMessage, 'All custom args cleared.');
      return;
    }

    if (parsed[0] === '--remove') {
      if (parsed.length < 2) {
        sendSystemMessage('Usage: /args-edit --remove --flag');
        return;
      }
      const flag = parsed[1];
      const removed = this.removeCustomArg(flag);
      if (!removed) {
        sendSystemMessage(`Flag "${flag}" not found in custom args.`);
        return;
      }
      this.persistCustomArgs();
      this.restartProcess(sendSystemMessage, `Removed ${flag}.`);
      return;
    }

    const flag = parsed[0];
    if (!flag.startsWith('-')) {
      sendSystemMessage(`Expected a flag starting with "-", got "${flag}".`);
      return;
    }

    if (ClaudeArgsManager.PROTECTED_ARGS.has(flag)) {
      sendSystemMessage(`"${flag}" is managed internally and cannot be changed via /args-edit.`);
      return;
    }

    // Intercept --model: update session.model instead of customArgs
    if (flag === '--model') {
      if (parsed.length < 2) {
        sendSystemMessage('Usage: /args-edit --model <model-name>');
        return;
      }
      const models = this.provider.constructor.getModels().map(m => m.value);
      const newModel = parsed[1].toLowerCase();
      if (!models.includes(newModel)) {
        sendSystemMessage(`Invalid model "${newModel}". Available: ${models.join(', ')}`);
        return;
      }
      this.provider.session.model = newModel;
      this.restartProcess(sendSystemMessage, `Model changed to: ${newModel}`);
      return;
    }

    const values = parsed.slice(1);
    this.removeCustomArg(flag);
    this.customArgs.push(flag, ...values);
    this.persistCustomArgs();

    const display = values.length > 0 ? `${flag} ${values.join(' ')}` : flag;
    this.restartProcess(sendSystemMessage, `Added ${display}.`);
  }

  parseQuotedArgs(str) {
    const result = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (/\s/.test(ch) && !inSingle && !inDouble) {
        if (current.length > 0) {
          result.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current.length > 0) result.push(current);
    return result;
  }

  formatArgsForDisplay(argsArray) {
    const lines = [];
    let i = 0;
    while (i < argsArray.length) {
      let entry = argsArray[i];
      i++;
      while (i < argsArray.length && !argsArray[i].startsWith('-')) {
        entry += ' ' + argsArray[i];
        i++;
      }
      lines.push(entry);
    }
    return lines.join('\n');
  }

  removeCustomArg(flag) {
    const idx = this.customArgs.indexOf(flag);
    if (idx === -1) return false;

    let end = idx + 1;
    while (end < this.customArgs.length && !this.customArgs[end].startsWith('-')) {
      end++;
    }
    this.customArgs.splice(idx, end - idx);
    return true;
  }

  persistCustomArgs() {
    this.provider.session.providerState = this.provider.getSessionState();
    if (this.provider.session.saveHistory) {
      this.provider.session.saveHistory();
    }
  }

  restartProcess(sendSystemMessage, message) {
    if (this.provider.claudeProcess) {
      this.provider.claudeProcess.kill();
      this.provider.claudeProcess = null;
    }
    this.provider.startProcess();
    sendSystemMessage(message + ' Process restarted.');
  }
}

module.exports = ClaudeArgsManager;
