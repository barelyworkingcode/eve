/**
 * relayScheduler emits a `view` envelope on every task and every task
 * lifecycle broadcast: { kind: "interactive" | "readonly", runId, hasLastRun }.
 * readonly opens via the terminal manager, which attaches live over WS when
 * the relayLLM session is resident, or replays the disk log file.
 *
 * Eve callsites MUST go through this module — never read task.view.kind or
 * hand off a runId directly.
 */
class TaskViewer {
  constructor(container) {
    this.container = container;
  }

  hasLastRun(task) {
    return !!task?.view?.hasLastRun;
  }

  openLastRun(task) {
    const view = task?.view;
    if (!view?.hasLastRun) return;
    this._dispatch(task, view.kind, view.runId);
  }

  openLiveRun(task, broadcastView) {
    if (!broadcastView?.runId) return;
    this._dispatch(task, broadcastView.kind, broadcastView.runId);
  }

  _dispatch(task, kind, runId) {
    const renderer = this._renderers[kind];
    if (!renderer) {
      this.container.get('logger')?.child('TaskViewer')
        .warn('unknown view kind', kind);
      return;
    }
    renderer(this.container, task, runId);
  }

  _renderers = {
    // _task is intentionally unused — joinSession only needs the runId,
    // but the signature stays symmetric with readonly for callers' sake.
    interactive: (container, _task, runId) => {
      container.get('app').joinSession(runId);
    },
    readonly: (container, task, runId) => {
      const tm = container.get('terminalManager');
      if (!tm) return;
      const project = container.get('state').getProject(task.projectId);
      const directory = task.directory || project?.path || '';
      tm.openTaskTerminal(runId, {
        templateId: task.templateId || '',
        name: task.name || 'Task',
        directory,
      });
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TaskViewer;
}
