'use strict';

// normalizeProject maps relay's snake_case project shape to the camelCase shape
// the browser consumes, and is a deliberate ALLOW-LIST: only the fields listed
// here cross to the client. That has two consequences worth a test —
//   1. a new relay field is silently dropped until it's added here (this bit us
//      when adding session_folders), and
//   2. the project token must never leak (it is intentionally absent).
// Extracted from server.js so both the server and the test require the same fn.
function normalizeProject(p) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    allowedMcpIds: p.allowed_mcp_ids || [],
    allowedModels: p.allowed_models || [],
    chatTemplates: (p.chat_templates || []).map(t => ({
      id: t.id,
      name: t.name,
      model: t.model,
      mode: t.mode || 'text',
      voice: t.voice || '',
      systemPrompt: t.system_prompt || '',
      appendClaudeMd: !!t.append_claude_md,
      useRelayTools: !!t.use_relay_tools,
    })),
    // Project-scoped shell (terminal) launch templates — private shells (e.g.
    // ssh) that live on the project, not in relayLLM's global pty map. Allow-
    // listed here like chatTemplates; relayLLM resolves them by id at launch.
    shellTemplates: (p.shell_templates || []).map(t => ({
      id: t.id,
      name: t.name,
      command: t.command || '',
      args: t.args || [],
      env: t.env || {},
      description: t.description || '',
      icon: t.icon || '',
    })),
    permissionPolicy: p.permission_policy ? {
      defaultMode: p.permission_policy.default_mode || 'default',
      allowedTools: p.permission_policy.allowed_tools || [],
      deniedTools: p.permission_policy.denied_tools || [],
    } : null,
    // Ordered list of session-folder names for this project (UI grouping).
    sessionFolders: p.session_folders || [],
    // No `token`: relay is the sole project-token authority. eve references
    // projects by id only; relayLLM resolves the scoped token from relay's
    // bridge just-in-time. Never cache or forward the secret here.
    createdAt: p.created_at || '',
  };
}

module.exports = { normalizeProject };
