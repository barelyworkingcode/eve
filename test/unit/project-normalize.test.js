/**
 * normalizeProject — relay snake_case → browser camelCase projection. It is an
 * allow-list, so this test guards two regression classes:
 *   1. every expected field is mapped (a silent drop is how session_folders got
 *      missed the first time), and
 *   2. the project token is NEVER projected to the client.
 */
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
  shell_templates: [{
    id: 's1', name: 'Prod SSH', command: 'ssh', args: ['me@prod'],
    env: { TERM: 'xterm' }, description: 'private', icon: 'shell',
  }],
  permission_policy: { default_mode: 'plan', allowed_tools: ['Read'], denied_tools: ['Bash'] },
  session_folders: ['Bugs', 'Experiments'],
  created_at: '2026-06-13T00:00:00Z',
  // Secrets that must not cross to the browser:
  token: 'PLAINTEXT-SECRET',
  token_hash: 'deadbeef',
};

describe('normalizeProject', () => {
  it('maps every field to camelCase', () => {
    expect(normalizeProject(fullRelayProject)).toEqual({
      id: 'p1',
      name: 'Zed',
      path: '/work/zed',
      allowedMcpIds: ['fs', '*'],
      allowedModels: ['haiku'],
      chatTemplates: [{
        id: 't1', name: 'Quick', model: 'sonnet', mode: 'voice', voice: 'af_heart',
        systemPrompt: 'be brief', appendClaudeMd: true, useRelayTools: true,
      }],
      shellTemplates: [{
        id: 's1', name: 'Prod SSH', command: 'ssh', args: ['me@prod'],
        env: { TERM: 'xterm' }, description: 'private', icon: 'shell',
      }],
      permissionPolicy: { defaultMode: 'plan', allowedTools: ['Read'], deniedTools: ['Bash'] },
      sessionFolders: ['Bugs', 'Experiments'],
      createdAt: '2026-06-13T00:00:00Z',
    });
  });

  it('never projects the project token or its hash', () => {
    const out = normalizeProject(fullRelayProject);
    expect(out).not.toHaveProperty('token');
    expect(out).not.toHaveProperty('token_hash');
    expect(JSON.stringify(out)).not.toContain('PLAINTEXT-SECRET');
  });

  it('fills safe defaults for a minimal project', () => {
    const out = normalizeProject({ id: 'p2', name: 'Bare', path: '/x' });
    expect(out).toMatchObject({
      allowedMcpIds: [],
      allowedModels: [],
      chatTemplates: [],
      shellTemplates: [],
      permissionPolicy: null,
      sessionFolders: [],
      createdAt: '',
    });
  });

  it('maps shell templates and fills defaults for sparse entries', () => {
    const out = normalizeProject({
      id: 'p4', name: 'S', path: '/x',
      shell_templates: [{ id: 'a', name: 'A', command: 'ssh' }],
    });
    expect(out.shellTemplates[0]).toEqual({
      id: 'a', name: 'A', command: 'ssh', args: [], env: {}, description: '', icon: '',
    });
  });

  it('defaults chat template mode/flags and tolerates a null policy', () => {
    const out = normalizeProject({
      id: 'p3', name: 'T', path: '/x',
      chat_templates: [{ id: 'a', name: 'A', model: 'm' }],
      permission_policy: null,
    });
    expect(out.chatTemplates[0]).toMatchObject({
      mode: 'text', voice: '', systemPrompt: '', appendClaudeMd: false, useRelayTools: false,
    });
    expect(out.permissionPolicy).toBeNull();
  });
});
