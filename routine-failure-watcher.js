// eve's own server-level /ws/tasks connection, so a failed routine is noticed
// whether or not a browser is open (the per-browser one in relay-client.js
// exists only while one is). Listen-only: never sends upstream.

const { NullLogger } = require('./logger');

const INITIAL_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const TITLE_MAX = 80;
const MESSAGE_MAX = 200;

function routineFailedNotification(frame, now = new Date()) {
  if (!frame || frame.type !== 'task_error' || typeof frame.taskId !== 'string') return null;
  // relayScheduler's failRun (a run that never started) sends no status.
  const status = frame.status || 'error';
  const timedOut = status === 'timeout';
  const name = (typeof frame.taskName === 'string' && frame.taskName) || frame.taskId;
  const raw = typeof frame.error === 'string' ? frame.error.replace(/\s+/g, ' ').trim() : '';
  const message = raw.slice(0, MESSAGE_MAX) || (timedOut ? 'The run took too long.' : 'The run failed.');
  return {
    v: 1,
    kind: 'routine_failed',
    at: now.toISOString(),
    title: `${timedOut ? 'Routine timed out' : 'Routine failed'}: ${name.slice(0, TITLE_MAX)}`,
    message,
    url: '#routines',
    taskId: frame.taskId,
    projectId: frame.projectId,
    status,
  };
}

class RoutineFailureWatcher {
  constructor({ relayTransport, notifier, log } = {}) {
    this.relayTransport = relayTransport;
    this.notifier = notifier;
    this.log = log || new NullLogger();
    this._ws = null;
    this._timer = null;
    this._started = false;
    this._stopped = false;
    this._delay = INITIAL_DELAY_MS;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
    }
  }

  _connect() {
    if (this._stopped) return;
    let ws;
    try {
      ws = this.relayTransport.createWebSocket('/ws/tasks');
    } catch (err) {
      this.log.debug('Routine failure WS create failed:', err.message);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this.log.info('Watching routine failures');
      this._delay = INITIAL_DELAY_MS;
    });

    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch (err) {
        this.log.debug('Unparseable scheduler frame:', err.message);
        return;
      }
      const notification = routineFailedNotification(frame);
      if (notification) this.notifier.notify(notification);
    });

    ws.on('close', () => {
      if (this._ws === ws) this._ws = null;
      this._scheduleReconnect();
    });

    // 'close' (which drives the reconnect) fires after 'error'.
    ws.on('error', (err) => {
      this.log.debug('Routine failure WS error:', err.message);
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._timer) return;
    const delay = this._delay;
    this._delay = Math.min(delay * 2, MAX_DELAY_MS);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._connect();
    }, delay);
    this._timer.unref?.();
  }
}

module.exports = { RoutineFailureWatcher, routineFailedNotification };
