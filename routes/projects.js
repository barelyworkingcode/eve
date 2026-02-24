const express = require('express');
const { v4: uuidv4 } = require('uuid');

function validateAllowedTools(allowedTools) {
  if (allowedTools === undefined || allowedTools === null) return [];
  if (!Array.isArray(allowedTools)) return null;
  for (const t of allowedTools) {
    if (typeof t !== 'string' || !t.trim()) return null;
  }
  return allowedTools.map(t => t.trim());
}

function createProjectRoutes({ projects, saveProjects, getAllModels, getProviderForModel, settings, requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const projectsList = Array.from(projects.values()).map(project => {
      const provider = getProviderForModel(project.model);
      const disabled = !settings.providers[provider];
      return { ...project, disabled };
    });
    res.json(projectsList);
  });

  router.post('/', requireAuth, (req, res) => {
    const { name, path: projectPath, model, allowedTools } = req.body;
    if (!name || !projectPath) {
      return res.status(400).json({ error: 'Name and path are required' });
    }

    const validatedTools = validateAllowedTools(allowedTools);
    if (validatedTools === null) {
      return res.status(400).json({ error: 'allowedTools must be an array of non-empty strings' });
    }

    const validModels = getAllModels().map(m => m.value);
    const project = {
      id: uuidv4(),
      name,
      path: projectPath,
      model: validModels.includes(model) ? model : 'haiku',
      allowedTools: validatedTools,
      createdAt: new Date().toISOString()
    };

    projects.set(project.id, project);
    saveProjects();
    res.json(project);
  });

  router.put('/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const project = projects.get(id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { name, path: projectPath, model, allowedTools } = req.body;

    if (name !== undefined) {
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Name must be a non-empty string' });
      }
      project.name = name.trim();
    }

    if (projectPath !== undefined) {
      if (!projectPath || typeof projectPath !== 'string') {
        return res.status(400).json({ error: 'Path must be a non-empty string' });
      }
      project.path = projectPath.trim();
    }

    if (model !== undefined) {
      const validModels = getAllModels().map(m => m.value);
      project.model = validModels.includes(model) ? model : project.model;
    }

    if (allowedTools !== undefined) {
      const validatedTools = validateAllowedTools(allowedTools);
      if (validatedTools === null) {
        return res.status(400).json({ error: 'allowedTools must be an array of non-empty strings' });
      }
      project.allowedTools = validatedTools;
    }

    projects.set(id, project);
    saveProjects();
    res.json(project);
  });

  router.delete('/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    if (!projects.has(id)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    projects.delete(id);
    saveProjects();
    res.json({ success: true });
  });

  return router;
}

module.exports = createProjectRoutes;
