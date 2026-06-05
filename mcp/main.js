'use strict';
// eve-control MCP — a tiny stdio MCP server, intrinsic to eve.
//
// It lets an LLM drive eve's tabs (open / close / refresh an image tab) during,
// e.g., an interactive story. It does NOT touch the browser directly: each tool
// POSTs to eve's own loopback-only /internal/ui-command endpoint, and eve's
// server is what pushes a `ui_command` to the browser(s) viewing the project.
// This keeps the layers clean — relayLLM never learns that "eve" or "tabs"
// exist; this is a normal tool call routed through relay like any other MCP.
//
// Relay spawns this process and injects (via `relay mcp register --env`):
//   EVE_INTERNAL_URL     eve's loopback base URL, e.g. http://127.0.0.1:3000
//   EVE_INTERNAL_SECRET  shared secret for the internal endpoint (also in eve's .env)
//
// The authenticated calling project rides `_meta.project_id`, which relay
// injects (it authenticates the project token — the LLM cannot forge it). eve
// does the security trimming (a tab opened by a human can't be closed by the
// LLM; the LLM only touches tabs it opened in its own project).

const readline = require('node:readline');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const INTERNAL_URL = process.env.EVE_INTERNAL_URL || 'http://127.0.0.1:3000';
const INTERNAL_SECRET = process.env.EVE_INTERNAL_SECRET || '';
const PROTOCOL_VERSION = '2024-11-05';

// Descriptions are deliberately trigger-keyword-rich: relay's skill generator
// harvests these phrases into the relay-eve-control skill's routing description.
const TOOLS = [
  {
    name: 'eve_open_tab',
    description:
      'Open a new tab in the eve UI that displays an image. Use whenever the user or the story asks to show, display, open, or pop out a picture, illustration, scene, or visual in its own tab (rather than only inline in chat). Pass image_url from generate_image (an /api/generated/... path). Returns a tab_ref you keep and pass to eve_refresh_tab / eve_close_tab.',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'Image URL to show (e.g. an /api/generated/... path from generate_image).' },
        title: { type: 'string', description: 'Optional tab title shown to the user.' },
        requested_project: { type: 'string', description: 'Optional: the project this tab is for. Must match your authorized project; verified by eve.' },
      },
      required: ['image_url'],
    },
  },
  {
    name: 'eve_refresh_tab',
    description:
      'Refresh / reload an image tab you previously opened in the eve UI — for example after regenerating the image. Use whenever the user or story asks to update, refresh, redraw, or reload a picture you are already showing. Pass the tab_ref from eve_open_tab; optionally a new image_url.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_ref: { type: 'string', description: 'The tab_ref returned by eve_open_tab.' },
        image_url: { type: 'string', description: 'Optional new image URL; omit to reload the current one (cache-busted).' },
      },
      required: ['tab_ref'],
    },
  },
  {
    name: 'eve_close_tab',
    description:
      'Close an image tab you previously opened in the eve UI. Use whenever the user or story asks to close, dismiss, hide, or remove a picture tab you opened. Pass the tab_ref from eve_open_tab. You can only close tabs you opened — never a tab the human opened.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_ref: { type: 'string', description: 'The tab_ref returned by eve_open_tab.' },
      },
      required: ['tab_ref'],
    },
  },
];

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError: !!isError };
}

// POST the command to eve's loopback internal endpoint. Returns {ok, body}.
function postUiCommand(payload) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/internal/ui-command', INTERNAL_URL);
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
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, body: `eve is not reachable at ${INTERNAL_URL}: ${e.message}` }));
    req.write(body);
    req.end();
  });
}

async function callTool(name, args, meta) {
  const projectId = (meta && meta.project_id) || '';
  // Defense in depth: relay already vouches project_id; if the LLM also named a
  // project, it must match. eve enforces ownership regardless.
  if (args.requested_project && projectId && args.requested_project !== projectId) {
    return textResult(`refused: requested_project "${args.requested_project}" does not match your authorized project`, true);
  }

  let payload;
  switch (name) {
    case 'eve_open_tab':
      if (!args.image_url) return textResult('eve_open_tab requires image_url', true);
      payload = { action: 'open_tab', tab_kind: 'image', project_id: projectId, image_url: args.image_url, title: args.title || 'Image' };
      break;
    case 'eve_refresh_tab':
      if (!args.tab_ref) return textResult('eve_refresh_tab requires tab_ref', true);
      payload = { action: 'refresh_tab', tab_kind: 'image', project_id: projectId, tab_ref: args.tab_ref, image_url: args.image_url };
      break;
    case 'eve_close_tab':
      if (!args.tab_ref) return textResult('eve_close_tab requires tab_ref', true);
      payload = { action: 'close_tab', project_id: projectId, tab_ref: args.tab_ref };
      break;
    default:
      return textResult(`unknown tool: ${name}`, true);
  }

  const res = await postUiCommand(payload);
  if (!res.ok) return textResult(res.body || 'eve did not accept the command', true);
  return textResult(res.body || JSON.stringify({ status: 'ok' }));
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
          serverInfo: { name: 'eve-control', version: '1.0.0' },
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
