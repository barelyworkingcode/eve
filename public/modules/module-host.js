/**
 * ModuleHost — owns module iframe lifecycle and the postMessage bridge.
 *
 * SECURITY MODEL:
 *  - Iframes are created with sandbox="allow-scripts" only (NO allow-same-origin).
 *  - The iframe's origin is `null` (opaque), so postMessage origin is `*` —
 *    we authenticate the message by matching `event.source` against the
 *    Window of an iframe we created. That cannot be spoofed.
 *  - The iframe NEVER sends projectId/moduleName over the wire — both come
 *    from the WeakMap lookup. An AI-authored module cannot lie about scope.
 *  - File reads/writes are gated server-side against the manifest's
 *    permissions.files list. Client checks are advisory.
 */
class ModuleHost {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('ModuleHost');
    this.state = container.get('state');
    this.api = container.get('api');

    // tabId -> { iframeEl, contentWindow, projectId, moduleName, manifest }
    // While a creation is in flight, the entry is { pending: Promise<ctx> }.
    this.iframes = new Map();
    // WeakMap so iframe GC doesn't leak; reverse lookup from postMessage source.
    this.windowToCtx = new WeakMap();
    // Pending WS file-op requests. Each entry holds { resolve, reject, timer }
    // so the success path can clear the timeout (timers would otherwise pile up).
    this._pendingFileOps = new Map();
    this._fileOpSeq = 1;
    this._host = null;
  }

  init() {
    this._host = document.getElementById('moduleContent');
    if (!this._host) {
      this.log.warn('No #moduleContent element found; module iframes will not render');
    }
    window.addEventListener('message', (event) => this._handleMessage(event));

    // Bridge WS responses from server-side module file ops back to pending callers.
    this.bus.on(EVT.MODULE_FILE_RESPONSE, (msg) => {
      const entry = this._pendingFileOps.get(msg.requestId);
      if (!entry) return;
      this._pendingFileOps.delete(msg.requestId);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg);
      else entry.reject(new Error(msg.error || 'Unknown error'));
    });
  }

  /**
   * Show the iframe for `tab`. Creates it on first activation; reuses it on
   * subsequent switches so the module's in-memory state is preserved.
   *
   * Concurrent calls (e.g. multiple MODULE_LAUNCH_REQUEST emits or a fast
   * close+reopen) reuse the same in-flight creation Promise — without that
   * dedup, the second call's `iframes.get(tab.id)` would miss the slot the
   * first call is still constructing, and both would append iframes.
   */
  async activate(tab) {
    if (!this._host) return;

    let entry = this.iframes.get(tab.id);
    if (!entry) {
      const pending = this._createIframe(tab);
      // Claim the slot synchronously so a re-entrant activate() finds it.
      this.iframes.set(tab.id, { pending });
      try {
        entry = await pending;
      } finally {
        // If creation failed (entry is null) or aborted, drop the placeholder.
        if (!entry) this.iframes.delete(tab.id);
      }
      if (!entry) return;
    } else if (entry.pending) {
      entry = await entry.pending;
      if (!entry) return;
    }

    // Hide all OTHER module iframes; reveal this one.
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

    // Register the contentWindow BEFORE the iframe's script can fire postMessage.
    // The Window object is allocated when the element is created and stays the
    // same across navigation, so the WeakMap key is stable. Registering here
    // (rather than on the iframe 'load' event) avoids a race where the SDK
    // posts on script-execute — which happens before the parent's 'load'.
    const ctx = { iframeEl, contentWindow: iframeEl.contentWindow, projectId, moduleName, manifest };
    if (ctx.contentWindow) {
      this.windowToCtx.set(ctx.contentWindow, ctx);
    }

    // Re-register after load in case the Window object identity changed during
    // navigation (defensive — should be the same object on every browser
    // we target, but cheap to confirm).
    iframeEl.addEventListener('load', () => {
      if (iframeEl.contentWindow && iframeEl.contentWindow !== ctx.contentWindow) {
        ctx.contentWindow = iframeEl.contentWindow;
        this.windowToCtx.set(ctx.contentWindow, ctx);
      }
    });

    // Promote placeholder ({pending}) to the real entry — unless destroy()
    // dropped the slot while we were awaiting. In that case, tear down the
    // iframe we built and abort so we don't leak a detached element.
    const slot = this.iframes.get(tab.id);
    if (!slot || !slot.pending) {
      iframeEl.remove();
      return null;
    }
    this.iframes.set(tab.id, ctx);
    this.bus.emit(EVT.MODULE_OPENED, { projectId, moduleName, tabId: tab.id });
    return ctx;
  }

  /**
   * Destroy the iframe for `tabId` and free associated state. Safe to call
   * while the iframe is still being constructed — the slot is dropped and the
   * in-flight _createIframe will detect that on resolve and abort.
   */
  destroy(tabId) {
    const entry = this.iframes.get(tabId);
    if (!entry) return;
    if (entry.iframeEl) {
      try { entry.iframeEl.remove(); } catch { /* ignore */ }
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

  // --- PostMessage bridge ---

  _handleMessage(event) {
    const data = event.data;
    if (!data || data.source !== 'eve-module-sdk') return;
    if (data.op === 'ready') return; // boot ping, no response needed

    const ctx = this.windowToCtx.get(event.source);
    if (!ctx) {
      // Message from an unknown Window — silently drop. Possible during the
      // narrow window before the iframe's `load` registers contentWindow.
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

  // Parent-console mirror of every SDK call. Always tagged with the module
  // name; invokeAI lines additionally carry the resolved model so the
  // operator can see which provider handled the request at a glance.
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
        // ctx.manifest is already the public projection (set by the server).
        this._respond(source, requestId, { ok: true, result: ctx.manifest });
        return { value: ctx.manifest };
      }
      default:
        this._respond(source, requestId, { ok: false, error: `Unknown op: ${op}` });
        throw new Error(`Unknown op: ${op}`);
    }
  }

  async _invokeAI(ctx, source, requestId, args) {
    try {
      const payload = await this.api.invokeModule({
        projectId: ctx.projectId,
        moduleName: ctx.moduleName,
        prompt: args.prompt || '',
        files: args.files || [],
        schema: args.schema,
        model: args.model,
      });
      this._respond(source, requestId, {
        ok: true, result: payload.result, meta: { model: payload.model },
      });
      return { value: payload.result, model: payload.model };
    } catch (err) {
      const denied = err.body?.deniedFiles;
      const message = denied ? `${err.message} (denied: ${denied.join(', ')})` : err.message;
      this._respond(source, requestId, { ok: false, error: message });
      throw new Error(message);
    }
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
