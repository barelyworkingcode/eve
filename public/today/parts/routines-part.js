/** Routines that finished in the last 24 h, newest first. Failed ones also stay in Needs you. */
class RoutinesPart extends TodayPart {
  static SEEN_KEY = 'eve-routines-seen';
  static WINDOW_MS = 24 * 60 * 60 * 1000;
  static MAX = 10;

  constructor() {
    super();
    this.id = 'routines';
    this.modes = ['home', 'work'];
    this.order = 25;
    this.title = 'Routines';
    this.sources = ['tasks'];
    this.events = [EVT.TASKS_LOADED, EVT.TASK_UPDATED, EVT.PROJECTS_LOADED, EVT.MODE_CHANGED];
    this._history = null;
  }

  _readSeen() {
    try {
      const v = JSON.parse(localStorage.getItem(RoutinesPart.SEEN_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }

  _writeSeen(seen) {
    try { localStorage.setItem(RoutinesPart.SEEN_KEY, JSON.stringify(seen)); } catch {}
  }

  _recent(now) {
    const out = [];
    for (const t of this.ctx.state.tasks.values()) {
      if (t.lastStatus !== 'success' && t.lastStatus !== 'error' && t.lastStatus !== 'timeout') continue;
      if (!this.ctx.state.isSessionInMode({ projectId: t.projectId })) continue;
      if (typeof Brief !== 'undefined' && Brief.isBrief(t)) continue; // the brief has its own card
      if (typeof CustomOutput !== 'undefined' && CustomOutput.isPartTask(t)) continue; // a custom card has its own
      const at = Date.parse(t.lastRun);
      if (!Number.isFinite(at) || now - at > RoutinesPart.WINDOW_MS || at > now + 60000) continue;
      out.push({ task: t, at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  _exec(task) {
    if (!this._history) {
      const tm = this.ctx.container.has('taskManager') ? this.ctx.container.get('taskManager') : null;
      this._history = new RoutineHistory({
        load: id => (tm ? tm.loadHistory(id) : Promise.resolve([])),
        onChange: () => this.paint(),
        limit: RoutinesPart.MAX,
      });
    }
    return this._history.newest(task);
  }

  _line(task, exec, now) {
    const hhmm = new Date(task.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    if (task.lastStatus === 'success') {
      const first = RoutineSentence.firstLine(exec?.response, 120);
      return [hhmm, 'ok', first].filter(Boolean).join(' · ');
    }
    const res = RoutineSentence.result({ ...task, enabled: true }, exec, new Date(now)).text;
    const reason = res.includes(' · ') ? res.slice(res.indexOf(' · ') + 3) : '';
    return [hhmm, 'failed', reason].filter(Boolean).join(' · ');
  }

  paint() {
    if (this.el) this.el.hidden = false;
    super.paint();
  }

  render(root) {
    const { state, container } = this.ctx;
    const now = Date.now();
    const known = new Set(state.tasks.keys());
    let seen = this._readSeen();
    const pruned = Object.fromEntries(Object.entries(seen).filter(([id]) => known.has(id)));
    if (Object.keys(pruned).length !== Object.keys(seen).length) { seen = pruned; this._writeSeen(seen); }

    const recent = this._recent(now);
    this.el.hidden = recent.length === 0;
    if (recent.length === 0) return;

    const unseen = recent.filter(r => seen[r.task.id] !== r.task.lastRun).length;
    const eyebrow = todayEyebrow('Routines', unseen ? `${unseen} new` : '');
    const detail = eyebrow.querySelector('.home__eyebrow-detail');
    if (detail) detail.dataset.testid = 'today-routines-unseen';
    root.appendChild(eyebrow);

    const list = document.createElement('div');
    list.className = 'home__list';
    recent.slice(0, RoutinesPart.MAX).forEach(({ task: t }) => {
      const project = state.getProject(t.projectId);
      const failed = todayTaskIsFailed(t);
      const row = todayRow(state, {
        testid: `today-routine-${t.id}`, kind: failed ? 'failed' : 'ok',
        project, projectId: t.projectId,
        title: t.name || t.id,
        sub: this._line(t, this._exec(t), now),
        status: failed ? 'failed' : null,
        onClick: () => {
          this._writeSeen({ ...this._readSeen(), [t.id]: t.lastRun });
          if (container.has('taskViewer')) container.get('taskViewer').openLastRun(t);
          this.paint();
        },
      });
      if (seen[t.id] !== t.lastRun) row.dataset.unseen = 'true';
      list.appendChild(row);
    });
    root.appendChild(list);
    if (recent.length > RoutinesPart.MAX) {
      const more = document.createElement('p');
      more.className = 'today__more';
      more.dataset.testid = 'today-routines-more';
      more.textContent = `+${recent.length - RoutinesPart.MAX} more`;
      root.appendChild(more);
    }
  }
}
