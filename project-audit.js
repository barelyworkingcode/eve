// What a project's Relay tool calls look like to the browser. Relay's audit
// events carry args, actor and error text; only the four fields below leave
// this module. Both calls go through RelayTransport, never raw fetch.
const DENIED = new Set(['denied', 'unauthorized', 'throttled']);
const UNAVAILABLE = { status: 502, body: { error: 'Service unavailable' } };

function toAuditRow(ev) {
  const outcome = String((ev && ev.outcome) || '');
  return { ts: ev.ts, tool: ev.tool || '', outcome, allowed: !DENIED.has(outcome) };
}

// GET /api/audit/log answers 400 only when auditing is off (the path it returns
// is discarded). Without that probe an off relay's `[]` reads as "no calls yet".
// resolveProject is optional so a caller with no project cache skips the 404.
async function projectAudit(relayTransport, projectId, resolveProject) {
  if (resolveProject && !resolveProject(projectId)) return { status: 404, body: { error: 'Project not found' } };
  try {
    const probe = await relayTransport.fetch('GET', '/api/audit/log');
    if (probe.status === 400) return { status: 200, body: { recording: false, records: [] } };
    if (probe.status < 200 || probe.status >= 300) return UNAVAILABLE;
    // deep: the in-memory ring is shared by every project and starts empty.
    const q = `project_id=${encodeURIComponent(projectId)}&event=call_tool&limit=50&deep=true`;
    const { status, data } = await relayTransport.fetch('GET', `/api/audit?${q}`);
    if (status < 200 || status >= 300 || !Array.isArray(data)) return UNAVAILABLE;
    return { status: 200, body: { recording: true, records: data.map(toAuditRow) } };
  } catch {
    return UNAVAILABLE;
  }
}

module.exports = { projectAudit, toAuditRow };
