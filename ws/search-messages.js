// The connection's `close` handler drains `inflightSearchIds`/`inflightAiIds`
// to cancel work in flight when the socket drops, so add/delete here must
// use the exact Set instances `close` reads — which reaching them only
// through `ctx` guarantees, since ws-handler.js creates each Set once per
// connection and never rebuilds it.
function handleSearchAiSummarize(ctx, onDone) {
  const { ws, relayClient, message, log } = ctx;
  const { searchSummarizer } = ctx.deps;
  const { requestId, projectId, query, matches, model } = message;
  const finish = () => { if (onDone) onDone(); };

  if (!searchSummarizer) {
    ws.send(JSON.stringify({
      type: 'search_ai_failed', requestId: requestId || null,
      error: 'Search summarizer not initialized',
    }));
    finish();
    return;
  }
  if (!requestId) {
    ws.send(JSON.stringify({
      type: 'search_ai_failed', requestId: null,
      error: 'requestId required',
    }));
    finish();
    return;
  }

  searchSummarizer.run({
    requestId, projectId, query, matches, model,
    relayClient, browserWs: ws,
  }).catch(err => {
    log?.error?.(`search_ai_summarize ${requestId.slice(0, 8)} failed: ${err.message}`);
  }).finally(finish);
}

module.exports = [
  {
    type: 'search_project',
    expensive: true,
    handle(ctx) {
      if (ctx.message.requestId) ctx.inflightSearchIds.add(ctx.message.requestId);
      ctx.deps.fileHandlers.searchProject(ctx.ws, ctx.message).finally(() => {
        if (ctx.message.requestId) ctx.inflightSearchIds.delete(ctx.message.requestId);
      });
    },
  },

  {
    type: 'search_cancel',
    handle(ctx) {
      if (ctx.deps.fileHandlers.searchService && ctx.message.requestId) {
        ctx.deps.fileHandlers.searchService.cancel(ctx.message.requestId);
        ctx.inflightSearchIds.delete(ctx.message.requestId);
      }
    },
  },

  {
    type: 'search_ai_summarize',
    expensive: true,
    handle(ctx) {
      if (ctx.message.requestId) ctx.inflightAiIds.add(ctx.message.requestId);
      handleSearchAiSummarize(ctx, () => {
        if (ctx.message.requestId) ctx.inflightAiIds.delete(ctx.message.requestId);
      });
    },
  },

  {
    type: 'search_ai_stop',
    handle(ctx) {
      if (ctx.deps.searchSummarizer && ctx.message.requestId) {
        ctx.deps.searchSummarizer.stop(ctx.message.requestId);
        ctx.inflightAiIds.delete(ctx.message.requestId);
      }
    },
  },
];
