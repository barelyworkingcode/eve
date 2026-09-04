'use strict';

// Deliberate ALLOW-LIST: only the fields listed here cross to the client. A
// new relay field is silently dropped until added here; the project token
// must never leak and is intentionally absent (see below).
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
    // Private shells (e.g. ssh) that live on the project, not relayLLM's
    // global pty map; relayLLM resolves them by id at launch.
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
    sessionFolders: p.session_folders || [],
    // No `token`: relay is the sole project-token authority. Never cache or
    // forward the secret here.
    createdAt: p.created_at || '',
  };
}

module.exports = { normalizeProject };
