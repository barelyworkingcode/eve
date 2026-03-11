/**
 * WebSocket connection handler - dispatches messages to relay or local services.
 */
const RelayClient = require('./relay-client');
const SlashCommandHandler = require('./slash-command-handler');

const slashCommandHandler = new SlashCommandHandler();

function createWsHandler({ authService, fileHandlers, terminalManager, relayWsUrl, relayHttpUrl, claudeConfig }) {
  return (ws, req) => {
    const host = (req.headers.host || 'localhost').split(':')[0];
    const isLocalhostConnection = host === 'localhost' || host === '127.0.0.1';
    const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !isLocalhostConnection;
    let isAuthenticated = !requiresAuth;

    const relayClient = new RelayClient(relayWsUrl, ws);

    // Connect to relayLLM immediately
    relayClient.connect().catch(err => {
      console.error('[WsHandler] Failed to connect to relayLLM:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot connect to relay service' }));
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle auth message first
        if (message.type === 'auth') {
          if (!requiresAuth) {
            ws.send(JSON.stringify({ type: 'auth_success' }));
            return;
          }
          if (authService.validateSession(message.token)) {
            isAuthenticated = true;
            ws.send(JSON.stringify({ type: 'auth_success' }));
          } else {
            ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
            ws.close(4001, 'Unauthorized');
          }
          return;
        }

        // Block all other messages until authenticated
        if (!isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
          return;
        }

        switch (message.type) {
          case 'create_session':
            await handleCreateSession(ws, relayClient, relayHttpUrl, message);
            break;

          case 'join_session':
            relayClient.joinSession(message.sessionId);
            break;

          case 'user_input':
            handleUserInput(ws, relayClient, message);
            break;

          case 'end_session':
            relayClient.endSession(relayClient.currentSessionId);
            break;

          case 'delete_session':
            relayClient.deleteSession(message.sessionId);
            break;

          case 'rename_session':
            relayClient.renameSession(message.sessionId, message.name);
            break;

          case 'permission_response':
            if (message.alwaysAllow) {
              relayClient.setAlwaysAllow(true);
            }
            relayClient.sendPermissionResponse(
              message.permissionId,
              message.approved,
              message.reason || ''
            );
            break;

          // --- File operations (local) ---
          case 'list_directory':
            fileHandlers.listDirectory(ws, message);
            break;

          case 'read_file':
            fileHandlers.readFile(ws, message);
            break;

          case 'write_file':
            fileHandlers.writeFile(ws, message);
            break;

          case 'rename_file':
            fileHandlers.renameFile(ws, message);
            break;

          case 'move_file':
            fileHandlers.moveFile(ws, message);
            break;

          case 'delete_file':
            fileHandlers.deleteFile(ws, message);
            break;

          case 'upload_file':
            fileHandlers.uploadFile(ws, message);
            break;

          case 'create_directory':
            fileHandlers.createDirectory(ws, message);
            break;

          // --- Terminal operations (local) ---
          case 'terminal_create':
            terminalManager.createTerminal(ws, message.directory, message.command, message.args, claudeConfig);
            break;

          case 'terminal_input':
            terminalManager.handleInput(message.terminalId, message.data);
            break;

          case 'terminal_resize':
            terminalManager.handleResize(message.terminalId, message.cols, message.rows);
            break;

          case 'terminal_close':
            terminalManager.close(message.terminalId);
            break;

          case 'terminal_list':
            terminalManager.list(ws);
            break;

          case 'terminal_reconnect':
            terminalManager.reconnect(ws, message.terminalId);
            break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      relayClient.close();
      terminalManager.detachAll(ws);
    });
  };
}

/**
 * Create session via relayLLM HTTP POST, then join via WS.
 */
async function handleCreateSession(ws, relayClient, relayHttpUrl, message) {
  try {
    const response = await fetch(`${relayHttpUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: message.projectId || '',
        directory: message.directory || '',
        name: '',
        model: message.model || ''
      })
    });

    const data = await response.json();

    if (!response.ok) {
      ws.send(JSON.stringify({ type: 'error', message: data.error || 'Failed to create session' }));
      return;
    }

    // Send session_created to browser
    ws.send(JSON.stringify({
      type: 'session_created',
      sessionId: data.sessionId,
      directory: data.directory,
      projectId: data.projectId || null,
      model: data.model,
      name: data.name || null,
      metadata: data.directory
    }));

    // Suppress the session_joined that relayLLM will send when we join
    relayClient.setSuppressNextJoin(true);
    relayClient.currentSessionId = data.sessionId;
    relayClient.sessionDirectory = data.directory;
    relayClient.joinSession(data.sessionId);

  } catch (err) {
    console.error('[WsHandler] Create session failed:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to create session: relay unavailable' }));
  }
}

/**
 * Handle user input: check for local slash commands first, else relay.
 */
function handleUserInput(ws, relayClient, message) {
  const text = (message.text || '').trim();

  if (slashCommandHandler.handle(ws, relayClient, text)) {
    return;
  }

  const files = (message.files || []).map(parseFileAttachment);
  relayClient.sendMessage(message.text, files);
}

/**
 * Convert a client file attachment to the relay format.
 * Extracts mime type and raw base64 from data URLs.
 */
function parseFileAttachment(f) {
  if (f.type === 'image' && f.content && f.content.startsWith('data:')) {
    const match = f.content.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { name: f.name, mimeType: match[1], data: match[2] };
    }
  }
  return { name: f.name, mimeType: f.mediaType || '', data: f.content || '' };
}

module.exports = createWsHandler;
