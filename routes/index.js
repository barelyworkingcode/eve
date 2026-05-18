const createAuthRoutes = require('./auth');
const moduleRoutes = require('./modules');
const path = require('path');

const { NullLogger } = require('../logger');

function registerRoutes(app, { authService, trustedNetwork, relayTransport, refreshProjectCache, removeFromProjectCache, resolveProject, ttsService, sttService, moduleService, fileService, log: parentLog }) {
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
  // Hide ephemeral module-invocation sessions (created by POST /api/modules/invoke).
  // They're created/deleted within a single HTTP request, but a sidebar list
  // fetched mid-invocation would otherwise show the in-flight session.
  app.get('/api/sessions', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', '/api/sessions');
      if (status >= 200 && status < 300 && Array.isArray(data)) {
        const filtered = data.filter(s => !(s.name || '').startsWith(moduleRoutes.HIDDEN_SESSION_PREFIX));
        res.status(status).json(filtered);
      } else {
        res.status(status).json(data);
      }
    } catch (err) {
      routeLog.error('GET /api/sessions failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  // --- Modules (local + ephemeral relay invocation) ---
  moduleRoutes.register(app, {
    requireAuth, moduleService, fileService, resolveProject, relayTransport, log: parentLog,
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
  app.get('/api/files/:projectId/*', requireAuth, (req, res) => {
    const project = resolveProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const relativePath = req.params[0];
    if (!relativePath) return res.status(400).json({ error: 'Path required' });

    // Prevent path traversal
    const resolved = path.resolve(project.path, relativePath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    res.sendFile(resolved, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) {
        const status = err.code === 'ENOENT' ? 404 : 500;
        res.status(status).json({ error: 'File not found' });
      }
    });
  });
}

module.exports = registerRoutes;
