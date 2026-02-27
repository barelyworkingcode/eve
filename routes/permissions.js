const express = require('express');

function summarizeToolInput(toolInput) {
  if (!toolInput) return '';
  if (typeof toolInput === 'string') return toolInput.substring(0, 500);

  if (toolInput.command) return toolInput.command.substring(0, 500);

  if (toolInput.file_path && toolInput.old_string) {
    return `${toolInput.file_path}\n--- old ---\n${toolInput.old_string.substring(0, 200)}\n--- new ---\n${(toolInput.new_string || '').substring(0, 200)}`;
  }

  if (toolInput.file_path) return toolInput.file_path;
  if (toolInput.pattern) return toolInput.pattern;

  // For objects with a single string value, show that value directly
  const entries = Object.entries(toolInput).filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (entries.length === 1) {
    return entries[0][1].substring(0, 500);
  }

  // Fallback: pretty-print JSON
  return JSON.stringify(toolInput, null, 2).substring(0, 500);
}

function createPermissionRoutes({ sessions, requireAuth }) {
  const router = express.Router();
  const pendingPermissions = new Map();

  router.post('/', requireAuth, (req, res) => {
    const { sessionId, toolName, toolInput, toolUseId } = req.body;
    const permissionId = toolUseId || `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const session = sessions.get(sessionId);
    if (!session?.ws || session.ws.readyState !== 1) {
      return res.json({ decision: 'allow', reason: 'No active client' });
    }

    // Auto-allow if session has always-allow enabled
    if (session.alwaysAllowPermissions) {
      return res.json({ decision: 'allow', reason: 'Always allow enabled' });
    }

    session.ws.send(JSON.stringify({
      type: 'permission_request',
      sessionId,
      permissionId,
      toolName,
      toolInput: summarizeToolInput(toolInput)
    }));

    const timeout = setTimeout(() => {
      pendingPermissions.delete(permissionId);
      res.json({ decision: 'deny', reason: 'Permission request timed out' });
    }, 60000);

    pendingPermissions.set(permissionId, { res, timeout });
  });

  function resolvePermission(permissionId, decision, reason) {
    const pending = pendingPermissions.get(permissionId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingPermissions.delete(permissionId);
    pending.res.json({ decision, reason });
  }

  function setAlwaysAllow(sessionId, enabled) {
    const session = sessions.get(sessionId);
    if (session) {
      session.alwaysAllowPermissions = enabled;
    }
  }

  return { router, resolvePermission, setAlwaysAllow };
}

module.exports = createPermissionRoutes;
