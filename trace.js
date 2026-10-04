// Trace ID helpers for the cross-repo logging standard
// (relay/docs/logging-standard.md). Inbound IDs are untrusted.

const crypto = require('crypto');

const TRACE_HEADER = 'X-Trace-Id';
const TRACE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function isValidTraceId(v) {
  return typeof v === 'string' && TRACE_ID_RE.test(v);
}

// Keeps a valid inbound ID, otherwise makes a new one. The rejected value is
// never logged or echoed: it could carry injected log text.
function acceptTraceId(v) {
  return isValidTraceId(v) ? v : newTraceId();
}

// True for a host name that can only mean this machine.
function isOnBoxHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && [m[1], m[2], m[3]].every((p) => Number(p) <= 255);
}

function traceMiddleware() {
  return function trace(req, res, next) {
    const raw = req.headers && req.headers['x-trace-id'];
    const first = raw === undefined ? '' : String(raw).split(',')[0].trim();
    req.traceId = acceptTraceId(first);
    next();
  };
}

module.exports = { TRACE_HEADER, newTraceId, isValidTraceId, acceptTraceId, isOnBoxHost, traceMiddleware };
