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

  // Proxy helper: forwards request to relayLLM and returns the response
  async function proxy(req, res, method, relayPath, body) {
    try {
      const url = `${relayUrl}${relayPath}`;
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
      console.error(`[Proxy] ${method} ${relayPath} failed:`, err.message);
      res.status(502).json({ error: 'Relay service unavailable' });
      return null;
    }
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
    await proxy(req, res, 'DELETE', `/api/projects/${req.params.id}`);
    refreshProjectCache();
  });

  // --- Sessions (proxy) ---
  app.get('/api/sessions', requireAuth, (req, res) => {
    proxy(req, res, 'GET', '/api/sessions');
  });
}

module.exports = registerRoutes;
