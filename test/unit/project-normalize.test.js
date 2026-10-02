// normalizeProject is an allow-list, so this test guards two regression classes:
// every expected field is mapped (a silent drop is how session_folders got missed
// the first time), and the project token is NEVER projected to the client.
const { normalizeProject } = require('../../project-normalize');

const fullRelayProject = {
  id: 'p1',
  name: 'Zed',
  path: '/work/zed',
  allowed_mcp_ids: ['fs', '*'],
  allowed_models: ['haiku'],
  chat_templates: [{
    id: 't1', name: 'Quick', model: 'sonnet', mode: 'voice', voice: 'af_heart',
    system_prompt: 'be brief', append_claude_md: true, use_relay_tools: true,
  }],
  permission_policy: { default_mode: 'plan', allowed_tools: ['Read'], denied_tools: ['Bash'] },
  session_folders: ['Bugs', 'Experiments'],
  created_at: '2026-06-13T00:00:00Z',
  // Secrets that must not cross to the browser:
  token: 'PLAINTEXT-SECRET',
  token_hash: 'deadbeef',
};

describe('normalizeProject', () => {
  it('maps every field to camelCase and never projects the project token or its hash', () => {
    expect(normalizeProject(fullRelayProject)).toEqual({
      id: 'p1',
      name: 'Zed',
      path: '/work/zed',
      hostId: '',
      allowedMcpIds: ['fs', '*'],
      allowedModels: ['haiku'],
      chatTemplates: [{
        id: 't1', name: 'Quick', model: 'sonnet', mode: 'voice', voice: 'af_heart',
        systemPrompt: 'be brief', presetFor: [],
      }],
      permissionPolicy: { defaultMode: 'plan', allowedTools: ['Read'], deniedTools: ['Bash'] },
      sessionFolders: ['Bugs', 'Experiments'],
      createdAt: '2026-06-13T00:00:00Z',
      // S1-A7: added with mode and default_for.
      mode: 'both',
      defaultFor: [],
    });
    const out = normalizeProject(fullRelayProject);
    expect(out).not.toHaveProperty('token');
    expect(out).not.toHaveProperty('token_hash');
    expect(JSON.stringify(out)).not.toContain('PLAINTEXT-SECRET');
  });

  it('fills safe defaults for a minimal project', () => {
    const out = normalizeProject({ id: 'p2', name: 'Bare', path: '/x' });
    expect(out).toMatchObject({
      hostId: '',
      allowedMcpIds: [],
      allowedModels: [],
      chatTemplates: [],
      permissionPolicy: null,
      sessionFolders: [],
      createdAt: '',
    });
  });

  it('defaults chat template mode and tolerates a null policy', () => {
    const out = normalizeProject({
      id: 'p3', name: 'T', path: '/x',
      chat_templates: [{ id: 'a', name: 'A', model: 'm' }],
      permission_policy: null,
    });
    expect(out.chatTemplates[0]).toMatchObject({
      mode: 'text', voice: '', systemPrompt: '',
    });
    expect(out.chatTemplates[0]).not.toHaveProperty('appendClaudeMd');
    expect(out.chatTemplates[0]).not.toHaveProperty('useRelayTools');
    expect(out.permissionPolicy).toBeNull();
  });

  it('carries preset_for as presetFor: only home and work, once each', () => {
    const out = normalizeProject({
      id: 'p4', name: 'P', path: '/x',
      chat_templates: [{ id: 'a', name: 'A', model: 'm', preset_for: ['home', 'both', 'home', 'work'] }],
    });
    expect(out.chatTemplates[0].presetFor).toEqual(['home', 'work']);
    expect(out.chatTemplates[0]).not.toHaveProperty('preset_for');
  });

  it('maps host_id to hostId, defaulting to empty for a console project', () => {
    expect(normalizeProject({ id: 'p5', name: 'Host', path: '/srv', host_id: 'h_abc' }).hostId).toBe('h_abc');
    expect(normalizeProject({ id: 'p6', name: 'Console', path: '/x' }).hostId).toBe('');
  });

  it('never projects ssh_argv even if a caller mistakenly hands the whole hostView through', () => {
    const out = normalizeProject({
      id: 'p7', name: 'Host', path: '/srv', host_id: 'h_abc',
      ssh_argv: ['ssh', '-o', 'BatchMode=yes', 'admin@devbox.local'],
    });
    expect(out).not.toHaveProperty('ssh_argv');
    expect(JSON.stringify(out)).not.toContain('BatchMode');
  });

  // CHANGED by S1-A7 (docs/design-today-s1.md): this used to pin that `mode` and
  // `default_for` are dropped. The Home|Work work (#38) needs both on the client.
  it('carries relay\'s mode, and default_for as defaultFor', () => {
    const out = normalizeProject({ id: 'p8', name: 'Modal', path: '/x', mode: 'work', default_for: ['work'] });
    expect(out.mode).toBe('work');
    expect(out.defaultFor).toEqual(['work']);
    expect(out).not.toHaveProperty('default_for');
  });

  it('defaults a missing mode to both and a missing default_for to none', () => {
    const out = normalizeProject({ id: 'p9', name: 'Bare', path: '/x' });
    expect(out.mode).toBe('both');
    expect(out.defaultFor).toEqual([]);
  });

  it('still never projects the token alongside mode', () => {
    const out = normalizeProject({ id: 'p10', name: 'T', path: '/x', mode: 'home', token: 'SECRET' });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
});
