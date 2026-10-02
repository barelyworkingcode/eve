const { projectAudit, toAuditRow } = require('../../project-audit');

const event = (over = {}) => ({
  id: 'e1', ts: '2026-10-01T08:00:00Z', event: 'call_tool', tool: 'mail_list_accounts', outcome: 'ok',
  actor: { kind: 'session', project_id: 'alpha', token: 'secret-actor' },
  args: { to: 'secret-arg' }, error: 'secret-error', result_preview: 'secret-result', ...over,
});

function transport(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (method, path) => {
      calls.push(`${method} ${path}`);
      const r = routes[path.split('?')[0]];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('toAuditRow', () => {
  it('keeps only ts, tool, outcome and allowed', () => {
    const row = toAuditRow(event());
    expect(Object.keys(row).sort()).toEqual(['allowed', 'outcome', 'tool', 'ts']);
    expect(JSON.stringify(row)).not.toMatch(/secret/);
  });

  it.each(['denied', 'unauthorized', 'throttled'])('%s is not allowed', (outcome) => {
    expect(toAuditRow(event({ outcome })).allowed).toBe(false);
  });

  it.each(['ok', 'error', 'tool_error', 'pending'])('%s is allowed', (outcome) => {
    expect(toAuditRow(event({ outcome })).allowed).toBe(true);
  });
});

describe('projectAudit', () => {
  it('returns rows without args, actor, error or result when recording', async () => {
    const t = transport({
      '/api/audit/log': { status: 200, data: { path: '/x/audit.log' } },
      '/api/audit': { status: 200, data: [event(), event({ outcome: 'denied', tool: 'contacts_list' })] },
    });
    const { status, body } = await projectAudit(t, 'alpha');
    expect(status).toBe(200);
    expect(body.recording).toBe(true);
    expect(body.records.map((r) => [r.tool, r.allowed])).toEqual([['mail_list_accounts', true], ['contacts_list', false]]);
    expect(JSON.stringify(body)).not.toMatch(/secret|path/);
    expect(t.calls).toEqual(['GET /api/audit/log',
      'GET /api/audit?project_id=alpha&event=call_tool&limit=50&deep=true']);
  });

  it('says recording:false, and asks nothing more, when auditing is disabled', async () => {
    const t = transport({ '/api/audit/log': { status: 400, data: { error: 'auditing is disabled' } } });
    expect(await projectAudit(t, 'alpha')).toEqual({ status: 200, body: { recording: false, records: [] } });
    expect(t.calls).toEqual(['GET /api/audit/log']);
  });

  it('is 404 for a project eve does not know, before any relay call', async () => {
    const t = transport({});
    const out = await projectAudit(t, 'nope', () => undefined);
    expect(out).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(t.calls).toEqual([]);
  });

  it('is 502 when relay is unreachable or answers another error', async () => {
    const down = transport({ '/api/audit/log': new Error('ECONNREFUSED') });
    expect((await projectAudit(down, 'alpha')).status).toBe(502);
    const bad = transport({
      '/api/audit/log': { status: 200, data: { path: 'p' } },
      '/api/audit': { status: 500, data: { error: 'boom' } },
    });
    expect(await projectAudit(bad, 'alpha')).toEqual({ status: 502, body: { error: 'Service unavailable' } });
  });
});
