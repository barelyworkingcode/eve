/** Greeting and one summary line. Always shown; a failed source is said in the line. */
class SummaryPart extends TodayPart {
  constructor() {
    super();
    this.id = 'summary';
    this.modes = ['home', 'work'];
    this.order = 0;
    this.title = 'the summary';
    this.sources = ['projects', 'sessions'];
    this.events = [
      EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.SESSION_CREATED, EVT.SESSION_RENAMED,
      EVT.SESSION_ACTIVITY, EVT.PROJECTS_LOADED, EVT.PROJECT_DELETED, EVT.MODE_CHANGED, EVT.TASKS_LOADED,
    ];
  }

  // Unlike other parts the greeting never gives way to a skeleton or an error.
  paint() {
    if (!this.el) return;
    const { state, sources, activity } = this.ctx;
    this.el.dataset.state = 'ready';
    this.el.textContent = '';
    const header = document.createElement('div');
    header.className = 'home__header';
    const h1 = document.createElement('h1');
    h1.className = 'home__greeting';
    h1.textContent = SummaryPart.greeting(new Date());
    const sub = document.createElement('p');
    sub.className = 'home__subtitle';
    const failed = [sources.projects, sources.sessions].find(s => s.status === 'error');
    const parts = [];
    if (failed) {
      parts.push(failed.describe().replace(/\.$/, ''));
    } else {
      const threads = todayThreads(state);
      const running = threads.filter(s => activity.statusOf(s.id) === 'running').length;
      if (running > 0) parts.push(`${running} session${running === 1 ? '' : 's'} running`);
      else if (threads.length > 0) parts.push('Nothing running');
      const projects = state.getModeProjects();
      if (projects.length > 0) parts.push(`${projects.length} project${projects.length === 1 ? '' : 's'}`);
    }
    parts.push(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    sub.textContent = parts.join(' · ');
    header.appendChild(h1);
    header.appendChild(sub);
    this.el.appendChild(header);
  }

  static greeting(date) {
    const h = date.getHours();
    if (h < 5) return 'Working late.';
    if (h < 12) return 'Good morning.';
    if (h < 17) return 'Good afternoon.';
    if (h < 22) return 'Good evening.';
    return 'Working late.';
  }
}
