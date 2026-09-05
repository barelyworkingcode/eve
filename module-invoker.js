// Cancellation via stop() sends relay's stop_generation; the resulting
// message_complete still flows through the regular handler, so callers must
// not also reject/resolve locally (would double-resolve).
const crypto = require('crypto');

const HIDDEN_SESSION_PREFIX = '__module:';
const RELAY_TIMEOUT_MS = 5 * 60 * 1000;

class ModuleInvoker {
  constructor({ relayTransport, moduleService, fileService, resolveProject, log }) {
    this.relayTransport = relayTransport;
    this.moduleService = moduleService;
    this.fileService = fileService;
    this.resolveProject = resolveProject;
    this.log = log?.child ? log.child('ModuleInvoker') : log;

    this.active = new Map();
  }

  // Throws on validation/setup errors before the session is created; once
  // created, cleanup happens in the finally block below instead.
  async invoke({ requestId, projectId, moduleName, prompt, files = [], schema, model, relayClient, browserWs }) {
    if (!requestId) throw new Error('requestId required');
    if (!projectId || !moduleName) throw new Error('projectId and moduleName required');
    if (!prompt) throw new Error('prompt required');
    if (!relayClient) throw new Error('relayClient required');

    const project = this.resolveProject(projectId);
    if (!project) throw new Error('Project not found');
    if (project.hostId) throw new Error('Modules are not available on a host project');

    const manifest = await this.moduleService.getModule(project.path, moduleName);
    const denied = files.filter(f => !this.moduleService.isFilePermitted(manifest, f));
    if (denied.length > 0) {
      const err = new Error(`Permission denied for files: ${denied.join(', ')}`);
      err.deniedFiles = denied;
      throw err;
    }

    // Server-side so the module never needs tool-use access for plain reads.
    // Partial context is worse than none — any failure aborts the invocation.
    const fileBlocks = await Promise.all(files.map(f =>
      this.fileService.readFile(project.path, f).then(({ content }) =>
        `<file path="${f}">\n${content}\n</file>`
      )
    ));

    const resolvedModel = model || manifest.model || (project.allowedModels || [])[0] || '';
    const allowedTools = manifest.permissions?.tools || [];
    if (allowedTools.length > 0 && !project.id) {
      throw new Error(
        `Module "${moduleName}" declares permissions.tools but has no project context. ` +
        `Tools cannot authenticate to relay without a project — relay brokers the scoped token by project id.`
      );
    }
    const systemPrompt = buildSystemPrompt({
      moduleName, displayName: manifest.displayName, files: fileBlocks, schema,
      tools: allowedTools,
      projectRoot: project.path,
    });

    const sessionId = await this._createHiddenSession({
      projectId, directory: project.path, moduleName, model: resolvedModel,
      allowedTools,
    });
    const t0 = Date.now();

    sendFrame(relayClient, browserWs, {
      type: 'module_ai_started',
      requestId, projectId, moduleName, sessionId, model: resolvedModel,
    });

    let rawText = '';
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

    const timeoutTimer = setTimeout(() => {
      if (!this.active.has(requestId)) return;
      rejectDone(new Error(`Module invocation timed out after ${Math.round(RELAY_TIMEOUT_MS / 1000)}s`));
    }, RELAY_TIMEOUT_MS);

    const handler = (msg) => {
      rawText += accumulateAssistantText(msg);
      sendFrame(relayClient, browserWs, {
        type: 'module_ai_event', requestId, sessionId, event: msg,
      });
      if (msg.type === 'message_complete') {
        if (msg.error) rejectDone(new Error(msg.error));
        else resolveDone();
      } else if (msg.type === 'error') {
        rejectDone(new Error(msg.message || 'Module session error'));
      }
    };

    relayClient.registerModuleSession(sessionId, handler);
    this.active.set(requestId, { sessionId, relayClient });

    try {
      relayClient.joinSession(sessionId);
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      relayClient.sendMessage(fullPrompt, [], sessionId);

      this.log?.info(`invoke ${moduleName} session=${sessionId.slice(0, 8)} model=${resolvedModel || '(default)'} files=[${files.join(',')}]`);

      await done;

      const result = schema ? extractJson(rawText) : rawText;
      this.log?.info(`invoke ${moduleName} ← ${rawText.length} chars in ${Date.now() - t0}ms (session ${sessionId.slice(0, 8)})`);
      return { result, rawText, model: resolvedModel, sessionId };
    } finally {
      clearTimeout(timeoutTimer);
      relayClient.unregisterModuleSession(sessionId);
      this.active.delete(requestId);
      // Best-effort: a DELETE failure orphans the session in relayLLM but
      // doesn't affect the user-visible flow.
      this.relayTransport.fetch('DELETE', `/api/sessions/${sessionId}`).catch(err => {
        this.log?.error(`Failed to delete ephemeral session ${sessionId.slice(0, 8)}: ${err.message}`);
      });
    }
  }

