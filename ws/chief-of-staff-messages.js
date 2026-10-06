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
];
