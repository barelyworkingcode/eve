/**
 * Refusal: is a tool_result a refusal because the tool belongs to the other
 * mode? Two shapes: macMCP's scope check (`scope_violation: true`) and relay's
 * gate (`is_error` with "access denied: " in the text). Pure, so unit tests
 * and journeys can require it.
 */
const Refusal = {
  RELAY_MARKER: 'access denied: ',

  _text(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  },

  // event: an llm_event `result`/`tool_result` or a Claude `tool_result` block.
  detect(event) {
    if (!event || typeof event !== 'object') return null;
    const tool = event.tool_name || event.name || '';
    if (event.scope_violation === true) return { tool, kind: 'scope' };
    if (event.is_error === true && Refusal._text(event.content).includes(Refusal.RELAY_MARKER)) {
      return { tool, kind: 'relay' };
    }
    return null;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Refusal;
