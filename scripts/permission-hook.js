#!/usr/bin/env node
//
// Eve PreToolUse hook script.
// Forwards Claude CLI permission decisions to Eve's HTTP server,
// which relays them to the browser UI for approve/deny.
//
// When EVE_HOOK_URL is not set, exits immediately (no-op for normal CLI usage).
// On network errors, exits 0 (fail-open so server issues don't freeze the CLI).

const http = require('http');
const https = require('https');

const hookUrl = process.env.EVE_HOOK_URL;
const sessionId = process.env.EVE_SESSION_ID;
const authToken = process.env.EVE_AUTH_TOKEN;

// No-op when not running under Eve
if (!hookUrl) process.exit(0);

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Invalid input -- allow by default
    process.exit(0);
  }

  const payload = JSON.stringify({
    sessionId,
    toolName: data.tool_name,
    toolInput: data.tool_input,
    toolUseId: data.tool_use_id
  });

  const url = new URL(`${hookUrl}/api/permission`);
  const transport = url.protocol === 'https:' ? https : http;

  const req = transport.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
    },
    timeout: 120000
  }, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: result.decision,
            permissionDecisionReason: result.reason || ''
          }
        }));
      } catch {
        // Unparseable response -- allow by default
      }
    });
  });

  req.on('error', () => {
    // Network error -- fail-open, allow by default
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });

  req.write(payload);
  req.end();
});
