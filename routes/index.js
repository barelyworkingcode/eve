const createAuthRoutes = require('./auth');

function registerRoutes(app, { authService, relayUrl, refreshProjectCache }) {
  // Shared auth middleware
  function requireAuth(req, res, next) {
    if (!authService.isEnrolled() || process.env.EVE_NO_AUTH === '1' || authService.isLocalhost(req)) {
      return next();
    }
    const token = req.headers['x-session-token'];
    if (!authService.validateSession(token)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Auth routes (local, no proxy)
  app.use('/api', createAuthRoutes(authService));

  // Fetch from a backend without sending the response (for routes that need pre-response processing)
  async function relayFetch(method, path, body) {
    const url = `${relayUrl}${path}`;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const response = await fetch(url, opts);
    const data = await response.json();
    return { status: response.status, data };
  }

  // Proxy helper: forwards request to relayLLM and sends the response
  function proxy(req, res, method, relayPath, body) {
    return relayFetch(method, relayPath, body)
      .then(({ status, data }) => {
        res.status(status).json(data);
        return data;
      })
      .catch(err => {
        console.error(`[Proxy] ${method} ${relayUrl}${relayPath} failed:`, err.message);
        res.status(502).json({ error: 'Service unavailable' });
        return null;
      });
  }

  // --- Models (proxy) ---
  app.get('/api/models', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/models');
  });

  // --- Projects (proxy, refresh cache on mutations) ---
  app.get('/api/projects', requireAuth, async (req, res) => {
    const data = await proxy(req, res, 'GET', '/api/projects');
    if (data && Array.isArray(data)) refreshProjectCache(data);
  });

  // Mutation routes: refresh cache BEFORE sending response to prevent race condition
  // where client acts on response before cache is updated
  app.post('/api/projects', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayFetch('POST', '/api/projects', req.body);
      if (data && data.id) await refreshProjectCache();
      res.status(status).json(data);
    } catch (err) {
      console.error('[Proxy] POST /api/projects failed:', err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.get('/api/projects/:id', requireAuth, (req, res) => {
    proxy(req, res, 'GET', `/api/projects/${req.params.id}`);
  });

  app.put('/api/projects/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayFetch('PUT', `/api/projects/${req.params.id}`, req.body);
      if (data && data.id) await refreshProjectCache();
      res.status(status).json(data);
    } catch (err) {
      console.error(`[Proxy] PUT /api/projects/${req.params.id} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
    }
  });

  app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    try {
      const { status, data } = await relayFetch('DELETE', `/api/projects/${req.params.id}`);
      await refreshProjectCache();
      res.status(status).json(data);
    } catch (err) {
      console.error(`[Proxy] DELETE /api/projects/${req.params.id} failed:`, err.message);
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
}

module.exports = registerRoutes;
