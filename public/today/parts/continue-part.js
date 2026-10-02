/** Recent threads. Waits for tasks as well as sessions: a task run is a headless session and is only recognisable once tasks are known. */
class ContinuePart extends TodayPart {
  constructor() {
    super();
    this.id = 'continue';
    this.modes = ['home', 'work'];
    this.order = 40;
    this.title = 'Continue';
    this.sources = ['sessions', 'tasks'];
    this.events = [
      EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.SESSION_CREATED, EVT.SESSION_RENAMED, EVT.SESSION_ACTIVITY,
      EVT.PROJECTS_LOADED, EVT.PROJECT_RENAMED, EVT.PROJECT_DELETED, EVT.TASKS_LOADED, EVT.MODE_CHANGED,
    ];
  }

  render(root) {
    const { state, container } = this.ctx;
    if (state.projects.size === 0) return;
    root.appendChild(todayEyebrow('Continue', '', { kbd: '⌘K', hint: 'jump anywhere' }));
    const recent = this._recent();
    if (recent.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'home__empty';
      empty.textContent = 'Nothing yet. Start a session above and it will show up here.';
      root.appendChild(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'home__list';
    for (const { session, openedAt } of recent) {
      const project = state.getProject(session.projectId);
      const model = session.model ? session.model.split('/').pop() : '';
      const status = this.ctx.activity.statusOf(session.id);
      list.appendChild(todayRow(state, {
        testid: `home-session-${session.id}`,
        project, projectId: session.projectId,
        title: sessionDisplayName(session, project) || session.id,
        sub: [project?.name, model].filter(Boolean).join(' · '),
        status: status === 'idle' ? null : status,
        time: openedAt,
        onClick: () => container.get('app')?.joinSession?.(session.id),
      }));
    }
    root.appendChild(list);
  }

  /** Newest first by the later of this browser's last open and the server's last message. */
  _recent() {
    const { state } = this.ctx;
    const recents = (typeof SessionRecents !== 'undefined') ? SessionRecents.list() : [];
    const opened = new Map(recents.map(r => [r.id, Number(r.lastOpenedAt) || Date.parse(r.lastOpenedAt || '') || 0]));
    const time = (s) => {
      const t = Date.parse(s.lastMessageAt || s.createdAt || '');
      return Math.max(opened.get(s.id) || 0, Number.isNaN(t) ? 0 : t);
    };
    return todayThreads(state)
      .map(s => ({ session: s, openedAt: time(s) }))
      .filter(r => r.openedAt > 0)
      .sort((x, y) => y.openedAt - x.openedAt)
      .slice(0, ContinuePart.MAX_RECENT);
  }
}
ContinuePart.MAX_RECENT = 6;
