const createAuthRoutes = require('./auth');
const createProjectRoutes = require('./projects');
const createSessionRoutes = require('./sessions');
const createTaskRoutes = require('./tasks');
const createPermissionRoutes = require('./permissions');
const LMStudioProvider = require('../providers/lmstudio-provider');

function registerRoutes(app, { authService, projects, sessions, sessionManager, taskScheduler, saveProjects, getAllModels, getProviderForModel, settings }) {
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

  // Auth routes (no auth middleware needed)
  app.use('/api', createAuthRoutes(authService));

  // Models endpoint
  app.get('/api/models', requireAuth, (req, res) => {
    res.json(getAllModels());
  });

  // Refresh models (re-fetch from LM Studio)
  app.post('/api/models/refresh', requireAuth, async (req, res) => {
    await LMStudioProvider.fetchModels();
    res.json(getAllModels());
  });

  // Domain-specific routes
  app.use('/api/projects', createProjectRoutes({ projects, saveProjects, getAllModels, getProviderForModel, settings, requireAuth }));
  app.use('/api/sessions', createSessionRoutes({ sessions, projects, sessionManager, requireAuth }));
  app.use('/api/tasks', createTaskRoutes({ taskScheduler, requireAuth }));

  const { router: permissionRouter, resolvePermission, setAlwaysAllow } = createPermissionRoutes({ sessions, requireAuth });
  app.use('/api/permission', permissionRouter);

  return { resolvePermission, setAlwaysAllow };
}

module.exports = registerRoutes;
