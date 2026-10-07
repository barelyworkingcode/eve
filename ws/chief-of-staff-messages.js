// Chief of Staff thread traffic is WS-only (docs/design-chief-of-staff.md).
// The thread is server-wide, so these read the one ChiefOfStaff from deps;
// nothing per-connection is captured here.

const MAX_TEXT = 2000;

function unavailable(ws) {
  ws.send(JSON.stringify({ type: 'error', message: 'Chief of Staff is not available' }));
}

module.exports = [
  {
    type: 'cos_subscribe',
    handle(ctx) {
      const cos = ctx.deps.chiefOfStaff;
      if (!cos) { unavailable(ctx.ws); return; }
      cos.subscribe(ctx.ws);
    },
  },

  {
    type: 'cos_message',
    expensive: true,
    handle(ctx) {
      const cos = ctx.deps.chiefOfStaff;
      if (!cos) { unavailable(ctx.ws); return; }
      const text = typeof ctx.message.text === 'string' ? ctx.message.text.trim() : '';
      if (text.length < 1 || text.length > MAX_TEXT) {
        ctx.ws.send(JSON.stringify({ type: 'error', message: `Message must be 1 to ${MAX_TEXT} characters` }));
        return;
      }
      cos.submitPerson(text);
    },
  },

  {
    // Not `expensive` (a tap is no model turn) and not `async`: the frozen
    // registry pins both sets, so the answer is chained instead of awaited.
    type: 'cos_card_action',
    handle(ctx) {
      const cos = ctx.deps.chiefOfStaff;
      if (!cos) { unavailable(ctx.ws); return; }
      const { postId, action, edits } = ctx.message;
      if (typeof postId !== 'string' || typeof action !== 'string') {
        ctx.ws.send(JSON.stringify({ type: 'error', message: 'A card action needs a postId and an action' }));
        return;
      }
      cos.cardAction({ postId, action, edits }).then((out) => {
        if (!out.ok) ctx.ws.send(JSON.stringify({ type: 'error', message: out.message }));
      }).catch(() => {
        ctx.ws.send(JSON.stringify({ type: 'error', message: 'The card action failed' }));
      });
    },
  },
];
