/**
 * eve-module-sdk.js — loaded by every static-HTML module page running inside
 * Eve's sandboxed iframe. Exposes a small `window.eve` API that posts
 * messages to the parent (ModuleHost), which performs authentication, scope
 * lookup, and permission enforcement on the server side.
 *
 * The iframe runs in an opaque origin (`null`) because its sandbox has
 * `allow-scripts` but NOT `allow-same-origin`. PostMessage origin checks
 * therefore use `*` — the parent's trust decision is based on
 * `event.source === iframe.contentWindow`, which cannot be spoofed.
 */
(function () {
  if (typeof window === 'undefined' || window.eve) return;

  const DEFAULT_TIMEOUT_MS = 60 * 1000;
  const pending = new Map();
  let nextId = 1;

  // Compact one-liner for the iframe's own console. The full request + response
  // are logged by ModuleHost in the parent console (with the resolved model);
  // duplicating them here would just be noise. Keep iframe logs as a thin
  // marker so devs working *inside* a module still see when calls fire.
  function summarize(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.length <= 40 ? value : `(${value.length} chars)`;
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      const hints = [];
      if ('path' in value) hints.push(`path=${value.path}`);
      if ('prompt' in value) hints.push(`prompt=(${String(value.prompt).length} chars)`);
      if ('files' in value && Array.isArray(value.files)) hints.push(`files=${JSON.stringify(value.files)}`);
      if (hints.length) return hints.join(' ');
      return `{${keys.slice(0, 3).join(',')}${keys.length > 3 ? ',…' : ''}}`;
    }
    return String(value);
  }

  function send(op, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof window.parent === 'undefined' || window.parent === window) {
      return Promise.reject(new Error('eve SDK: not running inside Eve iframe'));
    }
    const requestId = `m${nextId++}`;
    const startedAt = performance.now();

    console.log(`[eve.${op}] → ${summarize(args)}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
        console.warn(`[eve.${op}] ✗ timed out after ${elapsed}s`);
        reject(new Error(`eve.${op} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      pending.set(requestId, { op, resolve, reject, timer, startedAt });

      try {
        window.parent.postMessage({
          source: 'eve-module-sdk',
          version: 1,
          requestId,
          op,
          args: args || {},
        }, '*');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        console.error(`[eve.${op}] ✗ postMessage failed:`, err.message);
        reject(err);
      }
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'eve-module-sdk-response') return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    const elapsed = ((performance.now() - entry.startedAt) / 1000).toFixed(2);
    if (data.ok) {
      const tag = data.meta?.model ? ` [${data.meta.model}]` : '';
      console.log(`[eve.${entry.op}] ←${tag} (${elapsed}s) ${summarize(data.result)}`);
      entry.resolve(data.result);
    } else {
      console.warn(`[eve.${entry.op}] ✗ (${elapsed}s) ${data.error}`);
      entry.reject(new Error(data.error || 'Unknown error'));
    }
  });

  window.eve = {
    /**
     * Invoke an AI prompt and get a single structured response.
     * Long timeout because LLM calls can take a while.
     * @param {object} opts
     * @param {string} opts.prompt       — user-style prompt for the model.
     * @param {string[]} [opts.files]    — project-relative files to inline (must be in manifest permissions).
     * @param {object} [opts.schema]     — JSON schema; if set, model is told to return JSON only.
     * @param {string} [opts.model]      — override the module's default model.
     * @param {number} [opts.timeoutMs]  — defaults to 5 minutes.
     * @returns {Promise<any>} — parsed JSON if schema was set, else raw text.
     */
    invokeAI(opts) {
      return send('invokeAI', opts, { timeoutMs: opts?.timeoutMs ?? 5 * 60 * 1000 });
    },

    /**
     * Read a file from the project. Must be in the module's permissions.files list.
     * @param {string} relPath — project-relative path.
     * @returns {Promise<string>} — file contents (utf-8).
     */
    readFile(relPath) {
      return send('readFile', { path: relPath });
    },

    /**
     * Write a file in the project. Must be in the module's permissions.files list.
     * @param {string} relPath — project-relative path.
     * @param {string} content — utf-8 contents.
     * @returns {Promise<void>}
     */
    writeFile(relPath, content) {
      return send('writeFile', { path: relPath, content });
    },

    /**
     * Get the module's manifest (read-only view).
     * @returns {Promise<object>}
     */
    getManifest() {
      return send('getManifest', {});
    },
  };

  // Tell the parent we loaded; helps with debugging and lets the host know
  // the iframe is ready to receive any boot-time messages.
  try {
    window.parent.postMessage({ source: 'eve-module-sdk', op: 'ready' }, '*');
  } catch { /* ignore */ }
})();
