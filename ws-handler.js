/**
 * WebSocket connection handler - dispatches messages to services.
 */
function createWsHandler({ authService, sessions, sessionManager, fileHandlers, terminalManager, resolvePermission, setAlwaysAllow }) {
  return (ws, req) => {
    const host = (req.headers.host || 'localhost').split(':')[0];
    const isLocalhostConnection = host === 'localhost' || host === '127.0.0.1';
    const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !isLocalhostConnection;
    let isAuthenticated = !requiresAuth;
    let currentSessionId = null;

    ws.on('message', (data) => {
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
            currentSessionId = sessionManager.createSession(ws, message.directory, message.projectId, message.model);
            break;

          case 'join_session':
            currentSessionId = sessionManager.joinSession(ws, message.sessionId);
            break;

          case 'user_input':
            if (currentSessionId) {
              sessionManager.sendMessage(currentSessionId, message.text, message.files);
            }
            break;

          case 'end_session':
            if (currentSessionId) {
              sessionManager.endSession(currentSessionId);
              currentSessionId = null;
            }
            break;

          case 'delete_session':
            sessionManager.deleteSession(message.sessionId, ws);
            if (currentSessionId === message.sessionId) {
              currentSessionId = null;
            }
            break;

          case 'rename_session':
            sessionManager.renameSession(message.sessionId, message.name, ws);
            break;

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

          case 'terminal_create':
            terminalManager.createTerminal(ws, message.directory, message.command, message.args, message.sessionId, sessionManager.getProviderConfig('claude'));
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

          case 'permission_response':
            if (message.alwaysAllow && currentSessionId) {
              setAlwaysAllow(currentSessionId, true);
            }
            resolvePermission(message.permissionId, message.approved ? 'allow' : 'deny', message.reason || '');
            break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      if (currentSessionId && sessions.has(currentSessionId)) {
        sessions.get(currentSessionId).ws = null;
      }
      terminalManager.detachAll(ws);
    });
  };
}

module.exports = createWsHandler;
