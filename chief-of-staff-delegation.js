'use strict';
// Chief of Staff delegation: the owner's instruction compiled into a card, and the
// fixed text eve sends while the owner is away. Pure apart from `crypto` for ids.
// Design: docs/design-chief-of-staff.md ("Acting while you're away").
//
// Nothing here acts. The card is fixed at approval; a model never writes the
// keep-going text, eve builds it from the card.

const crypto = require('crypto');

const DELEGATION_DEFAULTS = Object.freeze({ windowHours: 8, maxActions: 50, verifyRuns: 2 });
const LIMITS = Object.freeze({
  rules: { min: 1, max: 10 },
  sessions: { min: 1, max: 10 },
  issues: { min: 0, max: 20 },
  windowHours: { min: 1, max: 24 },
  maxActions: { min: 1, max: 100 },
  verifyRuns: { min: 0, max: 5 },
  when: { min: 1, max: 200 },
  text: { min: 1, max: 2000 },
});
const ISSUE_REF_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,6}$/;
const READY_LINE = 'READY-FOR-OWNER';
const END_REASONS = Object.freeze({
  window: 'time is up',
  cap: 'message limit reached',
  done: 'all done',
  stopped: 'you stopped it',
  replaced: 'replaced by a newer instruction',
});
const REPLY_TRIGGERS = Object.freeze(['question', 'finished']);
const INSTRUCTION_MAX = 300;

const TOP_FIELDS = ['rules', 'windowHours', 'maxActions', 'verifyRuns'];
const CONTINUE_FIELDS = ['kind', 'sessions', 'approveIssues', 'buildFromDev'];
const REPLY_FIELDS = ['kind', 'sessionId', 'on', 'when', 'text'];

function invalid(field, message) {
  return { error: { status: 400, code: 'invalid_args', message: `${field}: ${message}` } };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An integer in LIMITS[field], or the default when null or absent.
function checkBound(field, v, fallback) {
  if (v === undefined || v === null) return { value: fallback };
  const { min, max } = LIMITS[field];
  if (!Number.isInteger(v) || v < min || v > max) return invalid(field, `must be an integer from ${min} to ${max}`);
  return { value: v };
}

// A session id must name a managed session in the fresh roster.
function resolveSession(id, { roster, isOwnId }) {
  const sid = typeof id === 'string' ? id.trim() : '';
  if (!sid) return invalid('sessionId', 'is required');
  if (sid.startsWith('outside:')) {
    return { error: { status: 403, code: 'outside_session_read_only', message: 'Outside sessions are read-only.' } };
  }
  if (isOwnId && isOwnId(sid)) {
    return { error: { status: 403, code: 'own_session', message: "The Chief of Staff's own sessions are not part of a delegation" } };
  }
  const row = roster.get(sid);
  if (!row) return { error: { status: 404, code: 'unknown_session', message: 'No such session' } };
  return { value: { sessionId: sid, label: row.label || '', project: row.project || '' } };
}

function validateContinue(rule, ctx) {
  const unknown = Object.keys(rule).find((k) => !CONTINUE_FIELDS.includes(k));
  if (unknown) return invalid(unknown, 'is not a field of a continue rule');
  const ids = rule.sessions;
  const { min, max } = LIMITS.sessions;
  if (!Array.isArray(ids) || ids.length < min || ids.length > max) {
    return invalid('sessions', `must list ${min} to ${max} session ids`);
  }
  const sessions = [];
  for (const id of ids) {
    const s = resolveSession(id, ctx);
    if (s.error) return s;
    if (!sessions.some((x) => x.sessionId === s.value.sessionId)) sessions.push(s.value);
  }
  let approveIssues = [];
  if (rule.approveIssues !== undefined && rule.approveIssues !== null) {
    const refs = rule.approveIssues;
    if (!Array.isArray(refs) || refs.length > LIMITS.issues.max) {
      return invalid('approveIssues', `must be a list of at most ${LIMITS.issues.max} issue references`);
    }
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ISSUE_REF_RE.test(ref)) {
        return invalid('approveIssues', 'each reference must look like <owner>/<repo>#<number>');
      }
      if (!approveIssues.includes(ref)) approveIssues.push(ref);
    }
  }
  if (rule.buildFromDev !== undefined && rule.buildFromDev !== null && typeof rule.buildFromDev !== 'boolean') {
    return invalid('buildFromDev', 'must be true or false');
  }
  return { value: { kind: 'continue', sessions, approveIssues, buildFromDev: rule.buildFromDev === true } };
}

