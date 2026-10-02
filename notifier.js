// A notifier is any object with notify(n): Promise<void> that never rejects.
// FileNotifier is the only sink: an always-on, private file in the data dir.
// A push sink (Pushover, native) is a second class with the same method,
// picked in createNotifier — nothing else changes.

const fs = require('fs');
const path = require('path');
const { NullLogger } = require('./logger');

const NOTIFICATIONS_FILE = 'notifications.jsonl';
const DEFAULT_MAX = 200;

class FileNotifier {
  constructor({ file, max = DEFAULT_MAX, log } = {}) {
    this.file = file;
    this.max = max;
    this.log = log || new NullLogger();
    // Serializes read-modify-write so concurrent notify() calls all land.
    this._chain = Promise.resolve();
  }

  notify(notification) {
    const run = this._chain.then(() => this._append(notification));
    this._chain = run.catch(() => {});
    return run.catch((err) => {
      this.log.warn('Notification not written', {
        kind: notification && notification.kind,
        taskId: notification && notification.taskId,
        error: err.message,
      });
    });
  }

  async _append(notification) {
    let lines = [];
    try {
      lines = (await fs.promises.readFile(this.file, 'utf8')).split('\n').filter(Boolean);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    lines.push(JSON.stringify(notification));
    const kept = lines.slice(-this.max);
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, kept.join('\n') + '\n', { mode: 0o600 });
    await fs.promises.rename(tmp, this.file);
  }
}

function createNotifier({ dataDir, log }) {
  return new FileNotifier({ file: path.join(dataDir, NOTIFICATIONS_FILE), log });
}

module.exports = { FileNotifier, createNotifier, NOTIFICATIONS_FILE };
