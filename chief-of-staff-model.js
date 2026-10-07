/**
 * ChiefOfStaffModel - one long-lived, hidden relay session the Chief of Staff
 * writes through. Design: docs/design-chief-of-staff.md.
 *
 * The session has exactly the tools it is allowed (`allowedTools`; none for the
 * wake session). relay has no "no tools" switch, so eve sends a deny list of the
 * built-ins (minus the allowed ones) and then checks the session's own
 * `system/init` on a bootstrap turn that carries no agent data. A session that
 * lists a tool outside the allow-list is relaunched once with those tools
 * denied; if it still lists any, lacks an allowed tool, or never reports a
 * list, the model stays off. Agent text is sent only after that check passes.
 *
 * Calls are unscoped on purpose: the model session is an ordinary session
 * (no `agent`, so it stays unlisted), not part of the read-only scoped surface.
 */
const crypto = require('crypto');
const { systemPrompt, personSystemPrompt, bootstrapPrompt } = require('./chief-of-staff-prompt');

const HIDDEN_COS_PREFIX = '__cos:';
const DEFAULT_TURN_TIMEOUT_MS = 120 * 1000;
const DEFAULT_OPEN_TIMEOUT_MS = 15 * 1000;

// What a default Claude Code session lists in `system/init`, plus the older
// built-in names a Claude Code release may still report. A name that does not
// exist is harmless to deny. `mcp__*` denies every MCP tool: user-scope and
// claude.ai connector servers differ per machine and still load in a headless
// session, so naming them one by one is not enough. The init check stays the proof.
const BUILTIN_TOOLS = Object.freeze([
  'Agent', 'AskUserQuestion', 'Bash', 'BashOutput', 'CronCreate', 'CronDelete', 'CronList',
  'DesignSync', 'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
  'Glob', 'Grep', 'KillShell', 'ListAgents', 'LSP', 'Monitor', 'MultiEdit', 'NotebookEdit',
  'NotebookRead', 'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings',
  'ScheduleWakeup', 'SendMessage', 'Skill', 'SlashCommand', 'Task', 'TaskCreate', 'TaskGet',
  'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch',
  'Workflow', 'Write', 'mcp__*',
]);

// The person session's whole tool set: read-only built-ins and the eve-cos MCP
// as relay names it. Anything else in its `system/init` keeps the model off.
const PERSON_ALLOWED_TOOLS = Object.freeze([
  'Read', 'Grep', 'Glob',
  'mcp__relay__cos_list_sessions', 'mcp__relay__cos_session_status',
  'mcp__relay__cos_propose_start', 'mcp__relay__cos_propose_send',
]);

// The turn's text: every finished message, then any deltas not yet closed by one.
function replyText(p) {
  return (p.deltas ? [...p.parts, p.deltas] : p.parts).join('\n\n');
}

class ModelError extends Error {
  // code: limit | launch_failed | tools_present | tools_missing | tools_unverified | turn_failed | timeout | disconnected,
  // or the CLI's API error code (authentication_failed, ...) with its HTTP status.
  constructor(code, message, { tools, status } = {}) {
    super(message || code);
    this.name = 'ModelError';
    this.code = code;
    if (tools) this.tools = tools;
    if (status) this.status = status;
  }
}

