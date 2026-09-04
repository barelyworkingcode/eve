/**
 * Search message descriptors — project search, cancellation, and the AI
 * summarize/stop pair. See ws/message-registry.js for the registry these are
 * registered into.
 *
 * This domain owns half of the one seam in the phase where a descriptor and
 * the connection's `close` handler share state: `inflightSearchIds` and
 * `inflightAiIds` are per-connection Sets built in ws-handler.js and reached
 * here only through `ctx` (never captured — see C1 in ws/message-registry.js).
 * The `close` handler drains the same two Sets to cancel work in flight when
 * the socket drops, so add/delete here must use the exact objects `close`
 * reads — which `ctx.inflightSearchIds`/`ctx.inflightAiIds` guarantee, since
 * both are the same Set instances created once per connection in
 * ws-handler.js and never rebuilt.
 *
 * None of these four arms are `await`ed in today's switch, so none of these
 * descriptors may be `async` — see C2 in ws/message-registry.js.
 */

/**
 * Drive a streaming search-summary AI call. Never throws past this boundary —
 * outcomes are already delivered to the browser as `search_ai_*` frames by
 * SearchSummarizer.run() itself; this wrapper just logs and runs the
 * connection-tracking cleanup.
 */
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
