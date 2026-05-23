/**
 * SearchSummarizer - one-shot LLM call that turns ripgrep matches into a
 * short natural-language summary. Forked from module-invoker.js's hidden
 * ephemeral-session pattern, with the module-specific machinery (manifest,
 * file inlining, tool permissions, schema parsing) stripped out.
 *
 * Lifecycle:
 *   1. POST /api/sessions  (name "__search:<rand>") — invisible to the user
 *   2. relayClient.registerModuleSession(sid, handler) — intercept relay frames
 *   3. join_session + send_message
 *   4. Accumulate assistant text; forward each frame as `search_ai_event`
 *   5. On message_complete → `search_ai_completed` (or `search_ai_failed`)
 *   6. finally: unregisterModuleSession + DELETE /api/sessions/<sid>
 */
const crypto = require('crypto');

const HIDDEN_SEARCH_PREFIX = '__search:';
const RELAY_TIMEOUT_MS = 60 * 1000;

// Cost-control limits enforced server-side. The client passes a match list
// but we never trust it — it could omit or exceed these.
// Named distinctly from SearchService.MAX_SUMMARY_MATCHES (the ripgrep result cap of 500).
const MAX_SUMMARY_MATCHES = 50;
const MAX_SNIPPET_LEN = 120;

class SearchSummarizer {
  constructor({ relayTransport, resolveProject, log }) {
    this.relayTransport = relayTransport;
    this.resolveProject = resolveProject;
    this.log = log?.child ? log.child('SearchSummarizer') : log;
    // requestId -> { sessionId, relayClient }
    this.active = new Map();
  }

  /**
   * Fire-and-forget; outcomes are delivered to the browser via `search_ai_*`
   * WS frames. The returned promise resolves/rejects so the caller (ws-handler)
   * can log final status, but the user-facing flow doesn't depend on it.
   */
  async run({ requestId, projectId, query, matches, model, relayClient, browserWs }) {
    if (!requestId) throw new Error('requestId required');
    if (!projectId) throw new Error('projectId required');
    if (!query || typeof query !== 'string') throw new Error('query required');
    if (!relayClient) throw new Error('relayClient required');

    const project = this.resolveProject(projectId);
    if (!project) throw new Error('Project not found');

    const resolvedModel = model || (project.allowedModels || [])[0] || '';
    const prompt = buildPrompt(query, matches, project.name || '');

    const sessionId = await this._createHiddenSession({
      projectId, directory: project.path, model: resolvedModel,
    });
    const t0 = Date.now();

    sendFrame(relayClient, browserWs, {
      type: 'search_ai_started',
      requestId, projectId, sessionId, model: resolvedModel,
    });

    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

    const timeoutTimer = setTimeout(() => {
      if (!this.active.has(requestId)) return;
      // Stop the relay generation explicitly — otherwise the LLM keeps
      // burning tokens until its own server-side timeout long after we've
      // already given up on the response.
      try { relayClient.stopGeneration(sessionId); } catch { /* ignore */ }
      rejectDone(new Error(`Summary timed out after ${Math.round(RELAY_TIMEOUT_MS / 1000)}s`));
    }, RELAY_TIMEOUT_MS);

    const handler = (msg) => {
      // Forward the raw relay frame so the client can re-use its existing
      // text-accumulation walk (same shape as module_ai_event).
      sendFrame(relayClient, browserWs, {
        type: 'search_ai_event', requestId, sessionId, event: msg,
      });
      if (msg.type === 'message_complete') {
        if (msg.error) rejectDone(new Error(msg.error));
        else resolveDone();
      } else if (msg.type === 'error') {
        rejectDone(new Error(msg.message || 'Summary session error'));
      }
    };

    relayClient.registerModuleSession(sessionId, handler);
    this.active.set(requestId, { sessionId, relayClient });

    try {
      relayClient.joinSession(sessionId);
      relayClient.sendMessage(prompt, [], sessionId);
      this.log?.info(`summary req=${requestId.slice(0, 8)} session=${sessionId.slice(0, 8)} model=${resolvedModel || '(default)'}`);

      await done;

      sendFrame(relayClient, browserWs, {
        type: 'search_ai_completed',
        requestId, sessionId, model: resolvedModel, durationMs: Date.now() - t0,
      });
      this.log?.info(`summary req=${requestId.slice(0, 8)} done in ${Date.now() - t0}ms`);
      return { sessionId, model: resolvedModel };
    } catch (err) {
      sendFrame(relayClient, browserWs, {
        type: 'search_ai_failed',
        requestId, sessionId, error: err.message || 'Summary failed',
      });
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      relayClient.unregisterModuleSession(sessionId);
      this.active.delete(requestId);
      this.relayTransport.fetch('DELETE', `/api/sessions/${sessionId}`).catch(err => {
        this.log?.error(`Failed to delete ephemeral session ${sessionId.slice(0, 8)}: ${err.message}`);
      });
    }
  }

