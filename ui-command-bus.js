'use strict';
// UiCommandBus — routes LLM-initiated UI commands to the right browser(s).
//
// The eve-control MCP (mcp/main.js) POSTs to the loopback-only
// /internal/ui-command endpoint; this bus validates the call, stamps a trusted
// identity (actor=llm + the project that called), and forwards a `ui_command`
// frame to the browser connections viewing that project. The browser does the
// final ownership trimming — it only lets the LLM touch tabs the LLM opened.
//
// Targeting is by PROJECT: each browser connection announces the project(s) it
// is viewing (ws-handler tracks message.projectId) and we fan out to those.
// Session-level precision is a deferred refinement (see the eve-control plan).

const crypto = require('node:crypto');
const { NullLogger } = require('./logger');

/** True only for a genuine loopback peer — the internal endpoint accepts no other. */
function isLoopbackReq(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Constant-time secret comparison; false on any length mismatch or empty input. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

class UiCommandBus {
  constructor({ internalSecret, log } = {}) {
    this._secret = internalSecret || '';
    this._log = log || new NullLogger();
    this._byProject = new Map(); // projectId  -> Set<RelayClient>
    this._byClient = new Map();  // RelayClient -> Set<projectId>
    this._seq = 0;
  }

  /** Begin tracking a connection (so unregister cleans up even before any project). */
  register(client) {
    if (client && !this._byClient.has(client)) this._byClient.set(client, new Set());
  }

  /** Record that `client` is viewing `projectId` (idempotent). */
  setProject(client, projectId) {
    if (!client || !projectId) return;
    this.register(client);
    const projects = this._byClient.get(client);
    if (projects.has(projectId)) return;
    projects.add(projectId);
    let set = this._byProject.get(projectId);
    if (!set) {
      set = new Set();
      this._byProject.set(projectId, set);
    }
    set.add(client);
  }

  /** Drop a connection from all project indexes (call on socket close). */
  unregister(client) {
    const projects = this._byClient.get(client);
    if (projects) {
      for (const pid of projects) {
        const set = this._byProject.get(pid);
        if (set) {
          set.delete(client);
          if (set.size === 0) this._byProject.delete(pid);
        }
      }
    }
    this._byClient.delete(client);
  }

  _nextTabRef() {
    return `eve-llm-${Date.now().toString(36)}-${(this._seq++).toString(36)}`;
  }

  /** Fan a stamped ui_command out to every browser viewing `projectId`. Returns the delivery count. */
  pushToProject(projectId, command) {
    const frame = { type: 'ui_command', command, actor: 'llm', projectId: projectId || '' };
    const set = projectId ? this._byProject.get(projectId) : null;
    let delivered = 0;
    if (set) {
      for (const client of set) {
        try {
          client.sendToBrowser(frame);
          delivered++;
        } catch (err) {
          this._log.warn?.('ui_command push failed:', err.message);
        }
      }
    }
    return delivered;
  }

  /**
   * Express handler for POST /internal/ui-command. The eve-control MCP is the
   * only caller — gated to a loopback peer AND the shared secret. eve never
   * exposes this to the browser/public origin.
   */
  handleInternalRequest(req, res) {
    if (!isLoopbackReq(req)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!safeEqual(req.headers['x-eve-internal'] || '', this._secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const body = req.body || {};
    let tabRef = body.tab_ref;
    let command;

    switch (body.action) {
      case 'open_tab':
        if (!body.image_url) return res.status(400).json({ error: 'image_url required' });
        // eve mints the tab_ref so it owns tab identity; the LLM gets it back
        // and uses it for later refresh/close.
        tabRef = this._nextTabRef();
        command = { action: 'open_tab', tab_kind: body.tab_kind || 'image', tab_ref: tabRef, image_url: body.image_url, title: body.title || 'Image' };
        break;
      case 'refresh_tab':
        if (!tabRef) return res.status(400).json({ error: 'tab_ref required' });
        command = { action: 'refresh_tab', tab_kind: body.tab_kind || 'image', tab_ref: tabRef, image_url: body.image_url || null };
        break;
      case 'close_tab':
        if (!tabRef) return res.status(400).json({ error: 'tab_ref required' });
        command = { action: 'close_tab', tab_ref: tabRef };
        break;
      default:
        return res.status(400).json({ error: `unknown action: ${body.action}` });
    }

    const delivered = this.pushToProject(body.project_id || '', command);
    if (delivered === 0) {
      // Reached eve but matched no browser: usually an empty/mismatched
      // project_id (e.g. relay not rebuilt with the _meta.project_id injection)
      // or no browser currently viewing that project.
      this._log.warn?.(`ui_command undelivered: action=${body.action} project=${body.project_id || '(none)'} tracked=[${[...this._byProject.keys()].join(', ')}]`);
    }
    res.json({ status: delivered > 0 ? 'ok' : 'no_client', tab_ref: tabRef, delivered });
  }
}

module.exports = UiCommandBus;
