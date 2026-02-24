const express = require('express');
const ResponseCollector = require('../response-collector');

function createSessionRoutes({ sessions, projects, sessionManager, requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
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

  router.post('/', requireAuth, (req, res) => {
    const { projectId, name } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const project = projects.get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const mockWs = { readyState: 1, send: () => {} };
    const sessionId = sessionManager.createSession(mockWs, project.path, projectId);
    const session = sessions.get(sessionId);

    if (name) {
      session.name = name.trim().slice(0, 100);
      sessionManager.sessionStore.save(session);
    }

    res.json({ sessionId, projectId, model: session.model });
  });

  router.post('/:sessionId/message', requireAuth, async (req, res) => {
    const { sessionId } = req.params;
    const { text, files } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    let session = sessions.get(sessionId);

    // Try loading from disk if not in memory
    if (!session) {
      const saved = sessionManager.sessionStore.load(sessionId);
      if (saved) {
        session = {
          ...saved,
          ws: null,
          provider: null,
          processing: false,
          saveHistory: null
        };
        session.saveHistory = () => sessionManager.sessionStore.save(session);
        sessions.set(sessionId, session);
      }
    }

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.processing) {
      return res.status(409).json({ error: 'Session is busy processing another message' });
    }

    // Reinitialize provider if dead
    if (!session.provider) {
      sessionManager.ensureHookConfig(session.directory);
      const project = projects.get(session.projectId);
      const extraArgs = [];
      if (project?.allowedTools?.length > 0) {
        extraArgs.push('--allowedTools', ...project.allowedTools);
      }
      sessionManager.initProvider(session, extraArgs);
    }

    const collector = new ResponseCollector(session);
    collector.install((err, result) => {
      if (err) {
        const status = err.message.includes('timeout') ? 504 : 500;
        res.status(status).json({ error: err.message });
      } else {
        res.json({ response: result.response, stats: result.stats });
      }
    });

    sessionManager.sendMessage(sessionId, text, files || []);
  });

  return router;
}

module.exports = createSessionRoutes;