  /**
   * `__module:` prefix is load-bearing — filters these sessions out of
   * /api/sessions and the user's sidebar (see routes/index.js). When
   * permissions.tools is declared: relay brokers the project-scoped MCP
   * token itself from projectId (Eve never holds it), and bypassPermissions
   * is required because the orb has no UI to answer permission prompts.
   */
  async _createHiddenSession({ projectId, directory, moduleName, model, allowedTools }) {
    const sessionName = `${HIDDEN_SESSION_PREFIX}${moduleName}:${crypto.randomBytes(6).toString('hex')}`;
    const hasTools = allowedTools && allowedTools.length > 0;
    const create = await this.relayTransport.fetch('POST', '/api/sessions', {
      projectId,
      directory,
      name: sessionName,
      model,
      systemPrompt: '',
      appendClaudeMd: false,
      settings: hasTools ? {
        useRelayTools: true,
        permissionPolicy: {
          allowedTools,
          deniedTools: [],
          defaultMode: 'bypassPermissions',
        },
      } : null,
    });
    if (create.status < 200 || create.status >= 300) {
      throw new Error((create.data && create.data.error) || `Session create failed (${create.status})`);
    }
    return create.data.sessionId;
  }

  // Idempotent for unknown requestIds so stray clicks after completion don't error.
  stop(requestId) {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    try {
      entry.relayClient.stopGeneration(entry.sessionId);
    } catch (err) {
      this.log?.warn(`stop(${requestId}): ${err.message}`);
    }
    return true;
  }
}

function sendFrame(relayClient, browserWs, payload) {
  if (relayClient?.browserWs === browserWs) {
    relayClient.sendToBrowser(payload);
    return;
  }
  // In tests the relayClient may not be the one that owns browserWs.
  if (browserWs && browserWs.readyState === 1) {
    try { browserWs.send(JSON.stringify(payload)); } catch { /* socket closed */ }
  }
}

// Mirrors the pattern in RelayClient._handleTTSAccumulation — kept local
// because the consumers have different downstream goals (audio vs schema
// parsing) and a shared abstraction would need to expose internals from both.
function accumulateAssistantText(msg) {
  if (msg.type !== 'llm_event' || msg.event?.type !== 'assistant') return '';
  const ev = msg.event;
  let out = '';
  if (ev.delta?.type === 'text_delta' && ev.delta.text) out += ev.delta.text;
  if (ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) out += block.text;
    }
  }
  if (ev.content_block?.type === 'text' && ev.content_block.text) {
    out += ev.content_block.text;
  }
  return out;
}

function buildSystemPrompt({ moduleName, displayName, files, schema, tools, projectRoot }) {
  const parts = [
    `You are the AI backend for the "${displayName}" module (id: ${moduleName}) running inside the Eve workspace.`,
    `Respond directly and concisely. Do not explain your reasoning unless asked.`,
  ];
  if (tools && tools.length > 0) {
    // Relay tools don't chdir to the session directory — they require
    // absolute paths, or the model's first tool call errors.
    parts.push(
      `\nYou have these tools available: ${tools.join(', ')}. ` +
      `The project root is \`${projectRoot}\`. ` +
      `Tool paths must be ABSOLUTE — always prefix relative paths with the ` +
      `project root (e.g. \`${projectRoot}/todo.md\`, not \`todo.md\`). ` +
      `Use tools when the task requires reading, writing, or searching ` +
      `files. Prefer the inlined context files above when they already ` +
      `contain what you need.`
    );
  }
  if (files.length > 0) {
    parts.push(`\nContext files (relative to the project root):\n${files.join('\n\n')}`);
  }
  if (schema) {
    parts.push(
      `\nYou MUST respond with a single JSON value matching this schema. Output ONLY the JSON, no prose, no markdown fences:\n` +
      JSON.stringify(schema, null, 2)
    );
  }
  return parts.join('\n');
}

// The model is told to return raw JSON, but some providers wrap it in
// ```json fences anyway — strip them before parsing.
function extractJson(text) {
  let s = String(text || '').trim();
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  return JSON.parse(s);
}

module.exports = ModuleInvoker;
module.exports.HIDDEN_SESSION_PREFIX = HIDDEN_SESSION_PREFIX;
