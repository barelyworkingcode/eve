/**
 * TaskViewer — central dispatcher for "show me a task's run output".
 *
 * The relayScheduler emits a `view` envelope on every task and every task
 * lifecycle broadcast:
 *
 *   { kind: "interactive" | "readonly", runId: string, hasLastRun: bool }
 *
 *   - interactive → resumable LLM chat session. Opens via app.joinSession.
 *   - readonly    → captured PTY byte stream. Opens via the terminal
 *                   manager, which attaches live over WS when the relayLLM
 *                   session is resident, or replays the disk log file.
 *
 * Eve callsites (sidebar click, dialog "View Last Run", dispatcher auto-
 * attach) MUST go through this module — they should never read task.view.kind
 * or hand off a runId directly. Adding a new task type means adding one
 * entry to the _renderers table.
 */
class TaskViewer {
  constructor(container) {
    this.container = container;
  }

  /** True when there's a saved run to open. */
  hasLastRun(task) {
    return !!task?.view?.hasLastRun;
  }

  /** Open the saved last run of a task. No-op if the task has never run. */
  openLastRun(task) {
    const view = task?.view;
    if (!view?.hasLastRun) return;
    this._dispatch(task, view.kind, view.runId);
  }

  /**
   * Open the freshly-started run from a task_started broadcast. The
   * broadcastView is the {kind, runId} envelope sent by the scheduler.
   * Called by the message dispatcher when a user-triggered run begins.
   */
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

  // Dispatch table. Keep it tiny — anything more than "look up the right
  // viewer and hand it the runId" belongs in the renderer itself.
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
