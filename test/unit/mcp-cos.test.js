// The eve-cos MCP server, driven over stdio the way relay drives it, against a stub of eve's
// /internal/cos endpoint.
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', '..', 'mcp', 'cos.js');

let stub;
let seen;
let answer;
let child;
let lines;
let nextId;

async function boot() {
  seen = [];
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
      const out = answer(seen[seen.length - 1].body);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  child = spawn('node', [SERVER], {
    env: { ...process.env, EVE_INTERNAL_URL: `http://127.0.0.1:${stub.address().port}`, EVE_INTERNAL_SECRET: 'test-secret' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  lines = readline.createInterface({ input: child.stdout });
  nextId = 1;
}

// One request, one response: JSON-RPC ids pair them.
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    const onLine = (line) => {
      const msg = JSON.parse(line);
      if (msg.id === id) { lines.off('line', onLine); resolve(msg); }
    };
    lines.on('line', onLine);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const callTool = async (name, args, meta = { project_id: 'p1' }) => (await rpc('tools/call', { name, arguments: args, _meta: meta })).result;

beforeEach(boot);
afterEach(async () => {
  const closed = new Promise((r) => child.once('close', r));
  child.stdin.end();
  await closed;
  await new Promise((r) => stub.close(r));
});

describe('discovery', () => {
  it('identifies as eve-cos', async () => {
    const { result } = await rpc('initialize', {});
    expect(result.serverInfo.name).toBe('eve-cos');
  });

  it('lists the four tools with their required arguments, and a mode enum on cos_propose_start', async () => {
    const { result } = await rpc('tools/list', {});
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t.inputSchema]));
    expect(Object.keys(byName).sort()).toEqual(['cos_list_sessions', 'cos_propose_send', 'cos_propose_start', 'cos_session_status']);
    expect(byName.cos_list_sessions.required || []).toEqual([]);
    expect(byName.cos_session_status.required).toEqual(['sessionId']);
    expect(byName.cos_propose_send.required.sort()).toEqual(['sessionId', 'text']);
    expect(byName.cos_propose_start.required.sort()).toEqual(['project', 'prompt']);
    expect(byName.cos_propose_start.properties.mode.enum).toEqual(['headless', 'terminal']);
    expect(Object.keys(byName.cos_propose_start.properties)).toEqual(expect.arrayContaining(['folder', 'model', 'mode']));
  });
});

describe('a call', () => {
  it('posts the tool, args and relay-injected project id to /internal/cos with the secret, and returns the result as text JSON', async () => {
    const result = { status: 'sent', sessionId: 's1', label: 'Agent s1' };
    answer = () => ({ status: 200, body: { ok: true, result } });
    const out = await callTool('cos_propose_send', { sessionId: 's1', text: 'hi' }, { project_id: 'p-cos' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/internal/cos', body: { tool: 'cos_propose_send', args: { sessionId: 's1', text: 'hi' }, meta: { project_id: 'p-cos' } } });
    expect(seen[0].headers['x-eve-internal']).toBe('test-secret');
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(out.isError).toBe(false);
    expect(out.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
  });

  it.each([
    ['not_cos_session', 403, true], ['unverified_call', 403, true], ['no_turn', 409, false], ['invalid_args', 400, false], ['unknown_project', 404, false],
  ])('a %s refusal is "refused: code: message" with isError, and the scope-violation mark only where promised', async (code, status, violation) => {
    answer = () => ({ status, body: { ok: false, error: code, message: 'because' } });
    const out = await callTool('cos_propose_start', { project: 'Acme', prompt: 'go' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(`refused: ${code}: because`);
    if (violation) expect(out._meta).toEqual({ scope_violation: true });
    else expect(out._meta).toBeUndefined();
  });

  it('an unknown tool never reaches eve', async () => {
    answer = () => ({ status: 200, body: { ok: true, result: {} } });
    const out = await callTool('cos_delete_everything', {});
    expect(out.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('an answer that is not JSON is an error result, not a crash', async () => {
    answer = () => ({ status: 502, body: '<html>bad gateway</html>' });
    const out = await callTool('cos_list_sessions', {});
    expect(out.isError).toBe(true);
    expect((await callTool('cos_list_sessions', {})).isError).toBe(true); // still serving
  });

  it('an eve that is not listening is an error result', async () => {
    await new Promise((r) => stub.close(r));
    stub = http.createServer();
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const out = await callTool('cos_list_sessions', {});
    expect(out.isError).toBe(true);
  });
});
