const createAuthRoutes = require('./auth');
const path = require('path');

const { NullLogger } = require('../logger');

function registerRoutes(app, { authService, trustedNetwork, relayTransport, refreshProjectCache, resolveProject, ttsService, sttService, log: parentLog }) {
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

  // --- Sessions (proxy) ---
  app.get('/api/sessions', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/sessions');
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
