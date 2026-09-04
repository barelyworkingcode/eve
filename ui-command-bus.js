'use strict';
// /internal/ui-command is loopback-only. This bus stamps a trusted identity
// (actor=llm + calling project) onto each command and forwards it to browser
// connections viewing that project; the browser does final ownership trimming
// (LLM can only touch tabs it opened). Targeting is by project, not session —
// ws-handler tracks each connection's message.projectId.

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

  // So unregister() cleans up even for a client that never joined a project.
  register(client) {
    if (client && !this._byClient.has(client)) this._byClient.set(client, new Set());
  }

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

  // Call on socket close.
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

  // Gated to a loopback peer AND the shared secret; never exposed to the
  // browser/public origin.
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
        // eve mints the tab_ref so it owns tab identity.
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
      // Usually a mismatched project_id or no browser currently viewing it.
      this._log.warn?.(`ui_command undelivered: action=${body.action} project=${body.project_id || '(none)'} tracked=[${[...this._byProject.keys()].join(', ')}]`);
    }
    res.json({ status: delivered > 0 ? 'ok' : 'no_client', tab_ref: tabRef, delivered });
  }
}

module.exports = UiCommandBus;
