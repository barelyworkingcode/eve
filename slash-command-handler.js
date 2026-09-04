class SlashCommandHandler {
  handle(ws, relayClient, text) {
    if (!text.startsWith('/')) return false;

    const parts = text.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const sessionId = relayClient.currentSessionId;

    const sendSystemMessage = (msg) => {
      ws.send(JSON.stringify({ type: 'system_message', sessionId, message: msg }));
    };

    const sendComplete = () => {
      ws.send(JSON.stringify({ type: 'message_complete', sessionId }));
    };

    switch (command) {
      case 'clear':
        if (sessionId) {
          relayClient.clearSession(sessionId);
        }
        sendComplete();
        return true;

      case 'help':
        sendSystemMessage(
          `Commands:\n/clear - Clear conversation history\n/zsh - Open terminal\n/bash - Open terminal\n/claude - Open Claude CLI terminal\n/help - Show this help`
        );
        sendComplete();
        return true;

      case 'zsh':
      case 'bash':
        ws.send(JSON.stringify({
          type: 'terminal_request',
          sessionId,
          directory: relayClient.sessionDirectory,
          command: 'shell'
        }));
        sendComplete();
        return true;

      case 'claude':
        ws.send(JSON.stringify({
          type: 'terminal_request',
          sessionId,
          directory: relayClient.sessionDirectory,
          command: 'claude'
        }));
        sendComplete();
        return true;

      default:
        return false;
    }
  }
}

module.exports = SlashCommandHandler;
