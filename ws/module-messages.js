/**
 * Module message descriptors — the module SDK's file r/w bridge (with the
 * server-side permission re-check) and the module AI invoke/stop pair. See
 * ws/message-registry.js for the registry these are registered into.
 *
 * This domain owns the other half of the one seam in the phase where a
 * descriptor and the connection's `close` handler share state:
 * `inflightAiIds` is a per-connection Set built in ws-handler.js and reached
 * here only through `ctx` (never captured — see C1 in ws/message-registry.js).
 * `module_invoke_ai` itself does not track `inflightAiIds` (it never did —
 * that bookkeeping belongs to `search_ai_summarize` only), but `module_ai_stop`
 * shares the same `ctx`-only discipline for `moduleInvoker`.
 *
 * `module_read_file` and `module_write_file` are `await`ed in today's switch,
 * so their descriptors must be `async`. `module_invoke_ai` and `module_ai_stop`
 * are not awaited today, so their descriptors must not be — see C2 in
 * ws/message-registry.js.
 */

/**
 * Bridge module SDK file ops (readFile/writeFile) through the server-side
 * permission check before delegating to FileHandlers. The iframe is untrusted
 * (AI-authored content); client-side checks are advisory only.
 */
async function handleModuleFileOp(ctx, op) {
  const { ws, message, fileWatcher } = ctx;
  const { moduleService, fileHandlers, resolveProject } = ctx.deps;
  const { requestId, projectId, moduleName, path: relPath, content } = message;

  const reply = (payload) => ws.send(JSON.stringify({
    type: 'module_file_response', requestId, op, ...payload,
  }));

  const project = resolveProject(projectId);
  if (!project) return reply({ ok: false, error: 'Project not found' });

  let manifest;
  try {
    manifest = await moduleService.getModule(project.path, moduleName);
  } catch (err) {
    return reply({ ok: false, error: err.message });
  }

  if (!moduleService.isFilePermitted(manifest, relPath)) {
    return reply({ ok: false, error: `Permission denied: ${relPath} not in module permissions.files` });
  }

  try {
    if (op === 'read') {
      const { content: text, size } = await fileHandlers.fileService.readFile(project.path, relPath);
      reply({ ok: true, content: text, size });
    } else {
      try {
        const absPath = fileHandlers.fileService.validatePath(project.path, relPath);
        fileWatcher.markSelfWrite(absPath);
      } catch { /* writeFile will surface the same error */ }
      await fileHandlers.fileService.writeFile(project.path, relPath, content || '');
      reply({ ok: true });
    }
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
}

/**
 * Drive a streaming module AI invocation. The invoker handles the relay
 * session lifecycle and forwards per-event frames to the browser as it
 * goes; this wrapper just translates the terminal outcome into a single
 * `module_ai_completed`/`module_ai_failed` frame the client can resolve its
 * pending Promise against. The invoke is fire-and-forget from the WS
 * handler's perspective — errors must never throw past this boundary or
 * they'd bubble up and disconnect the socket.
 */
function handleModuleInvokeAi(ctx) {
  const { ws, relayClient, message, log } = ctx;
  const { moduleInvoker } = ctx.deps;
  const { requestId, projectId, moduleName, prompt, files, schema, model } = message;
  if (!moduleInvoker) {
    ws.send(JSON.stringify({
      type: 'module_ai_failed', requestId, error: 'Module invoker not initialized',
    }));
    return;
  }
  if (!requestId) {
    ws.send(JSON.stringify({
      type: 'module_ai_failed', requestId: null, error: 'requestId required',
    }));
    return;
  }

  moduleInvoker.invoke({
    requestId, projectId, moduleName, prompt,
    files: files || [], schema, model,
    relayClient, browserWs: ws,
  }).then(({ result, rawText, model: usedModel, sessionId }) => {
    ws.send(JSON.stringify({
      type: 'module_ai_completed',
      requestId, sessionId, result, rawText, model: usedModel,
    }));
  }).catch(err => {
    log?.error?.(`module_invoke_ai ${requestId} failed: ${err.message}`);
    const payload = {
      type: 'module_ai_failed', requestId, error: err.message || 'Module invocation failed',
    };
    if (err.deniedFiles) payload.deniedFiles = err.deniedFiles;
    ws.send(JSON.stringify(payload));
  });
}

module.exports = [
  {
    type: 'module_read_file',
    async handle(ctx) { await handleModuleFileOp(ctx, 'read'); },
  },

  {
    type: 'module_write_file',
    async handle(ctx) { await handleModuleFileOp(ctx, 'write'); },
  },

  {
    type: 'module_invoke_ai',
    expensive: true,
    handle(ctx) { handleModuleInvokeAi(ctx); },
  },

  {
    type: 'module_ai_stop',
    handle(ctx) {
      if (ctx.deps.moduleInvoker && ctx.message.requestId) {
        ctx.deps.moduleInvoker.stop(ctx.message.requestId);
      }
    },
  },
];
