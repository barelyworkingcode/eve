'use strict';

// Paired status for a relay + eve change set: one state, one comment body,
// a devbox/verify status on each PR head.

const DESCRIPTION_MAX = 140;
const SIDES = ['relay', 'eve'];

function scrub(s, home) {
  return home ? String(s).split(home).join('~') : String(s);
}

function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function lines(stdout) {
  return String(stdout || '').split(/\r?\n/);
}

function summaryLines(stdout) {
  return lines(stdout).filter((l) => l.startsWith('SUMMARY\t'));
}

function journeysOf(stdout) {
  const out = [];
  for (const l of lines(stdout)) {
    const m = /^JOURNEY\t([^\t]*)\t([^\t]*)\t?(.*)$/.exec(l);
    if (m) out.push({ id: m[1], state: m[2], detail: m[3] });
  }
  return out;
}

function setState(phases) {
  const journeys = phases.flatMap((p) => journeysOf(p.stdout));
  if (journeys.some((j) => j.state === 'FAIL')) return 'failure';
  if (journeys.some((j) => j.state === 'BLOCKED')) return 'error';
  if (phases.some((p) => p.timedOut || !summaryLines(p.stdout).length)) return 'error';
  return 'success';
}

// The nightly's rules: exit 0 GREEN; exit 1 with a SUMMARY line RED; else BLOCKED.
function phaseResult(p) {
  if (p.timedOut) return 'BLOCKED';
  if (p.code === 0) return 'GREEN';
  if (p.code === 1 && summaryLines(p.stdout).length) return 'RED';
  return 'BLOCKED';
}

function phaseSummary(p) {
  const s = summaryLines(p.stdout);
  const line = s.length ? s[s.length - 1]
    : lines(p.stdout).find((l) => /^PREFLIGHT\t[^\t]+\tFAIL/.test(l));
  const text = line ? line.replace(/\t/g, ' ') : 'no summary';
  return p.timedOut ? `timed out; ${text}` : text;
}

function cell(v) {
  return oneLine(v).replaceAll('|', '\\|');
}

function renderSetComment(ev) {
  const journeyRows = ev.phases.flatMap((p) => journeysOf(p.stdout).map((j) => ({ label: p.label, ...j })));
  const out = [
    `### devbox/verify (set): ${setState(ev.phases)}`,
    '',
    '| | |',
    '|---|---|',
    `| Relay PR | ${ev.relay.url} |`,
    `| Relay commit | \`${ev.relay.sha}\` |`,
    `| Eve PR | ${ev.eve.url} |`,
    `| Eve commit | \`${ev.eve.sha}\` |`,
    `| Tool commit | \`${ev.toolCommit}\` |`,
    `| Run time | ${Math.round(ev.runMs / 1000)} s |`,
    '',
    '| Phase | Result | Summary |',
    '|---|---|---|',
    ...ev.phases.map((p) => `| ${p.label} | ${phaseResult(p)} | ${cell(phaseSummary(p))} |`),
    '',
    '| Phase | Journey | Result | Detail |',
    '|---|---|---|---|',
    ...journeyRows.map((j) => `| ${j.label} | \`${j.id}\` | ${j.state} | ${cell(j.detail)} |`),
  ];
  return scrub(out.join('\n') + '\n', ev.home);
}

function counts(phases) {
  const total = { pass: 0, fail: 0, blocked: 0, notrun: 0 };
  for (const p of phases) {
    const s = summaryLines(p.stdout);
    if (!s.length) continue;
    for (const k of Object.keys(total)) {
      const m = new RegExp(`\\b${k}=(\\d+)`).exec(s[s.length - 1]);
      if (m) total[k] += Number(m[1]);
    }
  }
  return total;
}

function setDescription(ev, side) {
  const other = side === 'relay' ? 'eve' : 'relay';
  const c = counts(ev.phases);
  const text = `set relay@${ev.relay.sha.slice(0, 12)} eve@${ev.eve.sha.slice(0, 12)}; with ${other}#${ev[other].pr}; ` +
    `pass=${c.pass} fail=${c.fail} blocked=${c.blocked} notrun=${c.notrun}`;
  return text.slice(0, DESCRIPTION_MAX);
}

function commentUrlFrom(ghStdout) {
  const ls = String(ghStdout).split('\n').map((l) => l.trim()).filter(Boolean);
  const url = ls.length ? ls[ls.length - 1] : '';
  if (!url.startsWith('https://')) throw new Error('gh pr comment printed no comment URL');
  return url;
}

function postStatus(gh, ref, { state, url, description }) {
  return gh([
    'api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${ref.sha}`,
    '-f', `state=${state}`,
    '-f', 'context=devbox/verify',
    '-f', `target_url=${url}`,
    '-f', `description=${description}`,
  ], { cwd: ref.checkout });
}

// Order: relay comment, eve comment, relay status, eve status. A failure after
// the relay status was set re-posts relay as error, so no PR keeps a success
// the other PR lacks.
async function postSet(ev, { gh }) {
  const state = setState(ev.phases);
  const body = renderSetComment(ev);
  const urls = {};
  for (const side of SIDES) {
    const out = await gh(['pr', 'comment', String(ev[side].pr), '--body-file', '-'], { cwd: ev[side].checkout, stdin: body });
    urls[side] = commentUrlFrom(out);
  }
  await postStatus(gh, ev.relay, { state, url: urls.relay, description: setDescription(ev, 'relay') });
  try {
    await postStatus(gh, ev.eve, { state, url: urls.eve, description: setDescription(ev, 'eve') });
  } catch (err) {
    try {
      await postStatus(gh, ev.relay, {
        state: 'error', url: urls.relay,
        description: `set post failed on eve#${ev.eve.pr}`.slice(0, DESCRIPTION_MAX),
      });
    } catch { /* the original failure is the one to report */ }
    throw err;
  }
  return urls;
}

module.exports = { setState, renderSetComment, setDescription, postSet };
