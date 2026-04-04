/**
 * TaskManager - CRUD client for relayScheduler tasks.
 * All storage is delegated to StateStore. All HTTP goes through ApiClient.
 * Task lifecycle events (started/completed/error) are handled by MessageDispatcher.
 */
class TaskManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.api = container.get('api');
    this.state = container.get('state');
    this.log = container.get('logger').child('TaskManager');
    this.userTriggeredRuns = new Set();
  }

  async loadTasks(projectId) {
    try {
      const tasks = await this.api.getTasks(projectId);
      if (!Array.isArray(tasks)) return;
      if (projectId) {
        // Merge: remove this project's old tasks, add fresh ones
        for (const [id, t] of this.state.tasks) {
          if (t.projectId === projectId) this.state.removeTask(id);
        }
        for (const t of tasks) this.state.addTask(t);
      } else {
        this.state.setTasks(tasks);
      }
    } catch (err) {
      this.log.error('Failed to load tasks:', err);
    }
  }

  async createTask(data) {
    try {
      const task = await this.api.createTask(data);
      if (task?.id) this.state.addTask(task);
      return task;
    } catch (err) {
      this.log.error('Failed to create task:', err);
      return null;
    }
  }

  async updateTask(id, data) {
    try {
      const task = await this.api.updateTask(id, data);
      if (task?.id) this.state.addTask(task);
      return task;
    } catch (err) {
      this.log.error('Failed to update task:', err);
      return null;
    }
  }

  async deleteTask(id) {
    try {
      await this.api.deleteTask(id);
      this.state.removeTask(id);
    } catch (err) {
      this.log.error('Failed to delete task:', err);
    }
  }

  async deleteByProject(projectId) {
    try {
      await this.api.deleteTasksByProject(projectId);
      for (const [id, t] of this.state.tasks) {
        if (t.projectId === projectId) this.state.removeTask(id);
      }
    } catch (err) {
      this.log.error('Failed to delete tasks by project:', err);
    }
  }

  async runTask(id) {
    try {
      await this.api.runTask(id);
    } catch (err) {
      this.log.error('Failed to run task:', err);
    }
  }

  async loadHistory(taskId) {
    try {
      return await this.api.getTaskHistory(taskId);
    } catch (err) {
      this.log.error('Failed to load task history:', err);
      return [];
    }
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