function validateReply(rule, ctx) {
  const unknown = Object.keys(rule).find((k) => !REPLY_FIELDS.includes(k));
  if (unknown) return invalid(unknown, 'is not a field of a reply rule');
  const s = resolveSession(rule.sessionId, ctx);
  if (s.error) return s;
  if (!REPLY_TRIGGERS.includes(rule.on)) return invalid('on', 'must be "question" or "finished"');
  let when = null;
  if (rule.when !== undefined && rule.when !== null) {
    when = typeof rule.when === 'string' ? rule.when.trim() : '';
    if (when.length < LIMITS.when.min || when.length > LIMITS.when.max) {
      return invalid('when', `must be ${LIMITS.when.min} to ${LIMITS.when.max} characters`);
    }
  }
  const text = typeof rule.text === 'string' ? rule.text.trim() : '';
  if (text.length < LIMITS.text.min || text.length > LIMITS.text.max) {
    return invalid('text', `must be ${LIMITS.text.min} to ${LIMITS.text.max} characters`);
  }
  return { value: { kind: 'reply', ...s.value, on: rule.on, when, text } };
}

// args -> a draft delegation with labels and project names from the roster.
// `roster` is a Map of session id to {label, project}; the caller built it from a
// fresh read. Never throws.
function validateProposal(args, { roster, isOwnId, defaults } = {}) {
  if (!isObject(args)) return invalid('args', 'must be an object');
  const unknown = Object.keys(args).find((k) => !TOP_FIELDS.includes(k));
  if (unknown) return invalid(unknown, 'is not a field of cos_propose_delegation');
  const { min, max } = LIMITS.rules;
  if (!Array.isArray(args.rules) || args.rules.length < min || args.rules.length > max) {
    return invalid('rules', `must hold ${min} to ${max} rules`);
  }
  const base = { ...DELEGATION_DEFAULTS, ...(defaults || {}) };
  const ctx = { roster: roster || new Map(), isOwnId };
  const rules = [];
  for (const rule of args.rules) {
    if (!isObject(rule)) return invalid('rules', 'each rule must be an object');
    if (rule.kind === 'continue') {
      if (rules.some((r) => r.kind === 'continue')) return invalid('rules', 'at most one continue rule');
      const r = validateContinue(rule, ctx);
      if (r.error) return r;
      rules.push(r.value);
    } else if (rule.kind === 'reply') {
      const r = validateReply(rule, ctx);
      if (r.error) return r;
      rules.push(r.value);
    } else {
      return invalid('kind', 'must be "continue" or "reply"');
    }
  }
  const windowHours = checkBound('windowHours', args.windowHours, base.windowHours);
  if (windowHours.error) return windowHours;
  const maxActions = checkBound('maxActions', args.maxActions, base.maxActions);
  if (maxActions.error) return maxActions;
  const verifyRuns = checkBound('verifyRuns', args.verifyRuns, base.verifyRuns);
  if (verifyRuns.error) return verifyRuns;
  return { value: { rules, windowHours: windowHours.value, maxActions: maxActions.value, verifyRuns: verifyRuns.value } };
}

// The text a keep-going rule sends. Built by eve from the card, never by a model.
function continueText(delegation) {
  const d = delegation || {};
  const rule = (Array.isArray(d.rules) ? d.rules : []).find((r) => r && r.kind === 'continue') || {};
  const words = String(d.instruction == null ? '' : d.instruction).replace(/\s+/gu, ' ').trim().slice(0, INSTRUCTION_MAX);
  const runs = d.verifyRuns === 0 ? 'Do not run a full verify run.' : `Use at most ${d.verifyRuns} full verify runs.`;
  const issues = Array.isArray(rule.approveIssues) ? rule.approveIssues : [];
  const lines = [
    `The owner is away. In the Chief of Staff the owner approved this instruction: "${words}"`,
    `Keep going with the approved work until it is ready to merge to main, including the full verifications. ${runs}`,
    'Do not merge to main. When the PR to main is ready, run merge-check without --merge and report its verdict.',
  ];
  if (issues.length) {
    lines.push(`The owner approved these issues for this run: ${issues.join(', ')}. Any other needs-review issue waits for the owner.`);
  }
  lines.push(rule.buildFromDev === true
    ? 'You may build your own from-dev ideas up to a PR.'
    : 'Do not build new ideas: file them as needs-review.');
  lines.push("Leave for the owner, and list with its reason: credentials, publishing outside the owner's repos, deleting, CI workflows, guards, merge-check, and anything this instruction does not cover.");
  lines.push(`When nothing more can move without the owner, end your reply with this line alone: ${READY_LINE}`);
  return lines.join('\n');
}

