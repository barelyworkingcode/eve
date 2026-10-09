const createAuthRoutes = require('./auth');
const { HIDDEN_SEARCH_PREFIX } = require('../search-summarizer');
const path = require('path');
const express = require('express');
const { saveTerminalPaste, MAX_PASTE_BYTES } = require('../terminal-paste');
const { projectAudit } = require('../project-audit');

function isHiddenSession(name) {
  return (name || '').startsWith(HIDDEN_SEARCH_PREFIX);
}

const { NullLogger } = require('../logger');

function registerRoutes(app, { authService, trustedNetwork, relayTransport, enrollmentWindow, passkeySync, refreshProjectCache, removeFromProjectCache, resolveProject, fileServiceFor, files, refreshHostCache, removeFromHostCache, ttsService, sttService, log: parentLog }) {
  const routeLog = parentLog?.child('Routes') || new NullLogger();
  function requireAuth(req, res, next) {
    if (!authService.isEnrolled() || process.env.EVE_NO_AUTH === '1' || trustedNetwork.isTrusted(req)) {
      return next();
    }
    const token = req.headers['x-session-token'];
    if (!authService.validateSession(token)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  app.use('/api', createAuthRoutes(authService, trustedNetwork, routeLog.child('Auth'), { enrollmentWindow, passkeySync }));

  // One line per proxied call, when it ends. Never the body, data, headers or
  // query: the path is logged with its query string cut off.
  function logProxyCall(req, { op, method, relayPath, startedAt, httpStatus, data, err }) {
    const pathOnly = relayPath.split('?')[0];
    let status = 'ok';
    let level = 'info';
    if (err || httpStatus >= 500) { status = 'error'; level = 'error'; }
    else if (httpStatus === 401 || httpStatus === 403) { status = 'denied'; level = 'warn'; }
    else if (httpStatus >= 400) { status = 'error'; level = 'warn'; }
    const attrs = {
      op, status, duration_ms: Date.now() - startedAt,
      http_status: err ? 502 : httpStatus, method, path: pathOnly,
    };
    if (err) attrs.error = err.message;
    else if (status !== 'ok') attrs.error = `relay answered ${httpStatus}`;
    if (op === 'schedule.create' && status === 'ok' && data && typeof data.id === 'string' && data.id !== '') {
      attrs.job_id = data.id;
    }
    routeLog.withTrace(req.traceId)[level](`${method} ${pathOnly}`, attrs);
  }

  function proxy(req, res, method, relayPath, body, { op = 'http.request' } = {}) {
    const startedAt = Date.now();
    return relayTransport.fetch(method, relayPath, body, { traceId: req.traceId })
      .then(({ status, data }) => {
        res.status(status).json(data);
        logProxyCall(req, { op, method, relayPath, startedAt, httpStatus: status, data });
        return data;
      })
      .catch(err => {
        res.status(502).json({ error: 'Service unavailable' });
        logProxyCall(req, { op, method, relayPath, startedAt, err });
        return null;
      });
  }

  app.get('/api/models', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/models');
  });

  app.get('/api/projects', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', '/api/projects');
      if (data && Array.isArray(data)) {
        await refreshProjectCache(data, { replace: true });
        const normalized = data.map(p => resolveProject(p.id)).filter(Boolean);
        res.status(status).json(normalized);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.withTrace(req.traceId).error('GET /api/projects failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.get('/api/projects/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', `/api/projects/${req.params.id}`);
      if (data && data.id) {
        await refreshProjectCache([data]);
        res.status(status).json(resolveProject(data.id) || data);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`GET /api/projects/${req.params.id} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  async function proxyProjectMutation(req, method, relayPath, body, res, errLabel) {
    try {
      const { status, data } = await relayTransport.fetch(method, relayPath, body);
      if (status >= 200 && status < 300 && data && data.id) {
        await refreshProjectCache([data]);
        res.status(status).json(resolveProject(data.id) || data);
      } else {
        res.status(status).json(data ?? {});
      }
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`${errLabel} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  }

  app.post('/api/projects', requireAuth, (req, res) =>
    proxyProjectMutation(req, 'POST', '/api/projects', req.body, res, 'POST /api/projects'));

  app.put('/api/projects/:id', requireAuth, (req, res) =>
    proxyProjectMutation(req, 'PUT', `/api/projects/${req.params.id}`, req.body, res, `PUT /api/projects/${req.params.id}`));

  app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('DELETE', `/api/projects/${req.params.id}`);
      if (status >= 200 && status < 300) {
        removeFromProjectCache(req.params.id);
      }
      res.status(status).json(data || {});
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`DELETE /api/projects/${req.params.id} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  // ssh_argv never crosses this boundary (../relay/docs/ssh-hosts.md): relay's
  // hostView carries it so relay/relayLLM/eve can each derive the same ssh
  // invocation, but only eve's server-side hostCache (server.js) keeps it —
  // every response the browser can see strips it here.
  function stripSshArgv(hostView) {
    if (!hostView || typeof hostView !== 'object') return hostView;
    const { ssh_argv, ...rest } = hostView;
    return rest;
  }

  app.get('/api/hosts', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', '/api/hosts');
      if (status >= 200 && status < 300 && Array.isArray(data)) {
        refreshHostCache(data, { replace: true });
        res.status(status).json(data.map(stripSshArgv));
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.withTrace(req.traceId).error('GET /api/hosts failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  async function proxyHostMutation(req, method, relayPath, body, res, errLabel) {
    try {
      const { status, data } = await relayTransport.fetch(method, relayPath, body);
      if (status >= 200 && status < 300 && data && data.id) {
        refreshHostCache([data]);
      }
      res.status(status).json(stripSshArgv(data) ?? {});
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`${errLabel} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  }

  app.post('/api/hosts', requireAuth, (req, res) =>
    proxyHostMutation(req, 'POST', '/api/hosts', req.body, res, 'POST /api/hosts'));

  app.put('/api/hosts/:id', requireAuth, (req, res) =>
    proxyHostMutation(req, 'PUT', `/api/hosts/${req.params.id}`, req.body, res, `PUT /api/hosts/${req.params.id}`));

  app.delete('/api/hosts/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('DELETE', `/api/hosts/${req.params.id}`);
      if (status >= 200 && status < 300) {
        removeFromHostCache(req.params.id);
      }
      res.status(status).json(data || {});
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`DELETE /api/hosts/${req.params.id} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.post('/api/hosts/:id/probe', requireAuth, (req, res) =>
    proxyHostMutation(req, 'POST', `/api/hosts/${req.params.id}/probe`, undefined, res, `POST /api/hosts/${req.params.id}/probe`));

  app.post('/api/hosts/:id/disconnect', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('POST', `/api/hosts/${req.params.id}/disconnect`);
      if (status >= 200 && status < 300 && data && data.id) {
        refreshHostCache([data]);
      }
      res.status(status).json(stripSshArgv(data) ?? {});
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`POST /api/hosts/${req.params.id}/disconnect failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.get('/api/mcps', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/mcps');
  });

  // A sidebar list fetched mid-call would otherwise show these in-flight
  // sessions. The prefix is defined in search-summarizer.js.
  app.get('/api/sessions', requireAuth, async (req, res) => {
    try {
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
        const filtered = sessions.filter(s => !isHiddenSession(s.name));
        res.status(status).json(filtered);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.withTrace(req.traceId).error('GET /api/sessions failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.get('/api/tasks', requireAuth, (req, res) => {
    const qs = req.query.projectId ? `?projectId=${encodeURIComponent(req.query.projectId)}` : '';
    proxy(req, res, 'GET', `/api/tasks${qs}`);
  });

  // A Today card runs a script on a schedule, so setting one needs a real passkey
  // session; the trusted-network bypass may still run and view cards.
  function requireSessionForOutputFile(req, res, next) {
    if (!req.body || !req.body.outputFile || process.env.EVE_NO_AUTH === '1') return next();
    if (authService.validateSession(req.headers['x-session-token'])) return next();
    res.status(403).json({ error: 'Only a browser signed in with a passkey can set up a Today card.' });
  }

  app.post('/api/tasks', requireAuth, requireSessionForOutputFile, (req, res) => {
    proxy(req, res, 'POST', '/api/tasks', req.body, { op: 'schedule.create' });
  });

  app.get('/api/tasks/:taskId', requireAuth, (req, res) => {
    proxy(req, res, 'GET', `/api/tasks/${req.params.taskId}`);
  });

  app.put('/api/tasks/:taskId', requireAuth, requireSessionForOutputFile, (req, res) => {
    proxy(req, res, 'PUT', `/api/tasks/${req.params.taskId}`, req.body);
  });

  app.delete('/api/tasks/:taskId', requireAuth, (req, res) => {
    proxy(req, res, 'DELETE', `/api/tasks/${req.params.taskId}`);
  });

  app.delete('/api/tasks/by-project/:projectId', requireAuth, (req, res) => {
    proxy(req, res, 'DELETE', `/api/tasks/by-project/${req.params.projectId}`);
  });

  app.get('/api/tasks/:taskId/history', requireAuth, (req, res) => {
    proxy(req, res, 'GET', `/api/tasks/${req.params.taskId}/history`);
  });

  app.post('/api/tasks/:taskId/run', requireAuth, (req, res) => {
    proxy(req, res, 'POST', `/api/tasks/${req.params.taskId}/run`);
  });

  app.get('/api/terminal/templates', requireAuth, (req, res) => {
    const project = req.query.project ? `?project=${encodeURIComponent(req.query.project)}` : '';
    proxy(req, res, 'GET', `/api/terminal/templates${project}`);
  });

  app.post('/api/terminal/templates', requireAuth, (req, res) => {
    proxy(req, res, 'POST', '/api/terminal/templates', req.body);
  });

  app.put('/api/terminal/templates/:id', requireAuth, (req, res) => {
    proxy(req, res, 'PUT', `/api/terminal/templates/${req.params.id}`, req.body);
  });

  app.delete('/api/terminal/templates/:id', requireAuth, (req, res) => {
    proxy(req, res, 'DELETE', `/api/terminal/templates/${req.params.id}`);
  });

  app.get('/api/projects/:id/audit', requireAuth, async (req, res) => {
    const { status, body } = await projectAudit(relayTransport, req.params.id, resolveProject);
    res.status(status).json(body);
  });

  // Persistent (tmux) sessions on a host project's remote host. relay owns
  // enumeration, the name/ownership checks and the kill; eve only forwards.
  app.get('/api/projects/:id/persistent-sessions', requireAuth, (req, res) => {
    proxy(req, res, 'GET', `/api/projects/${encodeURIComponent(req.params.id)}/persistent-sessions`);
  });

  app.delete('/api/projects/:id/persistent-sessions/:name', requireAuth, async (req, res) => {
    const relayPath = `/api/projects/${encodeURIComponent(req.params.id)}/persistent-sessions/${encodeURIComponent(req.params.name)}`;
    try {
      const { status, data } = await relayTransport.fetch('DELETE', relayPath);
      if (status === 204) return res.status(204).end();
      res.status(status).json(data || {});
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`DELETE ${relayPath} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  // Drop in to a headless Claude session: relay stops the headless process and
  // opens a terminal on the same conversation (relay `session.drop_in`). The body
  // check also keeps a cross-site no-cors POST, which cannot send JSON, out.
  app.post('/api/sessions/:id/drop-in', requireAuth, (req, res) => {
    const whole = (n) => Number.isInteger(n) && n >= 1 && n <= 500;
    const { cols, rows } = req.body || {};
    if (!whole(cols) || !whole(rows)) {
      return res.status(400).json({ error: 'cols and rows must be whole numbers from 1 to 500' });
    }
    proxy(req, res, 'POST', `/api/sessions/${encodeURIComponent(req.params.id)}/drop-in`,
      { cols, rows }, { op: 'session.drop_in' });
  });

  // The id is forwarded without shape validation here: relayLLM rejects ids it
  // won't accept before joining one into a log filename.
  app.get('/api/terminals/:id/log', requireAuth, async (req, res) => {
    try {
      const { status, data, headers } = await relayTransport.fetchRaw('GET',
        `/api/terminals/${encodeURIComponent(req.params.id)}/log`);
      if (status !== 200) {
        return res.status(status).json({ error: 'Terminal log not found' });
      }
      res.set('Content-Type', headers['content-type'] || 'application/octet-stream');
      res.set('Cache-Control', 'no-store');
      res.send(data);
    } catch (err) {
      routeLog.withTrace(req.traceId).error(`GET /api/terminals/${req.params.id}/log failed:`, err.message);
      res.status(502).json({ error: 'Terminal log unavailable' });
    }
  });

  // An image pasted into a terminal pane: saved to a temp file where the
  // terminal runs (the host when ?host= is set) and answered with its path,
  // which the pane then pastes as text. See terminal-paste.js.
  app.post('/api/terminal/paste-image', requireAuth,
    express.raw({ type: 'image/*', limit: MAX_PASTE_BYTES }),
    async (req, res) => {
      const hostId = typeof req.query.host === 'string' ? req.query.host : '';
      try {
        const filePath = await saveTerminalPaste(
          { buffer: Buffer.isBuffer(req.body) ? req.body : null, mimeType: (req.get('content-type') || '').split(';')[0].trim(), hostId },
          { files });
        res.json({ path: filePath });
      } catch (err) {
        routeLog.withTrace(req.traceId).error(`POST /api/terminal/paste-image failed (host=${hostId || 'console'}):`, err.message);
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to save image' });
      }
    });

  let voiceCache = null;
  let voiceCacheTime = 0;
  app.get('/api/tts/voices', requireAuth, async (req, res) => {
    try {
      if (!voiceCache || Date.now() - voiceCacheTime > 5 * 60 * 1000) {
        voiceCache = await ttsService.listVoices();
        voiceCacheTime = Date.now();
      }
      res.json(voiceCache);
    } catch (err) {
      if (voiceCache) return res.json(voiceCache); // stale cache better than error
      res.status(503).json({ error: 'TTS service unavailable' });
    }
  });

  app.get('/api/stt/status', requireAuth, async (req, res) => {
    const available = await sttService.isAvailable();
    res.json({ available });
  });

  app.post('/api/transcribe', requireAuth, async (req, res) => {
    try {
      const { audio, language } = req.body;
      if (!audio) return res.status(400).json({ error: 'No audio data provided' });
      const result = await sttService.transcribe(audio, language || null, { traceId: req.traceId });
      res.json({ text: result.text, language: result.language });
    } catch (err) {
      routeLog.withTrace(req.traceId).error('STT transcription failed:', err.message);
      res.status(503).json({ error: 'STT service unavailable' });
    }
  });

  app.get('/api/generated/:filename', requireAuth, async (req, res) => {
    try {
      const { status, data, headers } = await relayTransport.fetchRaw('GET',
        `/api/generated/${encodeURIComponent(req.params.filename)}`);
      if (status !== 200) {
        return res.status(status).json({ error: 'Image not found' });
      }
      if (headers['content-type']) res.set('Content-Type', headers['content-type']);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(data);
    } catch (err) {
      routeLog.withTrace(req.traceId).error('Generated image proxy failed:', err.message);
      res.status(502).json({ error: 'Image not available' });
    }
  });

  // This route serves project files from Eve's OWN origin — a file arriving
  // via upload, an agent write, or a sync is untrusted, and HTML/SVG/XML
  // served same-origin is a stored-XSS vector. `sandbox` is scoped to just
  // those script-capable types: applied to a PDF it blocks Chrome's built-in
  // viewer and the frame goes blank. `?preview=1` is the one opt-in that
  // renders HTML inline, for the editor's preview pane (file-editor.js): the
  // response-level `sandbox allow-scripts` CSP forces an opaque origin even
  // on direct top-level navigation, so the page's scripts run but can't reach
  // Eve's DOM, cookies, or session token.
  const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml']);
  const HTML_PREVIEW_EXTS = new Set(['.html', '.htm']);

  // A file arrives as raw bytes from relay with no type of its own, so this
  // maps what a project actually contains.
  const EXT_MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  };
  const mimeForExt = (ext) => EXT_MIME[ext] || 'application/octet-stream';

  function setFileResponseHeaders(res, req, ext, filename) {
    if (req.query.preview === '1' && HTML_PREVIEW_EXTS.has(ext)) {
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
    } else if (ACTIVE_CONTENT_EXTS.has(ext)) {
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
      res.set('Content-Security-Policy', "default-src 'none'");
    }
  }

  // Streams the file from relay (RelayFileClient#openStream) instead of
  // res.sendFile: eve has no local path to hand Express. A console project
  // answers Range with 206 and the requested bytes; a host project always
  // answers 200 with the whole file, chunked. Neither is buffered here.
  const FILE_ERROR_STATUS = {
    ENOENT: 404, TRAVERSAL: 403, SYMLINK: 403, EACCES: 403, EISDIR: 400, ENOTDIR: 400,
  };

  async function serveProjectFile(req, res, project, relativePath) {
    const files = fileServiceFor(project);
    let full;
    try {
      full = files.validatePath(project.path, relativePath);
    } catch {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    let upstream;
    try {
      upstream = await files.openStream(project.path, relativePath, { range: req.headers.range });
    } catch (err) {
      return res.status(FILE_ERROR_STATUS[err.code] || 503).json({ error: err.message || 'File not found' });
    }

    if (upstream.status === 416) {
      upstream.body.resume();
      res.status(416);
      if (upstream.headers['content-range']) res.set('Content-Range', upstream.headers['content-range']);
      return res.end();
    }

    const ext = path.posix.extname(full).toLowerCase();
    setFileResponseHeaders(res, req, ext, path.posix.basename(full));
    res.status(upstream.status === 206 ? 206 : 200);
    res.set('Content-Type', mimeForExt(ext));
    for (const h of ['accept-ranges', 'content-length', 'content-range']) {
      if (upstream.headers[h] !== undefined) res.set(h, upstream.headers[h]);
    }
    res.on('close', () => upstream.body.destroy());
    upstream.body.on('error', () => res.destroy());
    upstream.body.pipe(res);
  }

  app.get('/api/files/:projectId/*', requireAuth, (req, res) => {
    const project = resolveProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const relativePath = req.params[0];
    if (!relativePath) return res.status(400).json({ error: 'Path required' });

    res.set('X-Content-Type-Options', 'nosniff');
    return serveProjectFile(req, res, project, relativePath);
  });
}

module.exports = registerRoutes;
