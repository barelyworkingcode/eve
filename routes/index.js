const createAuthRoutes = require('./auth');

function registerRoutes(app, { authService, relayUrl, schedulerUrl, refreshProjectCache }) {
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

  // Proxy helper: forwards request to a backend and returns the response
  async function proxyTo(req, res, baseUrl, method, path, body) {
    try {
      const url = `${baseUrl}${path}`;
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (body !== undefined) {
        opts.body = JSON.stringify(body);
      }
      const response = await fetch(url, opts);
      const data = await response.json();
      res.status(response.status).json(data);
      return data;
    } catch (err) {
      console.error(`[Proxy] ${method} ${baseUrl}${path} failed:`, err.message);
      res.status(502).json({ error: 'Service unavailable' });
      return null;
    }
  }

  // Shorthand for relayLLM proxy
  function proxy(req, res, method, relayPath, body) {
    return proxyTo(req, res, relayUrl, method, relayPath, body);
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

  app.post('/api/projects', requireAuth, async (req, res) => {
    const data = await proxy(req, res, 'POST', '/api/projects', req.body);
    if (data && data.id) refreshProjectCache();
  });

  app.get('/api/projects/:id', requireAuth, (req, res) => {
    proxy(req, res, 'GET', `/api/projects/${req.params.id}`);
  });

  app.put('/api/projects/:id', requireAuth, async (req, res) => {
    const data = await proxy(req, res, 'PUT', `/api/projects/${req.params.id}`, req.body);
    if (data && data.id) refreshProjectCache();
  });

  app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    // Cascade: delete tasks for this project in scheduler first
    try {
      await fetch(`${schedulerUrl}/api/tasks/by-project/${req.params.id}`, { method: 'DELETE' });
    } catch (err) {
      console.error('[Proxy] Scheduler cascade delete failed:', err.message);
    }
    await proxy(req, res, 'DELETE', `/api/projects/${req.params.id}`);
    refreshProjectCache();
  });

  // --- Sessions (proxy) ---
  app.get('/api/sessions', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/sessions');
  });

  // --- Tasks (proxy to scheduler) ---
  app.get('/api/tasks', requireAuth, (req, res) => {
    const qs = req.query.projectId ? `?projectId=${req.query.projectId}` : '';
    proxyTo(req, res, schedulerUrl, 'GET', `/api/tasks${qs}`);
  });

  app.post('/api/tasks', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'POST', '/api/tasks', req.body);
  });

  app.get('/api/tasks/:taskId', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'GET', `/api/tasks/${req.params.taskId}`);
  });

  app.put('/api/tasks/:taskId', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'PUT', `/api/tasks/${req.params.taskId}`, req.body);
  });

  app.delete('/api/tasks/:taskId', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'DELETE', `/api/tasks/${req.params.taskId}`);
  });

  app.delete('/api/tasks/by-project/:projectId', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'DELETE', `/api/tasks/by-project/${req.params.projectId}`);
  });

  app.get('/api/tasks/:taskId/history', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'GET', `/api/tasks/${req.params.taskId}/history`);
  });

  app.post('/api/tasks/:taskId/run', requireAuth, (req, res) => {
    proxyTo(req, res, schedulerUrl, 'POST', `/api/tasks/${req.params.taskId}/run`);
  });
}

module.exports = registerRoutes;
