const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const TASKS_FILENAME = '.tasks.json';
const TASK_LOGS_DIR = 'task-logs';
const MAX_LOG_ENTRIES = 100;

class TaskScheduler extends EventEmitter {
  constructor(projects, dataDir) {
    super();
    this.projects = projects; // Map of projectId -> project
    this.dataDir = dataDir;
    this.logsDir = path.join(dataDir, TASK_LOGS_DIR);
    this.scheduledTasks = new Map(); // projectId:taskId -> { task, timeoutId, nextRun }
    this.watchers = new Map(); // projectId -> fs.FSWatcher
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Ensure logs directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Load tasks for all projects
    for (const [projectId, project] of this.projects) {
      this.loadProjectTasks(projectId, project.path);
      this.watchTasksFile(projectId, project.path);
    }

    console.log('[TaskScheduler] Started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;

    // Clear all scheduled timeouts
    for (const [key, scheduled] of this.scheduledTasks) {
      if (scheduled.timeoutId) {
        clearTimeout(scheduled.timeoutId);
      }
    }
    this.scheduledTasks.clear();

    // Close all file watchers
    for (const [projectId, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    console.log('[TaskScheduler] Stopped');
  }

  loadProjectTasks(projectId, projectPath) {
    const tasksFile = path.join(projectPath, TASKS_FILENAME);

    // Clear existing tasks for this project
    for (const [key] of this.scheduledTasks) {
      if (key.startsWith(`${projectId}:`)) {
        const scheduled = this.scheduledTasks.get(key);
        if (scheduled?.timeoutId) {
          clearTimeout(scheduled.timeoutId);
        }
        this.scheduledTasks.delete(key);
      }
    }

    if (!fs.existsSync(tasksFile)) {
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      const tasks = data.tasks || [];

      for (const task of tasks) {
        if (task.enabled !== false) {
          this.scheduleTask(projectId, task);
        }
      }

      console.log(`[TaskScheduler] Loaded ${tasks.length} tasks for project ${projectId}`);
      this.emit('tasks_updated', { projectId });
    } catch (err) {
      console.error(`[TaskScheduler] Failed to load tasks for project ${projectId}:`, err.message);
    }
  }

  watchTasksFile(projectId, projectPath) {
    // Close existing watcher if any
    if (this.watchers.has(projectId)) {
      this.watchers.get(projectId).close();
    }

    const tasksFile = path.join(projectPath, TASKS_FILENAME);
    const dir = projectPath;

    // Watch the directory for .tasks.json changes
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (filename === TASKS_FILENAME) {
          console.log(`[TaskScheduler] ${TASKS_FILENAME} changed for project ${projectId}`);
          // Debounce reloads
          if (this._reloadTimeout) {
            clearTimeout(this._reloadTimeout);
          }
          this._reloadTimeout = setTimeout(() => {
            this.loadProjectTasks(projectId, projectPath);
          }, 100);
        }
      });
      this.watchers.set(projectId, watcher);
    } catch (err) {
      console.error(`[TaskScheduler] Failed to watch ${dir}:`, err.message);
    }
  }

  scheduleTask(projectId, task) {
    const key = `${projectId}:${task.id}`;
    const nextRun = this.calculateNextRun(task.schedule);

    if (!nextRun) {
      console.error(`[TaskScheduler] Invalid schedule for task ${task.id}`);
      return;
    }

    const delay = nextRun.getTime() - Date.now();
    if (delay < 0) {
      // Next run is in the past, recalculate
      console.warn(`[TaskScheduler] Next run for ${task.id} is in the past, skipping to next interval`);
      return;
    }

    const timeoutId = setTimeout(() => {
      this.executeTask(projectId, task);
    }, delay);

    this.scheduledTasks.set(key, {
      task,
      projectId,
      timeoutId,
      nextRun
    });

    console.log(`[TaskScheduler] Scheduled ${task.name} for ${nextRun.toISOString()}`);
  }

