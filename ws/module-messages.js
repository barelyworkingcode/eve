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

// Errors must never throw past this boundary — an unhandled rejection here
// would bubble up and disconnect the socket.
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
