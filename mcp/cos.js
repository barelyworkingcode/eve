'use strict';
// The Chief of Staff's MCP server (eve-cos). Each tool POSTs to eve's
// loopback-only /internal/cos endpoint, which ties the call to a tool_use the
// person model really made in the person's current turn, then lists, reports,
// starts or sends (docs/design-chief-of-staff.md, "Actions and provenance").
//
// Relay spawns this process and injects (via `relay mcp register --env`):
//   EVE_INTERNAL_URL     eve's loopback base URL
//   EVE_INTERNAL_SECRET  shared secret for the internal endpoint (also in eve's .env)
// `_meta.project_id` is injected by relay, which authenticates the project
// token; the LLM cannot forge it.

const readline = require('node:readline');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const INTERNAL_URL = process.env.EVE_INTERNAL_URL || 'http://127.0.0.1:3000';
const INTERNAL_SECRET = process.env.EVE_INTERNAL_SECRET || '';
const PROTOCOL_VERSION = '2024-11-05';

// Refusals that mean the caller is not the Chief of Staff's own session.
const SCOPE_VIOLATIONS = new Set(['not_cos_session', 'unverified_call']);

const TOOLS = [
  {
    name: 'cos_list_sessions',
    description:
      'List the agent sessions the Chief of Staff watches: session id, label, project, state, whether it is headless, and who started it. Use to find which session the person means before you send to it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cos_session_status',
    description:
      'Report one agent session: its state, model, who started it and the start of its last reply. Pass the sessionId from cos_list_sessions.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'The session id.' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'cos_propose_start',
    description:
      "Start a new agent on a project with a prompt. Use when the person asks to start, launch or spin up an agent. The agent runs headless unless the person asks for a terminal. eve starts it at once when the prompt is the person's own words; otherwise it posts a card the person taps.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project id or exact name.' },
        prompt: { type: 'string', description: 'What the agent should do (1 to 8000 characters).' },
        folder: { type: 'string', description: 'Optional folder inside the project, relative, no "..".' },
        model: { type: 'string', description: 'Optional model; defaults to the Chief of Staff model.' },
        mode: { type: 'string', enum: ['headless', 'terminal'], description: 'headless (default) or terminal, only when the person asks for a terminal.' },
      },
      required: ['project', 'prompt'],
    },
  },
  {
    name: 'cos_propose_send',
    description:
      "Send a message to a running agent session. Use when the person asks to tell, reply to or instruct an agent. eve sends at once when the text is the person's own words; otherwise it posts a card the person taps.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session id from cos_list_sessions.' },
        text: { type: 'string', description: 'The message (1 to 8000 characters).' },
      },
      required: ['sessionId', 'text'],
    },
  },
];

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError: !!isError };
}

function postCos(payload) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/internal/cos', INTERNAL_URL);
    } catch (e) {
      return resolve({ ok: false, body: `invalid EVE_INTERNAL_URL: ${e.message}` });
    }
    const body = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-eve-internal': INTERNAL_SECRET,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, body: `eve is not reachable at ${INTERNAL_URL}: ${e.message}` }));
    req.write(body);
    req.end();
  });
}

function refusal(code, message) {
  const r = textResult(`refused: ${code}: ${message}`, true);
  if (SCOPE_VIOLATIONS.has(code)) r._meta = { scope_violation: true };
  return r;
}

async function callTool(name, args, meta) {
  if (!TOOLS.some((t) => t.name === name)) return textResult(`unknown tool: ${name}`, true);
  const res = await postCos({ tool: name, args, meta: { project_id: (meta && meta.project_id) || '' } });
  if (!res.ok) return textResult(res.body, true);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return textResult(`eve answered ${res.status} with a body I could not read`, true);
  }
  if (parsed && parsed.ok === true) return textResult(JSON.stringify(parsed.result));
  const code = (parsed && typeof parsed.error === 'string' && parsed.error) || `http_${res.status}`;
  return refusal(code, (parsed && parsed.message) || 'eve did not accept the call');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }

  const id = req.id;

  switch (req.method) {
    case 'initialize':
      respond({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'eve-cos', version: '1.0.0' },
        },
      });
      break;

    case 'notifications/initialized':
      // notification — no response
      break;

    case 'tools/list':
      respond({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call': {
      const params = req.params || {};
      const name = params.name || '';
      const args = (params.arguments || {});
      const meta = (params._meta || {});
      try {
        const result = await callTool(name, args, meta);
        respond({ jsonrpc: '2.0', id, result });
      } catch (e) {
        respond({ jsonrpc: '2.0', id, result: textResult(`internal error: ${e.message}`, true) });
      }
      break;
    }

    default:
      if (req.id !== undefined) {
        respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${req.method}` } });
      }
      break;
  }
});
