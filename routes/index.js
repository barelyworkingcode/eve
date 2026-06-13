const createAuthRoutes = require('./auth');
const moduleRoutes = require('./modules');
const { HIDDEN_SESSION_PREFIX } = require('../module-invoker');
const { HIDDEN_SEARCH_PREFIX } = require('../search-summarizer');
const path = require('path');

const HIDDEN_SESSION_PREFIXES = [HIDDEN_SESSION_PREFIX, HIDDEN_SEARCH_PREFIX];
function isHiddenSession(name) {
  const n = name || '';
  return HIDDEN_SESSION_PREFIXES.some(p => n.startsWith(p));
}

const { NullLogger } = require('../logger');

function registerRoutes(app, { authService, trustedNetwork, relayTransport, refreshProjectCache, removeFromProjectCache, resolveProject, fileService, ttsService, sttService, moduleService, log: parentLog }) {
  const routeLog = parentLog?.child('Routes') || new NullLogger();
  // Shared auth middleware.
  // Bypass order: (1) no passkey enrolled yet — first-run bootstrap; (2) the
  // global kill-switch EVE_NO_AUTH=1; (3) the client is on a trusted subnet
  // (raw TCP source address only — never the Host header). Otherwise a valid
  // session token is required.
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

  // Auth routes (local, no proxy)
  app.use('/api', createAuthRoutes(authService, trustedNetwork, routeLog.child('Auth')));

  // Proxy helper: forwards request to relayLLM via the shared RelayTransport
  // and sends the response. Callers that need pre-response processing (cache
  // refresh, etc.) call relayTransport.fetch() directly and send the response
  // themselves — see the mutation handlers below.
  function proxy(req, res, method, relayPath, body) {
    return relayTransport.fetch(method, relayPath, body)
      .then(({ status, data }) => {
        res.status(status).json(data);
        return data;
      })
      .catch(err => {
        routeLog.error(`${method} ${relayPath} failed:`, err.message);
        res.status(502).json({ error: 'Service unavailable' });
        return null;
      });
  }

  // --- Models (proxy) ---
  app.get('/api/models', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/models');
  });

  // --- Projects (read-only proxy; CRUD managed via relay settings UI) ---
  // Normalize snake_case from relay to camelCase for browser.
  app.get('/api/projects', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', '/api/projects');
      if (data && Array.isArray(data)) {
        refreshProjectCache(data);
        // Return normalized (camelCase) projects from cache.
        const normalized = data.map(p => resolveProject(p.id)).filter(Boolean);
        res.status(status).json(normalized);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.error('GET /api/projects failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.get('/api/projects/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', `/api/projects/${req.params.id}`);
      if (data && data.id) {
        refreshProjectCache([data]);
        res.status(status).json(resolveProject(data.id) || data);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.error(`GET /api/projects/${req.params.id} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  // After a successful upsert we feed the relay response into the cache
  // directly — refreshProjectCache(undefined) replaces the whole list and
  // would force a round-trip we don't need.
  async function proxyProjectMutation(method, relayPath, body, res, errLabel) {
    try {
      const { status, data } = await relayTransport.fetch(method, relayPath, body);
      if (status >= 200 && status < 300 && data && data.id) {
        refreshProjectCache([data]);
        res.status(status).json(resolveProject(data.id) || data);
      } else {
        res.status(status).json(data ?? {});
      }
    } catch (err) {
      routeLog.error(`${errLabel} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  }

  app.post('/api/projects', requireAuth, (req, res) =>
    proxyProjectMutation('POST', '/api/projects', req.body, res, 'POST /api/projects'));

  app.put('/api/projects/:id', requireAuth, (req, res) =>
    proxyProjectMutation('PUT', `/api/projects/${req.params.id}`, req.body, res, `PUT /api/projects/${req.params.id}`));

  app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('DELETE', `/api/projects/${req.params.id}`);
      if (status >= 200 && status < 300) {
        removeFromProjectCache(req.params.id);
      }
      res.status(status).json(data || {});
    } catch (err) {
      routeLog.error(`DELETE /api/projects/${req.params.id} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  // --- MCP listing (proxy; populates project dialog "Allowed MCPs" picker) ---
  app.get('/api/mcps', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/mcps');
  });

  // --- Sessions (proxy) ---
  // Hide ephemeral sessions created on the WS path — module AI invocations
  // (`__module:`) and search summarizations (`__search:`). They're created
  // and deleted around a single call, but a sidebar list fetched mid-call
  // would otherwise show the in-flight session. Prefixes are defined in
  // module-invoker.js and search-summarizer.js — keep in lockstep.
  app.get('/api/sessions', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', '/api/sessions');
      if (status >= 200 && status < 300 && Array.isArray(data)) {
        const filtered = data.filter(s => !isHiddenSession(s.name));
        res.status(status).json(filtered);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.error('GET /api/sessions failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  // --- Modules (list + static file serving; AI invocation is WS-only) ---
  moduleRoutes.register(app, {
    requireAuth, moduleService, resolveProject, log: parentLog,
  });

  // --- Tasks (proxy through relayLLM → scheduler) ---
  app.get('/api/tasks', requireAuth, (req, res) => {
    const qs = req.query.projectId ? `?projectId=${encodeURIComponent(req.query.projectId)}` : '';
    proxy(req, res, 'GET', `/api/tasks${qs}`);
  });

  app.post('/api/tasks', requireAuth, (req, res) => {
    proxy(req, res, 'POST', '/api/tasks', req.body);
  });

  app.get('/api/tasks/:taskId', requireAuth, (req, res) => {
    proxy(req, res, 'GET', `/api/tasks/${req.params.taskId}`);
  });

  app.put('/api/tasks/:taskId', requireAuth, (req, res) => {
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

  // --- Terminal templates (proxy) ---
  app.get('/api/terminal/templates', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/terminal/templates');
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

  // --- Terminal logs (proxy binary from relayLLM) ---
  // The PTY's raw byte stream — used by TaskViewer's readonly renderer to
  // replay completed scheduled-task output. Response is application/octet-
  // stream and may contain arbitrary bytes (ANSI escapes, non-UTF8) so we
  // go through fetchRaw instead of the JSON-only proxy() helper. The IDs
  // are validated server-side (relayLLM rejects non-UUID-shaped paths) so
  // path traversal isn't a concern here, but we still encodeURIComponent
  // to keep the URL well-formed.
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
      routeLog.error(`GET /api/terminals/${req.params.id}/log failed:`, err.message);
      res.status(502).json({ error: 'Terminal log unavailable' });
    }
  });

  // --- TTS voices (cached, refreshes every 5 min) ---
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

  // --- STT (Speech-to-Text) ---
  app.get('/api/stt/status', requireAuth, async (req, res) => {
    const available = await sttService.isAvailable();
    res.json({ available });
  });

  app.post('/api/transcribe', requireAuth, async (req, res) => {
    try {
      const { audio, language } = req.body;
      if (!audio) return res.status(400).json({ error: 'No audio data provided' });
      const result = await sttService.transcribe(audio, language || null);
      res.json({ text: result.text, language: result.language });
    } catch (err) {
      routeLog.error('STT transcription failed:', err.message);
      res.status(503).json({ error: 'STT service unavailable' });
    }
  });

  // --- Generated images (proxy binary from relayLLM) ---
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
      routeLog.error('Generated image proxy failed:', err.message);
      res.status(502).json({ error: 'Image not available' });
    }
  });

  // --- Raw file serving (for binary file viewers: images, PDFs, video, audio) ---
  //
  // This route serves project files from Eve's OWN origin. Anything that can
  // execute script in that origin (HTML, SVG, XML) is a stored-XSS vector —
  // a file can arrive via upload, an agent write, or a synced project. We:
  //   1. block path traversal with a separator-aware containment check,
  //   2. force `nosniff` on every file and a locked-down `default-src 'none'`
  //      CSP so no served file can pull sub-resources or run script,
  //   3. for script-capable types, ALSO add the `sandbox` directive and force
  //      `Content-Disposition: attachment` so they download instead of
  //      rendering in Eve's origin.
  // The `sandbox` directive is scoped to those script-capable types on purpose:
  // applied to a PDF it blocks Chrome's built-in viewer and the frame goes blank.
  //
  // `?preview=1` is the one opt-in that renders HTML inline: the editor's preview
  // pane (file-editor.js) needs the page's own scripts to run. We serve it with a
  // response-level `sandbox allow-scripts` CSP, which forces an opaque origin even
  // on direct top-level navigation — so scripts run, but the page still cannot
  // reach Eve's DOM, cookies, or session token. Without the flag, HTML downloads.
  // See docs/security-audit-frontend.md (H1, H2).
  const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml']);
  const HTML_PREVIEW_EXTS = new Set(['.html', '.htm']);

  app.get('/api/files/:projectId/*', requireAuth, (req, res) => {
    const project = resolveProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const relativePath = req.params[0];
    if (!relativePath) return res.status(400).json({ error: 'Path required' });

    // Prevent path traversal. Use centralized path validation from FileService.
    const base = path.resolve(project.path);
    const resolved = path.resolve(base, relativePath);
    if (!fileService.isPathWithin(base, resolved)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    res.set('X-Content-Type-Options', 'nosniff');

    const ext = path.extname(resolved).toLowerCase();
    // Containment is already enforced above by isPathWithin; dot-directories
    // (e.g. .playwright-cli, .claude) hold legitimate, already-listed project
    // files, so serve them. 'deny' would 403 every file under a hidden dir.
    const options = { dotfiles: 'allow' };
    if (req.query.preview === '1' && HTML_PREVIEW_EXTS.has(ext)) {
      // Sandboxed live preview: the page's own scripts run inside an opaque
      // origin, fully isolated from Eve. Rendered inline (no attachment).
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
    } else if (ACTIVE_CONTENT_EXTS.has(ext)) {
      // Script-capable: fully neutralize — sandbox the document AND force a
      // download so it never renders inline in Eve's origin.
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.set('Content-Disposition', `attachment; filename="${path.basename(resolved)}"`);
    } else {
      // Inert (PDF/image/audio/video): lock down sub-resource loading but omit
      // `sandbox`, which would blank out Chrome's native PDF viewer.
      res.set('Content-Security-Policy', "default-src 'none'");
    }

    res.sendFile(resolved, options, (err) => {
      if (err && !res.headersSent) {
        const status = err.code === 'ENOENT' ? 404 : 500;
        res.status(status).json({ error: 'File not found' });
      }
    });
  });
}

module.exports = registerRoutes;
