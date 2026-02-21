const { v4: uuidv4 } = require('uuid');

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket?.remoteAddress ||
         'unknown';
}

function registerRoutes(app, { authService, projects, sessions, taskScheduler, saveProjects, getAllModels, getProviderForModel, settings }) {
  // Auth middleware for protected routes
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

  // Auth routes (unauthenticated)
  app.get('/api/auth/status', (req, res) => {
    if (authService.isLocalhost(req)) {
      return res.json({ enrolled: false, authenticated: true, localhost: true });
    }
    const enrolled = authService.isEnrolled();
    const token = req.headers['x-session-token'];
    const authenticated = enrolled && authService.validateSession(token);
    res.json({ enrolled, authenticated });
  });

  app.post('/api/auth/enroll/start', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!authService.checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      if (authService.isEnrolled()) {
        return res.status(400).json({ error: 'Already enrolled' });
      }
      const { options, challengeId } = await authService.generateEnrollmentOptions(req);
      console.log('[Auth] Enrollment started - rpId:', options.rp.id, 'origin:', authService.getOrigin(req));
      res.json({ options, challengeId });
    } catch (err) {
      console.error('Enrollment start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/enroll/finish', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!authService.checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      if (authService.isEnrolled()) {
        return res.status(400).json({ error: 'Already enrolled' });
      }
      const { response, challengeId } = req.body;
      if (!response || typeof response !== 'object' || !challengeId || typeof challengeId !== 'string') {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      console.log('[Auth] Enrollment finish - credential.id from client:', response.id);
      console.log('[Auth] Enrollment finish - credential.rawId from client:', response.rawId);
      const token = await authService.verifyEnrollment(req, response, challengeId);
      res.json({ token });
    } catch (err) {
      console.error('Enrollment finish failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/auth/login/start', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!authService.checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      if (!authService.isEnrolled()) {
        return res.status(400).json({ error: 'Not enrolled' });
      }
      const { options, challengeId } = await authService.generateLoginOptions(req);
      console.log('[Auth] Login started - rpId:', options.rpId, 'origin:', authService.getOrigin(req));
      console.log('[Auth] Stored credential rpId from auth.json:', authService.loadCredentials()?.rpId || '(not stored)');
      console.log('[Auth] allowCredentials:', JSON.stringify(options.allowCredentials));
      res.json({ options, challengeId });
    } catch (err) {
      console.error('Login start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login/finish', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!authService.checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      if (!authService.isEnrolled()) {
        return res.status(400).json({ error: 'Not enrolled' });
      }
      const { response, challengeId } = req.body;
      if (!response || typeof response !== 'object' || !challengeId || typeof challengeId !== 'string') {
        return res.status(400).json({ error: 'Invalid request body' });
      }
      const token = await authService.verifyLogin(req, response, challengeId);
      res.json({ token });
    } catch (err) {
      console.error('Login finish failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // API to list all models
  app.get('/api/models', requireAuth, (req, res) => {
    res.json(getAllModels());
  });

  // API to list all projects
  app.get('/api/projects', requireAuth, (req, res) => {
    const projectsList = Array.from(projects.values()).map(project => {
      const provider = getProviderForModel(project.model);
      const disabled = !settings.providers[provider];
      return { ...project, disabled };
    });
    res.json(projectsList);
  });

  // API to create a project
  app.post('/api/projects', requireAuth, (req, res) => {
    const { name, path: projectPath, model } = req.body;
    if (!name || !projectPath) {
      return res.status(400).json({ error: 'Name and path are required' });
    }

    const validModels = getAllModels().map(m => m.value);
    const project = {
      id: uuidv4(),
      name,
      path: projectPath,
      model: validModels.includes(model) ? model : 'haiku',
      createdAt: new Date().toISOString()
    };

    projects.set(project.id, project);
    saveProjects();
    res.json(project);
  });

  // API to delete a project
  app.delete('/api/projects/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    if (!projects.has(id)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    projects.delete(id);
    saveProjects();
    res.json({ success: true });
  });

  // API to list active sessions
  app.get('/api/sessions', requireAuth, (req, res) => {
    const sessionList = [];
    for (const [id, session] of sessions) {
      sessionList.push({
        id,
        directory: session.directory,
        projectId: session.projectId || null,
        name: session.name || null,
        active: session.provider !== null
      });
    }
    res.json(sessionList);
  });

  // API to list all scheduled tasks
  app.get('/api/tasks', requireAuth, (req, res) => {
    res.json(taskScheduler.getAllTasks());
  });

  // API to get task execution history
  app.get('/api/tasks/:projectId/:taskId/history', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    const history = taskScheduler.getTaskHistory(projectId, taskId);
    res.json(history);
  });

  // API to manually run a task
  app.post('/api/tasks/:projectId/:taskId/run', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    try {
      taskScheduler.runTaskNow(projectId, taskId);
      res.json({ success: true, message: 'Task execution started' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // API to create a task
  app.post('/api/tasks/:projectId', requireAuth, (req, res) => {
    const { projectId } = req.params;
    const { name, prompt, schedule, model, args, enabled } = req.body;

    if (!name || !prompt || !schedule) {
      return res.status(400).json({ error: 'name, prompt, and schedule are required' });
    }

    const validTypes = ['daily', 'hourly', 'interval', 'weekly', 'cron'];
    if (!schedule.type || !validTypes.includes(schedule.type)) {
      return res.status(400).json({ error: `schedule.type must be one of: ${validTypes.join(', ')}` });
    }

    if (args !== undefined && !Array.isArray(args)) {
      return res.status(400).json({ error: 'args must be an array' });
    }

    try {
      const task = taskScheduler.createTask(projectId, { name, prompt, schedule, model, args, enabled });
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // API to delete a task
  app.delete('/api/tasks/:projectId/:taskId', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    try {
      taskScheduler.deleteTask(projectId, taskId);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // API to update a task (enable/disable)
  app.put('/api/tasks/:projectId/:taskId', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    const updates = req.body;
    try {
      const task = taskScheduler.updateTask(projectId, taskId, updates);
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = registerRoutes;