// The last non-empty line, trimmed, is exactly the ready line.
function isReadyReport(excerpt) {
  const lines = String(excerpt == null ? '' : excerpt).split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === READY_LINE;
}

function keepGoingRule(d) {
  const rules = Array.isArray(d.rules) ? d.rules : [];
  const index = rules.findIndex((r) => r && r.kind === 'continue');
  return index < 0 ? null : { index, rule: rules[index] };
}

// One turn end of a listed session -> what eve does. Pure. Order: ready line, the
// session's cap, the first reply rule that fits (a rule with a `when` waits for the
// model match), the keep-going rule, nothing. `rule` is the 0-based rule index.
function decideTurnEnd(delegation, { sessionId, excerpt, question } = {}) {
  const d = delegation || {};
  const entry = d.sessions && d.sessions[sessionId];
  if (!entry) return { action: 'none', why: 'unlisted' };
  if (isReadyReport(excerpt)) return { action: 'ready' };
  if ((entry.actions | 0) >= d.maxActions) return { action: 'none', why: 'cap' };
  const rules = Array.isArray(d.rules) ? d.rules : [];
  const on = question ? 'question' : 'finished';
  const reply = rules.findIndex((r) => r && r.kind === 'reply' && r.sessionId === sessionId && r.on === on && r.when === null);
  if (reply >= 0) return { action: 'send', rule: reply, text: rules[reply].text };
  const keep = keepGoingRule(d);
  if (keep && (keep.rule.sessions || []).some((s) => s.sessionId === sessionId)) {
    return { action: 'send', rule: keep.index, text: continueText(d) };
  }
  return { action: 'none', why: 'no_rule' };
}

// The digest post's body, from eve's own records. `roster` (optional) is a Map of
// session id to a row with `label` or `name`; labels fixed on the card win.
function buildDigest(delegation, { endReason, now, roster } = {}) {
  const d = delegation || {};
  const names = new Map();
  for (const r of Array.isArray(d.rules) ? d.rules : []) {
    for (const s of r.kind === 'continue' ? r.sessions || [] : [r]) {
      if (s && s.sessionId && !names.has(s.sessionId)) names.set(s.sessionId, { label: s.label || '', project: s.project || '' });
    }
  }
  const who = (id) => {
    const fixed = names.get(id) || {};
    const row = (roster && roster.get && roster.get(id)) || {};
    return { label: fixed.label || row.label || row.name || `Session ${String(id).slice(0, 8)}`, project: fixed.project || row.project || '' };
  };
  const keep = keepGoingRule(d);
  const keepIds = new Set(keep ? (keep.rule.sessions || []).map((s) => s.sessionId) : []);
  const waiting = [];
  const ready = [];
  for (const [id, e] of Object.entries(d.sessions || {})) {
    const { label, project } = who(id);
    if (e.ready) {
      ready.push({ sessionId: id, label, project, report: String(e.report || '').slice(-500) });
    } else if (e.waiting) {
      waiting.push({ sessionId: id, label, project, reason: String(e.waiting), detail: String(e.detail || '') });
    } else if ((e.actions | 0) >= d.maxActions) {
      waiting.push({ sessionId: id, label, project, reason: 'cap', detail: '' });
    } else if (keepIds.has(id)) {
      waiting.push({ sessionId: id, label, project, reason: 'not_ready', detail: '' });
    }
  }
  return {
    delegationId: d.delegationId,
    from: d.approvedAt,
    to: new Date(now == null ? Date.now() : now).toISOString(),
    endReason,
    sent: d.actions | 0,
    actions: (Array.isArray(d.log) ? d.log : []).map((l) => ({
      at: l.at, sessionId: l.sessionId, label: l.label, rule: l.rule, text: l.text,
    })),
    waiting,
    ready,
  };
}

function newDelegationId() {
  return `d_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  DELEGATION_DEFAULTS, LIMITS, ISSUE_REF_RE, READY_LINE, END_REASONS,
  validateProposal, continueText, newDelegationId, isReadyReport, decideTurnEnd, buildDigest,
};