  /**
   * Cancel an in-flight summary. Idempotent — stray stops after completion
   * silently no-op. The resulting message_complete still flows through the
   * handler, so we don't reject locally.
   */
  stop(requestId) {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    try {
      entry.relayClient.stopGeneration(entry.sessionId);
    } catch (err) {
      this.log?.warn?.(`stop(${requestId}): ${err.message}`);
    }
    return true;
  }

  async _createHiddenSession({ projectId, directory, model }) {
    const sessionName = `${HIDDEN_SEARCH_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
    const create = await this.relayTransport.fetch('POST', '/api/sessions', {
      projectId,
      directory,
      name: sessionName,
      model,
      systemPrompt: '',
      appendClaudeMd: false,
      mcpToken: '',          // text-only; no tools
      settings: null,
    });
    if (create.status < 200 || create.status >= 300) {
      throw new Error((create.data && create.data.error) || `Session create failed (${create.status})`);
    }
    return create.data.sessionId;
  }
}

function sendFrame(relayClient, browserWs, payload) {
  if (relayClient?.browserWs === browserWs) {
    relayClient.sendToBrowser(payload);
    return;
  }
  if (browserWs && browserWs.readyState === 1) {
    try { browserWs.send(JSON.stringify(payload)); } catch { /* socket closed */ }
  }
}

/**
 * Build the single user-turn prompt sent to the model. The system-prompt
 * portion is folded in here (relayLLM's `systemPrompt` is left empty) so we
 * keep one place to inspect when tuning the output.
 *
 * Match list is capped at MAX_SUMMARY_MATCHES; each snippet is clamped to
 * MAX_SNIPPET_LEN chars. These are independent of whatever the client sent.
 */
function buildPrompt(query, matches, projectName) {
  const safeMatches = Array.isArray(matches) ? matches.slice(0, MAX_SUMMARY_MATCHES) : [];
  const total = Array.isArray(matches) ? matches.length : 0;

  const lines = [
    'You are a code-search summarizer. The user just ran a project-wide search; your job is to help them orient before they click into individual files.',
    '',
    'Write 2–3 short sentences in plain prose. Focus on:',
    '  • Which modules / areas the matches cluster in.',
    '  • Any obvious pattern (definitions, call sites, tests, docs).',
    '  • Anything that looks like an outlier worth a click.',
    '',
    'Do NOT list every file. Do NOT add headings, bullets, or markdown. Just the prose summary.',
    '',
    `Project: ${projectName || '(unnamed)'}`,
    `Search query: ${JSON.stringify(query)}`,
    `Total matches: ${total}${total > safeMatches.length ? ` (showing first ${safeMatches.length})` : ''}`,
    '',
    'Matches:',
  ];

  for (const m of safeMatches) {
    const file = String(m?.file || '').slice(0, 200);
    const lineNumber = Number.isFinite(m?.lineNumber) ? m.lineNumber : 0;
    let snippet = String(m?.lineText || '').replace(/\s+/g, ' ').trim();
    if (snippet.length > MAX_SNIPPET_LEN) {
      snippet = snippet.slice(0, MAX_SNIPPET_LEN) + '…';
    }
    lines.push(`  ${file}:${lineNumber}  ${snippet}`);
  }

  return lines.join('\n');
}

module.exports = SearchSummarizer;
module.exports.HIDDEN_SEARCH_PREFIX = HIDDEN_SEARCH_PREFIX;
module.exports.MAX_SUMMARY_MATCHES = MAX_SUMMARY_MATCHES;
module.exports.MAX_SNIPPET_LEN = MAX_SNIPPET_LEN;
module.exports._buildPrompt = buildPrompt; // exposed for tests
