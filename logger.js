// Structured logger. One JSON object per line on stderr, per the cross-repo
// logging standard (relay/docs/logging-standard.md, logging-schema.json).

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES = ['debug', 'info', 'warn', 'error'];
const OP_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const STATUSES = ['ok', 'error', 'denied'];
const MAX_TEXT = 500;
const DEFAULT_DEBUG_WINDOW_MS = 30 * 60 * 1000;
const WRITER_KEYS = ['ts', 'level', 'msg', 'service', 'trace_id'];
const ENTITY_KEYS = ['job_id', 'session_id', 'run_id'];
// Keys the writer places itself; they never repeat in the attribute tail.
const FIXED_KEYS = new Set([
  'ts', 'level', 'msg', 'service', 'op', 'status', 'duration_ms', 'error', 'trace_id', 'component',
]);

function truncate(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function safeString(v) {
  try { return String(v); } catch { return '[unprintable]'; }
}

// Turns the free-form call arguments into { msg, errors, attrs }.
function splitArgs(args) {
  let attrs = null;
  let rest = args;
  if (args.length > 0 && isPlainObject(args[args.length - 1])) {
    attrs = args[args.length - 1];
    rest = args.slice(0, -1);
  }
  const errors = [];
  const parts = [];
  for (const a of rest) {
    if (a instanceof Error) errors.push(safeString(a.message));
    else parts.push(safeString(a));
  }
  return { msg: parts.join(' '), errors, attrs };
}

function buildLine({ ts, level, service, component, traceId, args }) {
  const { msg, errors, attrs } = splitArgs(args);
  const extra = {};
  let op = 'log';
  let status = level === 'error' || level === 'warn' ? 'error' : 'ok';
  let durationMs = 0;
  let error = '';
  const entities = {};

  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (key === 'op') {
        if (typeof v === 'string' && OP_RE.test(v)) op = v;
        else if (v !== undefined) { extra.attr_op = v; }
      } else if (key === 'status') {
        if (typeof v === 'string') {
          if (STATUSES.includes(v)) status = v;
          else extra.attr_status = v;
        } else if (v !== undefined) {
          extra.http_status = v;
        }
      } else if (key === 'duration_ms') {
        const n = Number(v);
        durationMs = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
      } else if (key === 'error') {
        error = v === undefined || v === null ? '' : safeString(v);
      } else if (WRITER_KEYS.includes(key)) {
        extra[`attr_${key}`] = v;
      } else if (ENTITY_KEYS.includes(key)) {
        if (typeof v === 'string' && v !== '') entities[key] = v;
      } else if (key !== 'component') {
        extra[key] = v;
      }
    }
  }
  if (errors.length > 0) error = errors.join('; ');

  const line = {
    ts,
    level,
    msg: truncate(msg),
    service,
    op,
    status,
    duration_ms: durationMs,
    error: truncate(error),
    trace_id: traceId || '',
  };
  if (component) line.component = component;
  Object.assign(line, entities);
  for (const key of Object.keys(extra)) {
    if (!FIXED_KEYS.has(key) && !(key in line)) line[key] = extra[key];
  }
  return line;
}

class Logger {
  constructor(level = 'info', {
    stream = process.stderr,
    now = Date.now,
    service = process.env.RELAY_SERVICE_ID || 'eve',
    debugWindowMs = DEFAULT_DEBUG_WINDOW_MS,
  } = {}) {
    this._level = LEVELS[level] ?? LEVELS.info;
    this._stream = stream;
    this._now = now;
    this._service = service;
    this._debugWindowMs = debugWindowMs;
    this._debugStart = this._level === LEVELS.debug ? this._safeNow() : null;
  }

  // Reads RELAY_LOG_LEVEL once. LOG_LEVEL is never consulted.
  static fromEnv(env = process.env, opts) {
    const raw = env ? env.RELAY_LOG_LEVEL : undefined;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') return new Logger('info', opts);
    if (Object.prototype.hasOwnProperty.call(LEVELS, value)) return new Logger(value, opts);
    const logger = new Logger('info', opts);
    // Names the variable, never the value: a bad value could be anything.
    logger.warn('RELAY_LOG_LEVEL is not one of error, warn, info, debug; using info', {
      op: 'log.level',
      error: 'invalid RELAY_LOG_LEVEL',
    });
    return logger;
  }

  get level() { return LEVEL_NAMES[this._level]; }

  child(prefix) { return new ChildLogger(this, prefix, ''); }
  withTrace(traceId) { return new ChildLogger(this, '', typeof traceId === 'string' ? traceId : ''); }

  debug(...args) { this._log('debug', '', '', args); }
  info(...args) { this._log('info', '', '', args); }
  warn(...args) { this._log('warn', '', '', args); }
  error(...args) { this._log('error', '', '', args); }

  _safeNow() {
    try { return this._now(); } catch { return Date.now(); }
  }

  _write(level, component, traceId, args) {
    try {
      const ts = new Date(this._safeNow()).toISOString();
      const fields = { ts, level, service: this._service, component, traceId, args };
      let text;
      try {
        text = JSON.stringify(buildLine(fields));
      } catch {
        // Attributes failed to serialise (circular, BigInt): keep msg and error only.
        const noAttrs = args.length > 0 && isPlainObject(args[args.length - 1]) ? args.slice(0, -1) : args;
        text = JSON.stringify(buildLine({ ...fields, args: noAttrs }));
      }
      this._stream.write(text + '\n');
    } catch {
      // A logger must never break the caller.
    }
  }

  _log(level, component, traceId, args) {
    try {
      // Lazy debug expiry: no timer, checked on the first call past the window.
      if (this._debugStart !== null && this._safeNow() - this._debugStart >= this._debugWindowMs) {
        this._debugStart = null;
        this._level = LEVELS.info;
        this._write('warn', '', '', [
          'debug logging ended after 30 minutes; level is now info',
          { op: 'log.level', error: 'debug window ended' },
        ]);
      }
      if (LEVELS[level] < this._level) return;
      this._write(level, component, traceId, args);
    } catch {
      // never throw
    }
  }
}

class ChildLogger {
  constructor(root, prefix, traceId) {
    this._root = root;
    this._prefix = prefix || '';
    this._traceId = traceId || '';
  }

  get level() { return this._root.level; }

  child(sub) {
    return new ChildLogger(this._root, this._prefix ? `${this._prefix}:${sub}` : String(sub), this._traceId);
  }

  withTrace(traceId) {
    return new ChildLogger(this._root, this._prefix, typeof traceId === 'string' ? traceId : '');
  }

  debug(...args) { this._root._log('debug', this._prefix, this._traceId, args); }
  info(...args) { this._root._log('info', this._prefix, this._traceId, args); }
  warn(...args) { this._root._log('warn', this._prefix, this._traceId, args); }
  error(...args) { this._root._log('error', this._prefix, this._traceId, args); }
}

class NullLogger {
  get level() { return 'error'; }
  child() { return this; }
  withTrace() { return this; }
  debug() {}
  info() {}
  warn() {}
  error() {}
}

module.exports = { Logger, ChildLogger, NullLogger };
