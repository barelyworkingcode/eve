/**
 * ResponseCollector - captures LLM response text from a session's provider
 * by intercepting handleEvent and using a mock WebSocket.
 *
 * Used by the REST API message endpoint and headless task execution
 * to collect complete responses without a real WebSocket connection.
 */
class ResponseCollector {
  constructor(session) {
    this.session = session;
    this.responseText = '';
    this.completed = false;
    this.previousWs = session.ws;
    this.originalHandleEvent = null;
  }

  /**
   * Install the collector: replace session.ws with a mock and
   * intercept provider.handleEvent to capture response text.
   *
   * @param {Function} onComplete - called with (error, { response, stats })
   * @param {number} timeoutMs - timeout in ms (default 5 minutes)
   * @returns {Function} cleanup function
   */
  install(onComplete, timeoutMs = 5 * 60 * 1000) {
    const cleanup = () => {
      clearTimeout(this.timeout);
      this.session.ws = this.previousWs;
      if (this.originalHandleEvent && this.session.provider) {
        this.session.provider.handleEvent = this.originalHandleEvent;
      }
    };

    const complete = (err) => {
      if (this.completed) return;
      this.completed = true;
      cleanup();
      onComplete(err, { response: this.responseText, stats: this.session.stats });
    };

    // Mock WebSocket that watches for completion/error messages
    this.session.ws = {
      readyState: 1,
      send: (data) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'message_complete') {
            complete(null);
          } else if (message.type === 'system_message') {
            // Slash commands send system_message instead of going through the provider
            this.responseText = message.message;
            complete(null);
          } else if (message.type === 'error') {
            complete(new Error(message.message || 'Provider error'));
          }
        } catch (e) {
          // Ignore parse errors from streaming events
        }
      }
    };

    // Intercept provider events to capture response text
    if (this.session.provider) {
      this.originalHandleEvent = this.session.provider.handleEvent.bind(this.session.provider);
      this.session.provider.handleEvent = (event) => {
        this.captureText(event);
        this.originalHandleEvent(event);
      };
    }

    this.timeout = setTimeout(() => {
      complete(new Error('Response timeout (5 minutes)'));
    }, timeoutMs);

    return cleanup;
  }

  captureText(event) {
    if (event.type !== 'assistant') return;

    if (event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          this.responseText = block.text;
        }
      }
    } else if (event.content_block?.type === 'text') {
      this.responseText = event.content_block.text;
    } else if (event.delta?.type === 'text_delta') {
      this.responseText += event.delta.text;
    }
  }
}

module.exports = ResponseCollector;