  calculateNextRun(schedule) {
    if (!schedule || !schedule.type) return null;

    const now = new Date();

    switch (schedule.type) {
      case 'daily': {
        const [hours, minutes] = (schedule.time || '00:00').split(':').map(Number);
        const next = new Date(now);
        next.setHours(hours, minutes, 0, 0);
        if (next <= now) {
          next.setDate(next.getDate() + 1);
        }
        return next;
      }

      case 'hourly': {
        const minute = schedule.minute || 0;
        const next = new Date(now);
        next.setMinutes(minute, 0, 0);
        if (next <= now) {
          next.setHours(next.getHours() + 1);
        }
        return next;
      }

      case 'interval': {
        const minutes = schedule.minutes || 60;
        return new Date(now.getTime() + minutes * 60 * 1000);
      }

      case 'weekly': {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = days.indexOf((schedule.day || 'monday').toLowerCase());
        const [hours, minutes] = (schedule.time || '00:00').split(':').map(Number);

        const next = new Date(now);
        next.setHours(hours, minutes, 0, 0);

        const currentDay = now.getDay();
        let daysUntil = targetDay - currentDay;
        if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
          daysUntil += 7;
        }
        next.setDate(next.getDate() + daysUntil);
        return next;
      }

      case 'cron': {
        // Simple cron parser for common patterns
        // Format: minute hour day month weekday
        const expr = schedule.expression;
        if (!expr) return null;

        const parts = expr.split(/\s+/);
        if (parts.length !== 5) return null;

        const [cronMin, cronHour] = parts;
        const next = new Date(now);

        // Handle simple cases: specific minute and hour
        if (cronMin !== '*' && cronHour !== '*') {
          const minute = parseInt(cronMin);
          const hour = parseInt(cronHour);
          next.setHours(hour, minute, 0, 0);
          if (next <= now) {
            next.setDate(next.getDate() + 1);
          }
          return next;
        }

        // Handle hourly: specific minute, any hour
        if (cronMin !== '*' && cronHour === '*') {
          const minute = parseInt(cronMin);
          next.setMinutes(minute, 0, 0);
          if (next <= now) {
            next.setHours(next.getHours() + 1);
          }
          return next;
        }

        // Fallback: run in 1 hour
        return new Date(now.getTime() + 60 * 60 * 1000);
      }

      default:
        return null;
    }
  }

  async executeTask(projectId, task) {
    const key = `${projectId}:${task.id}`;
    const project = this.projects.get(projectId);

    if (!project) {
      console.error(`[TaskScheduler] Project ${projectId} not found`);
      return;
    }

    const execution = {
      taskId: task.id,
      taskName: task.name,
      projectId,
      projectName: project.name,
      startedAt: new Date().toISOString(),
      status: 'running'
    };

    console.log(`[TaskScheduler] Executing task: ${task.name}`);
    this.emit('task_started', execution);

    try {
      // Request execution from server via callback
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Task execution timeout'));
        }, 5 * 60 * 1000); // 5 minute timeout

        this.emit('run_task', {
          projectId,
          task,
          callback: (err, result) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(result);
          }
        });
      });

      execution.completedAt = new Date().toISOString();
      execution.status = 'success';
      execution.response = result.response;
      execution.stats = result.stats;

      console.log(`[TaskScheduler] Task completed: ${task.name}`);
      this.emit('task_completed', execution);
    } catch (err) {
      execution.completedAt = new Date().toISOString();
      execution.status = 'error';
      execution.error = err.message;

      console.error(`[TaskScheduler] Task failed: ${task.name}`, err.message);
      this.emit('task_failed', execution);
    }

    // Log execution
    this.logExecution(projectId, task.id, execution);

    // Reschedule for next run
    if (this.running) {
      const scheduled = this.scheduledTasks.get(key);
      if (scheduled && scheduled.task.enabled !== false) {
        this.scheduleTask(projectId, task);
      }
    }
  }

  logExecution(projectId, taskId, execution) {
    const logFile = path.join(this.logsDir, `${projectId}-${taskId}.json`);

    let logs = [];
    if (fs.existsSync(logFile)) {
      try {
        logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      } catch (err) {
        console.error(`[TaskScheduler] Failed to read log file:`, err.message);
      }
    }

    logs.unshift(execution);

    // Keep only last N entries
    if (logs.length > MAX_LOG_ENTRIES) {
      logs = logs.slice(0, MAX_LOG_ENTRIES);
    }

    try {
      fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
    } catch (err) {
      console.error(`[TaskScheduler] Failed to write log file:`, err.message);
    }
  }

  getScheduledTasks() {
    const tasks = [];
    for (const [key, scheduled] of this.scheduledTasks) {
      const project = this.projects.get(scheduled.projectId);
      tasks.push({
        id: scheduled.task.id,
        name: scheduled.task.name,
        prompt: scheduled.task.prompt,
        schedule: scheduled.task.schedule,
        enabled: scheduled.task.enabled !== false,
        projectId: scheduled.projectId,
        projectName: project?.name || 'Unknown',
        nextRun: scheduled.nextRun?.toISOString()
      });
    }
    return tasks;
  }

  getTaskHistory(projectId, taskId) {
    const logFile = path.join(this.logsDir, `${projectId}-${taskId}.json`);

    if (!fs.existsSync(logFile)) {
      return [];
    }

    try {
      return JSON.parse(fs.readFileSync(logFile, 'utf8'));
    } catch (err) {
      console.error(`[TaskScheduler] Failed to read log file:`, err.message);
      return [];
    }
  }

  getAllTasks() {
    const allTasks = [];

    for (const [projectId, project] of this.projects) {
      const tasksFile = path.join(project.path, TASKS_FILENAME);

      if (!fs.existsSync(tasksFile)) {
        continue;
      }

      try {
        const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        const tasks = data.tasks || [];

        for (const task of tasks) {
          const key = `${projectId}:${task.id}`;
          const scheduled = this.scheduledTasks.get(key);

          allTasks.push({
            id: task.id,
            name: task.name,
            prompt: task.prompt,
            schedule: task.schedule,
            enabled: task.enabled !== false,
            model: task.model,
            createdAt: task.createdAt,
            projectId,
            projectName: project.name,
            nextRun: scheduled?.nextRun?.toISOString() || null
          });
        }
      } catch (err) {
        console.error(`[TaskScheduler] Failed to read tasks for ${projectId}:`, err.message);
      }
    }

    return allTasks;
  }

  updateTask(projectId, taskId, updates) {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const tasksFile = path.join(project.path, TASKS_FILENAME);
    if (!fs.existsSync(tasksFile)) {
      throw new Error('No tasks file found');
    }

    const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const taskIndex = data.tasks.findIndex(t => t.id === taskId);

    if (taskIndex === -1) {
      throw new Error('Task not found');
    }

    // Apply updates
    data.tasks[taskIndex] = { ...data.tasks[taskIndex], ...updates };

    fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2));

    // File watcher will reload tasks
    return data.tasks[taskIndex];
  }

  runTaskNow(projectId, taskId) {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const tasksFile = path.join(project.path, TASKS_FILENAME);
    if (!fs.existsSync(tasksFile)) {
      throw new Error('No tasks file found');
    }

    const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const task = data.tasks.find(t => t.id === taskId);

    if (!task) {
      throw new Error('Task not found');
    }

    // Execute immediately
    this.executeTask(projectId, task);
  }

  // Called when a new project is added
  addProject(projectId, project) {
    this.loadProjectTasks(projectId, project.path);
    this.watchTasksFile(projectId, project.path);
  }

  // Called when a project is removed
  removeProject(projectId) {
    // Clear scheduled tasks for this project
    for (const [key] of this.scheduledTasks) {
      if (key.startsWith(`${projectId}:`)) {
        const scheduled = this.scheduledTasks.get(key);
        if (scheduled?.timeoutId) {
          clearTimeout(scheduled.timeoutId);
        }
        this.scheduledTasks.delete(key);
      }
    }

    // Close file watcher
    if (this.watchers.has(projectId)) {
      this.watchers.get(projectId).close();
      this.watchers.delete(projectId);
    }
  }
}

module.exports = TaskScheduler;
