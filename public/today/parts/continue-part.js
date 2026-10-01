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

  _recent() {
    const { state } = this.ctx;
    const recents = (typeof SessionRecents !== 'undefined') ? SessionRecents.list() : [];
    const byId = new Map(todayThreads(state).map(s => [s.id, s]));
    const ordered = [];
    const seen = new Set();
    const push = (s, ts) => {
      if (!s || seen.has(s.id)) return;
      seen.add(s.id);
      ordered.push({ session: s, openedAt: ts || null });
    };
    const serverTime = (s) => {
      const t = Date.parse(s.lastMessageAt || s.createdAt || '');
      return Number.isNaN(t) ? 0 : t;
    };
    for (const r of recents) push(byId.get(r.id), r.lastOpenedAt);
    for (const s of byId.values()) if (s.active) push(s, serverTime(s) || null);
    // Sessions this browser never opened, newest server activity first.
    const rest = [...byId.values()].filter(s => !seen.has(s.id) && serverTime(s) > 0)
      .sort((a, b) => serverTime(b) - serverTime(a));
    for (const s of rest) push(s, serverTime(s));
    return ordered.slice(0, ContinuePart.MAX_RECENT);
  }
}
ContinuePart.MAX_RECENT = 6;