class ChiefOfStaffModel {
  /**
   * @param {object} opts
   * @param {object} opts.relayTransport  RelayTransport; unscoped fetch + createWebSocket only
   * @param {() => boolean} opts.countCall  counts one model call; false = daily limit reached
   * @param {string|null} [opts.previousSessionId]  last run's session, DELETEd before the first launch
   * @param {(id: string|null) => void} [opts.onSessionId]  called when the live session id changes
   * @param {(e: {sessionId: string, toolUseId: string, name: string, input: object}) => void} [opts.onToolUse]
   *   fires once per tool_use id, when its content block stops
   * @param {string[]} [opts.extraDeniedTools]
   * @param {string[]} [opts.allowedTools]  the only tools the session may list; none by default
   * @param {object} [opts.sessionSettings]  merged into the create body's `settings`
   * @param {'wake'|'person'} [opts.kind]  picks the system prompt; wake by default
   * @param {object} [opts.log]
   * @param {number} [opts.openTimeoutMs]
   */
  constructor({ relayTransport, countCall, previousSessionId = null, onSessionId, onToolUse, extraDeniedTools = [], allowedTools = [], sessionSettings = {}, kind = 'wake', log, openTimeoutMs } = {}) {
    if (!relayTransport) throw new Error('relayTransport required');
    if (typeof countCall !== 'function') throw new Error('countCall required');
    this.relayTransport = relayTransport;
    this.countCall = countCall;
    this.onSessionId = typeof onSessionId === 'function' ? onSessionId : () => {};
    this.onToolUse = typeof onToolUse === 'function' ? onToolUse : () => {};
    this.extraDeniedTools = Array.isArray(extraDeniedTools) ? extraDeniedTools.slice() : [];
    this.allowedTools = Array.isArray(allowedTools) ? allowedTools.filter((t) => typeof t === 'string') : [];
    this.sessionSettings = sessionSettings && typeof sessionSettings === 'object' ? { ...sessionSettings } : {};
    this.kind = kind;
    this.log = log?.child ? log.child('ChiefOfStaffModel') : log;
    this.openTimeoutMs = openTimeoutMs || DEFAULT_OPEN_TIMEOUT_MS;
    this._previousSessionId = previousSessionId || null;
    this._session = null;
    this._chain = Promise.resolve();
  }

  get sessionId() { return this._session?.alive ? this._session.id : null; }
  get projectId() { return this._session?.alive ? this._session.projectId : null; }
  get modelId() { return this._session?.alive ? this._session.modelId : null; }

  /** Serialised: one turn at a time. Resolves {text, modelId}; rejects ModelError. */
  turn(text, { projectId, directory, model, timeoutMs } = {}) {
    const run = () => this._turn(text, { projectId, directory, model, timeoutMs: timeoutMs || DEFAULT_TURN_TIMEOUT_MS });
    const result = this._chain.then(run, run);
    this._chain = result.catch(() => {});
    return result;
  }

  /** Ends the session (DELETE, best effort). Safe to call twice. */
  async close() {
    await this._chain.catch(() => {});
    if (this._session) await this._kill(this._session, 'close');
  }

  async _turn(text, opts) {
    const key = `${opts.projectId}|${opts.model}|${opts.directory}`;
    if (this._session?.alive && this._session.key !== key) await this._kill(this._session, 'config changed');
    if (!this._session?.alive) await this._launch(opts, key);
    const s = this._session;
    const out = await this._exchange(s, text, opts.timeoutMs);
    return { text: out, modelId: s.modelId };
  }

  // ---- launch -------------------------------------------------------------

