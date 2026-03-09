const express = require('express');

function createTaskRoutes({ taskScheduler, requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    res.json(taskScheduler.getAllTasks());
  });

  router.get('/:projectId/:taskId/history', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    const history = taskScheduler.getTaskHistory(projectId, taskId);
    res.json(history);
  });

  router.post('/:projectId/:taskId/run', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    try {
      taskScheduler.runTaskNow(projectId, taskId);
      res.json({ success: true, message: 'Task execution started' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:projectId', requireAuth, (req, res) => {
    const { projectId } = req.params;
    const { name, prompt, schedule, model, args, enabled } = req.body;

    if (!name || !prompt) {
      return res.status(400).json({ error: 'name and prompt are required' });
    }

    if (schedule) {
      const validTypes = ['daily', 'hourly', 'interval', 'weekly', 'cron'];
      if (!schedule.type || !validTypes.includes(schedule.type)) {
        return res.status(400).json({ error: `schedule.type must be one of: ${validTypes.join(', ')}` });
      }
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

  router.delete('/:projectId/:taskId', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    try {
      taskScheduler.deleteTask(projectId, taskId);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/:projectId/:taskId', requireAuth, (req, res) => {
    const { projectId, taskId } = req.params;
    const updates = req.body;
    try {
      const task = taskScheduler.updateTask(projectId, taskId, updates);
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createTaskRoutes;
