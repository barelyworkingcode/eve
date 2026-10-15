const { HIDDEN_SEARCH_PREFIX } = require('./search-summarizer');

function isHiddenSession(name) {
  return (name || '').startsWith(HIDDEN_SEARCH_PREFIX);
}

// The body GET /api/projects answers. Throws when relay is unreachable.
async function fetchProjects({ relayTransport, refreshProjectCache, resolveProject }) {
  const { status, data } = await relayTransport.fetch('GET', '/api/projects');
  if (data && Array.isArray(data)) {
    await refreshProjectCache(data, { replace: true });
    const normalized = data.map(p => resolveProject(p.id)).filter(Boolean);
    return { status, data: normalized };
  }
  return { status, data };
}

// The body GET /api/sessions answers. Throws when relay is unreachable.
async function fetchSessions({ relayTransport }) {
  const { status, data } = await relayTransport.fetch('GET', '/api/sessions');
  // relay's session-host handler (internal/sessions/api.HandleListSessions)
  // returns `{ sessions: [...] }`, object-wrapped — unlike the bare array
  // the old relayLLM implementation returned. Accept both shapes rather
  // than assuming the new one landed everywhere at once: a bare array is
  // still handled so this route degrades gracefully against an older
  // relay build during a staged rollout. Eve's own browser-facing
  // contract is unchanged either way — always a bare, filtered array.
  const sessions = Array.isArray(data) ? data
    : (data && Array.isArray(data.sessions) ? data.sessions : null);
  if (status >= 200 && status < 300 && sessions) {
    return { status, data: sessions.filter(s => !isHiddenSession(s.name)) };
  }
  return { status, data };
}

// A part the way the route would have answered: a 2xx list is ok, anything
// else carries the status the route sends (502 for a non-list 2xx body).
function toPart({ status, data }) {
  if (status >= 200 && status < 300 && Array.isArray(data)) return { ok: true, items: data };
  return { ok: false, status: status >= 200 && status < 300 ? 502 : status };
}

async function loadPart(name, fetchPart, log) {
  try {
    const part = toPart(await fetchPart());
    if (!part.ok) log?.warn(`Startup snapshot: ${name} unavailable`, { op: 'startup.snapshot', part: name, status: part.status });
    return part;
  } catch (err) {
    log?.warn(`Startup snapshot: ${name} unavailable`, { op: 'startup.snapshot', part: name, status: 502, error: err.message });
    return { ok: false, status: 502 };
  }
}

async function loadStartupSnapshot(deps, log) {
  const [projects, sessions] = await Promise.all([
    loadPart('projects', () => fetchProjects(deps), log),
    loadPart('sessions', () => fetchSessions(deps), log),
  ]);
  return { projects, sessions };
}

module.exports = { isHiddenSession, fetchProjects, fetchSessions, loadStartupSnapshot };
