/**
 * SECURITY MODEL:
 *  - Iframe sandbox must never gain allow-same-origin — the opaque origin
 *    is the isolation.
 *  - The postMessage bridge authenticates by matching event.source to the
 *    iframe's contentWindow. Scope (projectId/moduleName) is injected by
 *    the host from that lookup, never accepted from the iframe — an
 *    AI-authored iframe would otherwise be able to claim to be a
 *    different module.
 *  - Manifest permissions are re-read on every gated call server-side,
 *    because an AI can rewrite the manifest between calls.
 */
class ModuleHost {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ModuleHost');
    this.state = container.get('state');
    this.api = container.get('api');

    this.iframes = new Map();
    this.windowToCtx = new WeakMap();
    this._pendingFileOps = new Map();
    this._fileOpSeq = 1;
    this._pendingInvokes = new Map();
    this._invokeSeq = 1;
    this._host = null;
  }

  init() {
    this._host = document.getElementById('moduleContent');
    if (!this._host) {
      this.log.warn('No #moduleContent element found; module iframes will not render');
    }
    window.addEventListener('message', (event) => this._handleMessage(event));

    this.bus.on(EVT.MODULE_FILE_RESPONSE, (msg) => {
      const entry = this._pendingFileOps.get(msg.requestId);
      if (!entry) return;
      this._pendingFileOps.delete(msg.requestId);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg);
      else entry.reject(new Error(msg.error || 'Unknown error'));
    });

    this.bus.on(EVT.MODULE_AI_COMPLETED, (msg) => {
      const entry = this._pendingInvokes.get(msg.requestId);
      if (!entry) return;
      this._pendingInvokes.delete(msg.requestId);
      clearTimeout(entry.timer);
      entry.resolve({ result: msg.result, model: msg.model });
    });

    this.bus.on(EVT.MODULE_AI_FAILED, (msg) => {
      const entry = this._pendingInvokes.get(msg.requestId);
      if (!entry) return;
      this._pendingInvokes.delete(msg.requestId);
      clearTimeout(entry.timer);
      const denied = msg.deniedFiles;
      const errMsg = denied ? `${msg.error} (denied: ${denied.join(', ')})` : (msg.error || 'Module invocation failed');
      entry.reject(new Error(errMsg));
    });
  }

  async activate(tab) {
    if (!this._host) return;

    let entry = this.iframes.get(tab.id);
    if (!entry) {
      const pending = this._createIframe(tab);
      this.iframes.set(tab.id, { pending });
      try {
        entry = await pending;
      } finally {
        if (!entry) this.iframes.delete(tab.id);
      }
      if (!entry) return;
    } else if (entry.pending) {
      entry = await entry.pending;
      if (!entry) return;
    }

    for (const [id, e] of this.iframes) {
      if (id !== tab.id && e.iframeEl) e.iframeEl.classList.add('hidden');
    }
    entry.iframeEl.classList.remove('hidden');
  }

  async _createIframe(tab) {
    const { projectId, moduleName } = tab;
    let manifest;
    try {
      manifest = await this._fetchManifest(projectId, moduleName);
    } catch (err) {
      this._showError(`Failed to load module: ${err.message}`);
      return null;
    }

    const iframeEl = document.createElement('iframe');
    iframeEl.className = 'module-host__iframe';
    iframeEl.setAttribute('sandbox', 'allow-scripts');
    iframeEl.setAttribute('data-tab-id', tab.id);
    iframeEl.setAttribute('referrerpolicy', 'no-referrer');
    iframeEl.src = `/api/modules/serve/${encodeURIComponent(projectId)}/${encodeURIComponent(moduleName)}/${encodeURIComponent(manifest.entry || 'index.html')}`;
    this._host.appendChild(iframeEl);

    const ctx = { iframeEl, contentWindow: iframeEl.contentWindow, projectId, moduleName, manifest };
    if (ctx.contentWindow) {
      this.windowToCtx.set(ctx.contentWindow, ctx);
    }

    // Registered before load so a message arriving mid-navigation still
    // resolves, and again on load because navigating to src can replace the
    // contentWindow — an unregistered window fails authentication silently.
    iframeEl.addEventListener('load', () => {
      if (iframeEl.contentWindow && iframeEl.contentWindow !== ctx.contentWindow) {
        ctx.contentWindow = iframeEl.contentWindow;
        this.windowToCtx.set(ctx.contentWindow, ctx);
      }
    });

    const slot = this.iframes.get(tab.id);
    if (!slot || !slot.pending) {
      iframeEl.remove();
      return null;
    }
    this.iframes.set(tab.id, ctx);
    this.bus.emit(EVT.MODULE_OPENED, { projectId, moduleName, tabId: tab.id });
    return ctx;
  }

  destroy(tabId) {
    const entry = this.iframes.get(tabId);
    if (!entry) return;
    if (entry.iframeEl) {
      try { entry.iframeEl.remove(); } catch {}
    }
    this.iframes.delete(tabId);
    if (entry.projectId) {
      this.bus.emit(EVT.MODULE_CLOSED, {
        tabId, projectId: entry.projectId, moduleName: entry.moduleName,
      });
    }
  }

  _fetchManifest(projectId, moduleName) {
    return this.api.getModuleManifest(projectId, moduleName);
  }

  _showError(message) {
    if (!this._host) return;
    const errEl = document.createElement('div');
    errEl.className = 'module-host__error';
    errEl.textContent = message;
    this._host.appendChild(errEl);
    setTimeout(() => errEl.remove(), 6000);
  }

  _handleMessage(event) {
    const data = event.data;
    if (!data || data.source !== 'eve-module-sdk') return;
    if (data.op === 'ready') return;

    const ctx = this.windowToCtx.get(event.source);
    if (!ctx) {
      this.log.debug('Dropped postMessage from unknown source');
      return;
    }

    this._logRequest(ctx, data);
    const startedAt = performance.now();

    this._dispatch(ctx, event.source, data).then(meta => {
      this._logResponse(ctx, data, meta, startedAt, null);
    }).catch(err => {
      this._logResponse(ctx, data, null, startedAt, err);
      this.log.error(`module op ${data.op} failed:`, err.message);
      this._respond(event.source, data.requestId, { ok: false, error: err.message });
    });
  }

  _logRequest(ctx, data) {
    const tag = `[module:${ctx.moduleName}]`;
    const model = data.op === 'invokeAI' ? this._resolveModelTag(ctx, data.args) : '';
    console.log(`${tag} ${data.op}${model} → ${this._summarize(data.args)}`);
  }

  _logResponse(ctx, data, meta, startedAt, err) {
    const tag = `[module:${ctx.moduleName}]`;
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
    if (err) {
      console.warn(`${tag} ${data.op} ✗ (${elapsed}s) ${err.message}`);
      return;
    }
    const model = meta?.model ? ` [${meta.model}]` : '';
    console.log(`${tag} ${data.op}${model} ← (${elapsed}s) ${this._summarize(meta?.value)}`);
  }

  _resolveModelTag(ctx, args) {
    const m = args?.model || ctx.manifest?.model || '(project default)';
    return ` [${m}]`;
  }

  _summarize(value) {
    if (value === undefined) return 'undefined';
    try { return typeof value === 'string' ? value : JSON.stringify(value); }
    catch { return String(value); }
  }

  async _dispatch(ctx, source, data) {
    const { requestId, op, args = {} } = data;
    switch (op) {
      case 'invokeAI':
        return this._invokeAI(ctx, source, requestId, args);
      case 'readFile':
        return this._readFile(ctx, source, requestId, args);
      case 'writeFile':
        return this._writeFile(ctx, source, requestId, args);
      case 'getManifest': {
        this._respond(source, requestId, { ok: true, result: ctx.manifest });
        return { value: ctx.manifest };
      }
      default:
        this._respond(source, requestId, { ok: false, error: `Unknown op: ${op}` });
        throw new Error(`Unknown op: ${op}`);
    }
  }

  _invokeAI(ctx, source, sdkRequestId, args) {
    const wsClient = this.container.get('ws');
    if (!wsClient) return Promise.reject(new Error('WebSocket unavailable'));

    return new Promise((resolve, reject) => {
      const serverRequestId = `inv${this._invokeSeq++}`;
      const timer = setTimeout(() => {
        // delete() as test-and-clear: its return value is the only thing
        // stopping a timeout from rejecting a request that already settled.
        if (this._pendingInvokes.delete(serverRequestId)) {
          reject(new Error('Module invocation timed out (no server response)'));
        }
      }, 6 * 60 * 1000);

      this._pendingInvokes.set(serverRequestId, {
        resolve, reject, timer,
        ctx, source, sdkRequestId,
      });

      wsClient.send({
        type: 'module_invoke_ai',
        requestId: serverRequestId,
        projectId: ctx.projectId,
        moduleName: ctx.moduleName,
        prompt: args.prompt || '',
        files: args.files || [],
        schema: args.schema,
        model: args.model,
      });
    }).then(payload => {
      this._respond(source, sdkRequestId, {
        ok: true, result: payload.result, meta: { model: payload.model },
      });
      return { value: payload.result, model: payload.model };
    });
  }

  stopInvoke(serverRequestId) {
    if (!this._pendingInvokes.has(serverRequestId)) return false;
    const wsClient = this.container.get('ws');
    if (!wsClient) return false;
    wsClient.send({ type: 'module_ai_stop', requestId: serverRequestId });
    return true;
  }

  async _readFile(ctx, source, requestId, args) {
    try {
      const reply = await this._sendModuleFileOp({
        type: 'module_read_file',
        projectId: ctx.projectId,
        moduleName: ctx.moduleName,
        path: args.path,
      });
      this._respond(source, requestId, { ok: true, result: reply.content });
      return { value: reply.content };
    } catch (err) {
      this._respond(source, requestId, { ok: false, error: err.message });
      throw err;
    }
  }

  async _writeFile(ctx, source, requestId, args) {
    try {
      await this._sendModuleFileOp({
        type: 'module_write_file',
        projectId: ctx.projectId,
        moduleName: ctx.moduleName,
        path: args.path,
        content: args.content || '',
      });
      this._respond(source, requestId, { ok: true });
      return { value: 'ok' };
    } catch (err) {
      this._respond(source, requestId, { ok: false, error: err.message });
      throw err;
    }
  }

  _sendModuleFileOp(message) {
    const wsClient = this.container.get('ws');
    if (!wsClient) return Promise.reject(new Error('WebSocket unavailable'));
    return new Promise((resolve, reject) => {
      const requestId = `mfo${this._fileOpSeq++}`;
      const timer = setTimeout(() => {
        if (this._pendingFileOps.delete(requestId)) {
          reject(new Error('Module file op timed out'));
        }
      }, 30 * 1000);
      this._pendingFileOps.set(requestId, { resolve, reject, timer });
      wsClient.send({ ...message, requestId });
    });
  }

  _respond(source, requestId, payload) {
    try {
      source.postMessage({
        source: 'eve-module-sdk-response',
        requestId,
        ...payload,
      }, '*');
    } catch (err) {
      this.log.error('Failed to post response to module:', err.message);
    }
  }

}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModuleHost;
}