  async _launch(opts, key) {
    if (this._previousSessionId) {
      const old = this._previousSessionId;
      this._previousSessionId = null;
      await this._deleteSession(old);
    }

    let denied = this._baseDenied();
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this._createSession(opts, key, denied);
      this._session = s;
      this.onSessionId(s.id);
      try {
        await this._bootstrap(s, opts.timeoutMs);
        return;
      } catch (err) {
        await this._kill(s, err.code || 'bootstrap failed');
        // First sight of tools: deny exactly what it lists and try once more.
        if (err.code === 'tools_present' && attempt === 0 && err.tools?.length) {
          denied = [...new Set([...denied, ...err.tools])];
          continue;
        }
        throw err;
      }
    }
  }

  // The built-ins minus what the session may use. `mcp__*` stays denied unless
  // an MCP tool is allowed; the init check then names every extra one.
  _baseDenied() {
    const allowMcp = this.allowedTools.some((t) => t.startsWith('mcp__'));
    const kept = BUILTIN_TOOLS.filter((t) => !this.allowedTools.includes(t) && !(allowMcp && t === 'mcp__*'));
    return [...kept, ...this.extraDeniedTools];
  }

  async _createSession(opts, key, deniedTools) {
    const name = `${HIDDEN_COS_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
    let res;
    try {
      res = await this.relayTransport.fetch('POST', '/api/sessions', {
        projectId: opts.projectId,
        directory: opts.directory,
        name,
        model: opts.model,
        systemPrompt: this.kind === 'person' ? personSystemPrompt() : systemPrompt(),
        appendClaudeMd: false,
        settings: { headless: true, ...this.sessionSettings, permissionPolicy: { deniedTools } },
      });
    } catch (err) {
      throw new ModelError('launch_failed', `Session create failed: ${err.message}`);
    }
    if (res.status < 200 || res.status >= 300 || typeof res.data?.sessionId !== 'string') {
      const why = (res.data && res.data.error) || `status ${res.status}`;
      throw new ModelError('launch_failed', `Session create failed: ${why}`);
    }

    const s = {
      id: res.data.sessionId,
      key,
      projectId: opts.projectId,
      toolUseIds: new Set(),
      ws: null,
      alive: true,
      modelId: null,
      sawInit: false,
      pending: null,
    };
    try {
      await this._openSocket(s);
    } catch (err) {
      s.alive = false;
      s.deleted = true;
      await this._deleteSession(s.id);
      throw err;
    }
    return s;
  }

  _openSocket(s) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this.relayTransport.createWebSocket('/ws');
      } catch (err) {
        reject(new ModelError('launch_failed', `Relay socket failed: ${err.message}`));
        return;
      }
      s.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        try { ws.close(); } catch { /* already closed */ }
        reject(new ModelError('launch_failed', 'Relay socket did not open in time'));
      }, this.openTimeoutMs);
      if (timer.unref) timer.unref();

      ws.on('open', () => {
        opened = true;
        clearTimeout(timer);
        this._send(s, { type: 'join_session', sessionId: s.id });
        resolve();
      });
      ws.on('message', (data) => this._onFrame(s, data));
      ws.on('error', (err) => {
        if (!opened) {
          clearTimeout(timer);
          reject(new ModelError('launch_failed', `Relay socket failed: ${err.message}`));
        }
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (!opened) {
          reject(new ModelError('launch_failed', 'Relay socket closed before it opened'));
          return;
        }
        if (s.alive) {
          s.alive = false;
          this._settle(s, new ModelError('disconnected', 'Relay socket closed'));
          this._kill(s, 'socket closed');
        }
      });
    });
  }

  // The tool check. Nothing but this prompt is sent until it passes.
  async _bootstrap(s, timeoutMs) {
    if (!this.countCall()) throw new ModelError('limit', 'Daily model-call limit reached');
    await this._exchangeRaw(s, bootstrapPrompt(), timeoutMs);
    if (!s.sawInit) {
      throw new ModelError('tools_unverified', 'The session reported no tool list before it answered');
    }
  }

  // ---- turns --------------------------------------------------------------

  async _exchange(s, text, timeoutMs) {
    if (!this.countCall()) throw new ModelError('limit', 'Daily model-call limit reached');
    return this._exchangeRaw(s, text, timeoutMs);
  }

  _exchangeRaw(s, text, timeoutMs) {
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, parts: [], deltas: '', timer: null };
      pending.timer = setTimeout(() => {
        this._send(s, { type: 'stop_generation', sessionId: s.id });
        // The late message_complete would land in the next turn, so the session ends here.
        this._settle(s, new ModelError('timeout', `Model turn timed out after ${Math.round(timeoutMs / 1000)}s`));
        this._kill(s, 'timeout');
      }, timeoutMs);
      if (pending.timer.unref) pending.timer.unref();
      s.pending = pending;
      if (!this._send(s, { type: 'send_message', text, files: [], sessionId: s.id })) {
        this._settle(s, new ModelError('disconnected', 'Relay socket is not open'));
        this._kill(s, 'send failed');
      }
    });
  }

  _send(s, frame) {
    const ws = s.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  _onFrame(s, data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    // Only this session's frames. The one frame type that may lack an id is
    // `error`, and only while a turn is waiting, since this socket carries one session.
    if (msg.sessionId && msg.sessionId !== s.id) return;
    if (!msg.sessionId && msg.type !== 'error') return;

    switch (msg.type) {
      case 'llm_event':
        this._onEvent(s, msg.event);
        break;
      case 'message_complete':
        if (!s.pending) break;
        if (s.pending.apiError || (msg.isError && msg.apiErrorStatus)) {
          // The CLI's synthetic error text is not a reply; never resolve with it.
          const code = s.pending.apiError || 'api_error';
          const status = Number(msg.apiErrorStatus) || 0;
          this._settle(s, new ModelError(code, `Model API error: ${code}${status ? ` (HTTP ${status})` : ''}`, { status }));
          this._kill(s, 'api error');
        } else if (msg.error) {
          this._settle(s, new ModelError('turn_failed', String(msg.error)));
        } else {
          const p = s.pending;
          this._settle(s, null, replyText(p));
        }
        break;
      case 'error':
      case 'process_exited':
      case 'session_ended':
      case 'resume_required':
        if (!s.pending && !msg.sessionId) break;
        this._settle(s, new ModelError('turn_failed', String(msg.message || msg.error || msg.type)));
        this._kill(s, msg.type);
        break;
      default:
        break;
    }
  }

  _onEvent(s, ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (typeof ev.model === 'string' && ev.model) s.modelId = ev.model;
      // Only a real list proves anything. relay's pi and codex providers send
      // `"tools": null`; that is "unknown", and the bootstrap fails closed on it.
      if (!Array.isArray(ev.tools)) return;
      s.sawInit = true;
      const tools = ev.tools.filter((t) => typeof t === 'string');
      // Any init that differs from the allowed set, at any time, ends the
      // session before more can be sent.
      const extras = tools.filter((t) => !this.allowedTools.includes(t));
      const missing = this.allowedTools.filter((t) => !tools.includes(t));
      if (extras.length > 0) {
        this._settle(s, new ModelError('tools_present', `The session lists tools: ${extras.join(', ')}`, { tools: extras }));
        this._kill(s, 'tools present');
      } else if (missing.length > 0) {
        this._settle(s, new ModelError('tools_missing', `The session lacks tools: ${missing.join(', ')}`, { tools: missing }));
        this._kill(s, 'tools missing');
      }
      return;
    }
    if (ev.type !== 'assistant' || !s.pending) return;
    if (typeof ev.error === 'string' && ev.error) s.pending.apiError = ev.error;
    this._noteToolUse(s, ev);
    // Deltas and whole messages can both arrive; per message, deltas win when
    // present. A tool-using turn has several messages, and the reply is all of them.
    const p = s.pending;
    if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      p.deltas += ev.delta.text;
    }
    const content = ev.message?.content;
    if (Array.isArray(content)) {
      const blocks = content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
      const text = p.deltas || blocks;
      p.deltas = '';
      if (text) p.parts.push(text);
    }
  }

  // A tool_use is complete when its content block stops. A throwing listener
  // must not break the turn.
  _noteToolUse(s, ev) {
    const b = ev.content_block;
    if (ev.content_block_stop !== true || !b || b.type !== 'tool_use') return;
    if (typeof b.id !== 'string' || !b.id || s.toolUseIds.has(b.id)) return;
    s.toolUseIds.add(b.id);
    try {
      this.onToolUse({ sessionId: s.id, toolUseId: b.id, name: String(b.name || ''), input: b.input && typeof b.input === 'object' ? b.input : {} });
    } catch (err) {
      this.log?.warn?.(`onToolUse listener failed: ${err.message}`);
    }
  }

  _settle(s, err, value) {
    const p = s.pending;
    if (!p) return;
    s.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  // ---- teardown -----------------------------------------------------------

  _closeSocket(s) {
    const ws = s.ws;
    s.ws = null;
    if (!ws) return;
    try { ws.close(); } catch { /* already closed */ }
  }

  async _kill(s, reason) {
    s.alive = false;
    this._settle(s, new ModelError('disconnected', `Session ended: ${reason}`));
    this._closeSocket(s);
    if (this._session === s) this._session = null;
    // Each session is deleted once, whichever path ended it first.
    if (!s.deleted) {
      s.deleted = true;
      this.onSessionId(null);
      await this._deleteSession(s.id);
    }
  }

  async _deleteSession(sessionId) {
    try {
      await this.relayTransport.fetch('DELETE', `/api/sessions/${sessionId}`);
    } catch (err) {
      this.log?.warn?.(`Failed to delete session ${String(sessionId).slice(0, 8)}: ${err.message}`);
    }
  }
}

module.exports = ChiefOfStaffModel;
module.exports.ChiefOfStaffModel = ChiefOfStaffModel;
module.exports.ModelError = ModelError;
module.exports.BUILTIN_TOOLS = BUILTIN_TOOLS;
module.exports.PERSON_ALLOWED_TOOLS = PERSON_ALLOWED_TOOLS;
module.exports.HIDDEN_COS_PREFIX = HIDDEN_COS_PREFIX;
