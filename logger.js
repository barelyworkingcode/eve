/**
 * Logger - level-filtered logging with subsystem prefixes (server-side).
 *
 * Usage:
 *   const { Logger } = require('./logger');
 *   const log = new Logger(process.env.LOG_LEVEL || 'debug');
 *   const wsLog = log.child('WsHandler');
 *   wsLog.info('connected');                      // [WsHandler] connected
 *   wsLog.child('relay').error('timeout');         // [WsHandler:relay] timeout
 *
 * For production, use NullLogger or set level to 'none':
 *   const { NullLogger } = require('./logger');
 *   const log = new NullLogger();
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };

class Logger {
  constructor(level = 'debug') {
    this._level = LOG_LEVELS[level] ?? LOG_LEVELS.debug;
  }

  child(prefix) {
    return new ChildLogger(this, prefix);
  }

  setLevel(level) {
    this._level = LOG_LEVELS[level] ?? this._level;
  }

  get level() {
    return Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this._level);
  }

  debug(...args) { if (this._level <= 0) console.debug(...args); }
  info(...args)  { if (this._level <= 1) console.log(...args); }
  warn(...args)  { if (this._level <= 2) console.warn(...args); }
  error(...args) { if (this._level <= 3) console.error(...args); }
}

class ChildLogger {
  constructor(parent, prefix) {
    this._parent = parent;
    this._prefix = `[${prefix}]`;
  }

  child(subPrefix) {
    const base = this._prefix.slice(1, -1);
    return new ChildLogger(this._parent, `${base}:${subPrefix}`);
  }

  debug(...args) { this._parent.debug(this._prefix, ...args); }
  info(...args)  { this._parent.info(this._prefix, ...args); }
  warn(...args)  { this._parent.warn(this._prefix, ...args); }
  error(...args) { this._parent.error(this._prefix, ...args); }
}

class NullLogger {
  child() { return this; }
  setLevel() {}
  get level() { return 'none'; }
  debug() {}
  info() {}
  warn() {}
  error() {}
}

module.exports = { Logger, ChildLogger, NullLogger };
