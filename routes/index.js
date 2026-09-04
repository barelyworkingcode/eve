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

  app.use('/api', createAuthRoutes(authService, trustedNetwork, routeLog.child('Auth')));

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

  app.get('/api/models', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/models');
  });

  app.get('/api/projects', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayTransport.fetch('GET', '/api/projects');
      if (data && Array.isArray(data)) {
        refreshProjectCache(data);
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

  app.get('/api/mcps', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/mcps');
  });

  // A sidebar list fetched mid-call would otherwise show these in-flight
  // sessions. Prefixes are defined in module-invoker.js and
  // search-summarizer.js — keep in lockstep.
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

  moduleRoutes.register(app, {
    requireAuth, moduleService, resolveProject, log: parentLog,
  });

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
      routeLog.error(`GET /api/terminals/${req.params.id}/log failed:`, err.message);
      res.status(502).json({ error: 'Terminal log unavailable' });
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
      const result = await sttService.transcribe(audio, language || null);
      res.json({ text: result.text, language: result.language });
    } catch (err) {
      routeLog.error('STT transcription failed:', err.message);
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
      routeLog.error('Generated image proxy failed:', err.message);
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

  app.get('/api/files/:projectId/*', requireAuth, (req, res) => {
    const project = resolveProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const relativePath = req.params[0];
    if (!relativePath) return res.status(400).json({ error: 'Path required' });

    const base = path.resolve(project.path);
    const resolved = path.resolve(base, relativePath);
    if (!fileService.isPathWithin(base, resolved)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    res.set('X-Content-Type-Options', 'nosniff');

    const ext = path.extname(resolved).toLowerCase();
    // dot-directories (e.g. .playwright-cli, .claude) hold legitimate,
    // already-listed project files; 'deny' would 403 every file under one.
    const options = { dotfiles: 'allow' };
    if (req.query.preview === '1' && HTML_PREVIEW_EXTS.has(ext)) {
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
    } else if (ACTIVE_CONTENT_EXTS.has(ext)) {
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.set('Content-Disposition', `attachment; filename="${path.basename(resolved)}"`);
    } else {
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
