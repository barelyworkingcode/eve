#!/usr/bin/env node
'use strict';

// Self-test for Chief of Staff person-turn reply length (#577). Each case drives
// ChiefOfStaff#submitPerson with a ready-made model that answers one scripted
// text, and reads the reply post off a fake subscriber socket. It waits on the
// cos_post frame (kind reply; a notice fails the case), never on a duration.
// Scratch dirs are removed on process exit, after the write queue has drained.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const prompt = require(path.join(EVE, 'chief-of-staff-prompt'));
const { ChiefOfStaff } = require(path.join(EVE, 'chief-of-staff'));

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// Upper bound only; the cos_post frame is the signal.
const LIMIT_MS = 20000;

function replyFor(text, question = 'Explain that in full detail') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-reply-selftest-'));
  made.push(dataDir);
  const projectId = 'p1';
  const cos = new ChiefOfStaff({
    relayTransport: { fetch: async () => ({ status: 200, data: { sessions: [] } }) },
    listProjects: () => [{ id: projectId, name: 'Acme', path: dataDir }],
    model: { sessionId: 'sess-1', turn: async () => ({ text }) },
    dataDir,
    settings: { enabled: true, projectId, model: 'haiku' },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cos.stop(); reject(new Error('no reply post')); }, LIMIT_MS);
    timer.unref();
    cos.subscribe({
      readyState: 1,
      send(json) {
        const frame = JSON.parse(json);
        if (frame.type !== 'cos_post' || !frame.post) return;
        if (frame.post.kind === 'reply') { clearTimeout(timer); cos.stop(); resolve(frame.post.body); }
        else if (frame.post.kind === 'notice') { clearTimeout(timer); cos.stop(); reject(new Error(`notice: ${frame.post.body}`)); }
      },
    });
    cos.submitPerson(question);
  });
}

const sentences = (n) => { let s = ''; for (let i = 0; s.length < n; i++) s += `Sentence number ${i} says something plain. `; return s.trim(); };
const words = (n) => { let s = ''; for (let i = 0; s.length < n; i++) s += `word${i} `; return s.trim(); };

const failures = [];
async function run(name, fn) {
  try { await fn(); } catch (e) { failures.push(`${name}: ${e && e.message || e}`); }
}

async function main() {
  // A1: the person prompt asks for short replies, and full length on request.
  await run('A1', async () => {
    const p = prompt.personSystemPrompt();
    assert.ok(p.includes('Reply in plain text: no markdown, no links, no lists, no JSON block.'), 'A1 plain-text line');
    assert.ok(p.includes('Keep a reply short: a few sentences that answer the question. When the person asks for detail, a longer answer or an expansion, give the whole answer at the length it needs.'), 'A1 length line');
  });

  // A2: a 1500-character reply arrives whole.
  await run('A2', async () => {
    const text = sentences(1500);
    assert.ok(text.length >= 1500);
    const body = await replyFor(text);
    assert.ok(body === text, `A2 reply whole: got ${body.length} chars, want ${text.length}`);
  });

  // A3: over the ceiling, the cut is visible and lands on a sentence or a word.
  for (const [label, text, atSentence] of [['sentence', sentences(9000), true], ['word', words(9000), false]]) await run(`A3 ${label}`, async () => {
    const body = await replyFor(text);
    assert.ok(body.length <= 8000, `A3 ${label}: length ${body.length} over 8000`);
    assert.ok(body.endsWith(' …'), `A3 ${label}: ends with " …"`);
    const kept = body.slice(0, -2);
    assert.ok(text.startsWith(kept), `A3 ${label}: kept text is a prefix`);
    assert.ok(kept.length > 4000, `A3 ${label}: keeps most of the ceiling`);
    if (atSentence) assert.match(kept, /[.!?]$/, 'A3 sentence: ends on a sentence mark');
    assert.match(text[kept.length], /\s/, `A3 ${label}: next character is whitespace (no mid-word cut)`);
  });

  // A4: a short reply is unchanged apart from the trim.
  await run('A4', async () => {
    const core = 'Short answer. It is done.'.padEnd(120, 'x');
    const body = await replyFor(`  \n${core}\n  `);
    assert.strictEqual(body, core, 'A4 trimmed, no mark');
  });

  // A5: a closing fenced block survives whole when the prose is cut.
  await run('A5', async () => {
    const block = '```json\n{"ok":true,"items":["a","b"]}\n```';
    const text = `${sentences(9000)}\n${block}`;
    const body = await replyFor(text);
    assert.ok(body.endsWith(block), 'A5 block whole at the end');
    assert.ok(body.length <= 8000, `A5 length ${body.length} over 8000`);
    assert.ok(body.slice(0, -block.length).trimEnd().endsWith(' …'), 'A5 prose cut shows the mark');
  });

  // A6: every other cap keeps its value.
  await run('A6', async () => assert.deepStrictEqual(
    { headline: prompt.CAPS.headline, body: prompt.CAPS.body, summary: prompt.CAPS.summary, row: prompt.CAPS.row, sendText: prompt.CAPS.sendText, personText: prompt.CAPS.personText, excerpt: prompt.CAPS.excerpt, label: prompt.CAPS.label, batch: prompt.CAPS.batch },
    { headline: 120, body: 400, summary: 300, row: 160, sendText: 2000, personText: 2000, excerpt: 500, label: 80, batch: 10 },
    'A6 caps'));

  if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
  console.log('cos-reply selftest: ok');
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
