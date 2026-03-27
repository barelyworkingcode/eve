/**
 * TaskManager - CRUD client for relayScheduler tasks.
 * Task lifecycle events (started/completed/error) arrive via WebSocket push.
 */
class TaskManager {
  constructor(app) {
    this.app = app;
    this.tasks = new Map();
    this.userTriggeredRuns = new Set();
    this.taskSessionIds = new Set();
  }

  async loadTasks(projectId) {
    try {
      const qs = projectId ? `?projectId=${projectId}` : '';
      const response = await fetch(`/api/tasks${qs}`, { headers: this.app.getAuthHeaders() });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
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
        if (task.lastSessionId) this.taskSessionIds.add(task.lastSessionId);
      }
    } catch (err) {
      console.error('Failed to load tasks:', err);
      this.app.messageRenderer.appendSystemMessage('Failed to load tasks');
    }
  }

  async createTask(data) {
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.app.getAuthHeaders() },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const task = await response.json();
      if (task && task.id) {
        this.tasks.set(task.id, task);
      }
      return task;
    } catch (err) {
      console.error('Failed to create task:', err);
      this.app.messageRenderer.appendSystemMessage('Failed to create task');
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
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const task = await response.json();
      if (task && task.id) {
        this.tasks.set(task.id, task);
      }
      return task;
    } catch (err) {
      console.error('Failed to update task:', err);
      this.app.messageRenderer.appendSystemMessage('Failed to update task');
      return null;
    }
  }

  async deleteTask(id) {
    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: 'DELETE',
        headers: this.app.getAuthHeaders()
      });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      this.tasks.delete(id);
    } catch (err) {
      console.error('Failed to delete task:', err);
      this.app.messageRenderer.appendSystemMessage('Failed to delete task');
    }
  }

  async deleteByProject(projectId) {
    try {
      const response = await fetch(`/api/tasks/by-project/${projectId}`, {
        method: 'DELETE',
        headers: this.app.getAuthHeaders()
      });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      for (const [id, t] of this.tasks) {
        if (t.projectId === projectId) this.tasks.delete(id);
      }
    } catch (err) {
      console.error('Failed to delete tasks by project:', err);
    }
  }

  async runTask(id) {
    try {
      const response = await fetch(`/api/tasks/${id}/run`, {
        method: 'POST',
        headers: this.app.getAuthHeaders()
      });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
    } catch (err) {
      console.error('Failed to run task:', err);
      this.app.messageRenderer.appendSystemMessage('Failed to run task');
    }
  }

  async loadHistory(taskId) {
    try {
      const response = await fetch(`/api/tasks/${taskId}/history`, { headers: this.app.getAuthHeaders() });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      return await response.json();
    } catch (err) {
      console.error('Failed to load task history:', err);
      return [];
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
        if (data.sessionId) {
          this.taskSessionIds.add(data.sessionId);
          task.lastSessionId = data.sessionId;
        }
        break;
      case 'task_completed':
        task.lastStatus = data.status || 'success';
        if (data.sessionId) {
          this.taskSessionIds.add(data.sessionId);
          task.lastSessionId = data.sessionId;
        }
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
        if (item.sessionId) {
          this.taskSessionIds.add(item.sessionId);
          task.lastSessionId = item.sessionId;
        }
      }
    }
  }

  getTaskSessionIds() {
    return this.taskSessionIds;
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
