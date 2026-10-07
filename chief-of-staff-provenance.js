'use strict';
// Provenance for Chief of Staff actions (docs/design-chief-of-staff.md,
// "Actions and provenance"). Pure functions: no I/O, no clock.
//
// The rule: once the person model session has called any reading tool, its
// text may be shaped by agent data, so eve acts at once only on the person's
// own words, aimed at a target the person named. Anything else becomes a card.

const RELAY_MCP_PREFIX = 'mcp__relay__';
const PROPOSE_TOOLS = Object.freeze(['cos_propose_start', 'cos_propose_send']);

// JS \s is Unicode whitespace, so NBSP, line breaks and thin spaces collapse too.
function normalizeWs(s) {
  return String(s == null ? '' : s).replace(/\s+/gu, ' ').trim();
}

// Case-sensitive on purpose: a span that changes case is not the person's text.
function isVerbatimSpan(candidate, personText) {
  const c = normalizeWs(candidate);
  return c.length > 0 && normalizeWs(personText).includes(c);
}

function namesTarget(target, personText) {
  const t = normalizeWs(target);
  return t.length > 0 && normalizeWs(personText).toLowerCase().includes(t.toLowerCase());
}

// Every tool except the two propose tools counts as reading.
function isReadingTool(name) {
  return !PROPOSE_TOOLS.some((t) => name === RELAY_MCP_PREFIX + t);
}

function decide({ sessionHasRead, personText, candidate, target }) {
  if (!sessionHasRead) return { action: 'now', why: 'no_read' };
  if (!isVerbatimSpan(candidate, personText)) return { action: 'card', why: 'read_not_verbatim' };
  if (!namesTarget(target, personText)) return { action: 'card', why: 'read_target_not_named' };
  return { action: 'now', why: 'verbatim_named' };
}

module.exports = {
  RELAY_MCP_PREFIX, PROPOSE_TOOLS, normalizeWs, isVerbatimSpan, namesTarget, isReadingTool, decide,
};
