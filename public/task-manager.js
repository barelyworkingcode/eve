/**
 * TaskManager - CRUD client for relayScheduler tasks.
 * Task lifecycle events (started/completed/error) arrive via WebSocket push.
 */
class TaskManager {
  constructor(app) {
    this.app = app;
    this.tasks = new Map();
    this.userTriggeredRuns = new Set();
  }

  async loadTasks(projectId) {
    try {
      const qs = projectId ? `?projectId=${projectId}` : '';
      const response = await fetch(`/api/tasks${qs}`, { headers: this.app.getAuthHeaders() });
      const tasks = await response.json();
      if (!Array.isArray(tasks)) return;
      // If loading for a specific project, only clear that project's tasks
      if (projectId) {
        for (const [id, t] of this.tasks) {
          if (t.projectId === projectId) this.tasks.delete(id);
        }
      } else {
        this.tasks.clear();
      }
      for (const task of tasks) {
        this.tasks.set(task.id, task);
      }
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  }

  async createTask(data) {
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.app.getAuthHeaders() },
        body: JSON.stringify(data)
      });
      const task = await response.json();
      if (task && task.id) {
        this.tasks.set(task.id, task);
      }
      return task;
    } catch (err) {
      console.error('Failed to create task:', err);
      return null;
    }
  }

  async updateTask(id, data) {
    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.app.getAuthHeaders() },
        body: JSON.stringify(data)
      });
      const task = await response.json();
      if (task && task.id) {
        this.tasks.set(task.id, task);
      }
      return task;
    } catch (err) {
      console.error('Failed to update task:', err);
      return null;
    }
  }

  async deleteTask(id) {
    try {
      await fetch(`/api/tasks/${id}`, {
        method: 'DELETE',
        headers: this.app.getAuthHeaders()
      });
      this.tasks.delete(id);
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }

  async deleteByProject(projectId) {
    try {
      await fetch(`/api/tasks/by-project/${projectId}`, {
        method: 'DELETE',
        headers: this.app.getAuthHeaders()
      });
      for (const [id, t] of this.tasks) {
        if (t.projectId === projectId) this.tasks.delete(id);
      }
    } catch (err) {
      console.error('Failed to delete tasks by project:', err);
    }
  }

  async runTask(id) {
    try {
      await fetch(`/api/tasks/${id}/run`, {
        method: 'POST',
        headers: this.app.getAuthHeaders()
      });
    } catch (err) {
      console.error('Failed to run task:', err);
    }
  }

  /**
   * Handle a task lifecycle event from the scheduler WebSocket.
   * Updates local task state based on event type.
   */
  handleTaskEvent(data) {
    const task = this.tasks.get(data.taskId);
    if (!task) return;

    switch (data.type) {
      case 'task_started':
        task.lastStatus = 'running';
        if (data.sessionId) task.lastSessionId = data.sessionId;
        break;
      case 'task_completed':
        task.lastStatus = data.status || 'success';
        if (data.sessionId) task.lastSessionId = data.sessionId;
        break;
      case 'task_error':
        task.lastStatus = 'error';
        break;
    }
  }

  /**
   * Handle the task_status snapshot sent on WebSocket connect.
   * Marks matching local tasks as running.
   */
  handleTaskStatus(data) {
    if (!Array.isArray(data.running)) return;
    for (const item of data.running) {
      const task = this.tasks.get(item.taskId);
      if (task) {
        task.lastStatus = 'running';
        if (item.sessionId) task.lastSessionId = item.sessionId;
      }
    }
  }

  getTaskSessionIds() {
    const ids = new Set();
    for (const [, task] of this.tasks) {
      if (task.lastSessionId) ids.add(task.lastSessionId);
    }
    return ids;
  }

  getTasksForProject(projectId) {
    const result = [];
    for (const [, task] of this.tasks) {
      if (task.projectId === projectId) result.push(task);
    }
    return result;
  }

  formatSchedule(schedule) {
    if (!schedule) return '';
    let s = schedule;
    if (typeof s === 'string') {
      try { s = JSON.parse(s); } catch { return ''; }
    }
    switch (s.type) {
      case 'daily': return `Daily at ${s.time || '?'}`;
      case 'hourly': return `Hourly at :${String(s.minute ?? 0).padStart(2, '0')}`;
      case 'interval': return `Every ${s.minutes || '?'}m`;
      case 'weekly': return `Weekly ${s.day || '?'} at ${s.time || '?'}`;
      case 'cron': return `Cron: ${s.expression || '?'}`;
      case 'once': return `Once at ${s.at || '?'}`;
      case 'on_demand': return 'On demand';
      default: return s.type || '?';
    }
  }
}
