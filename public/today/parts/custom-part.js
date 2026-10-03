/**
 * A custom Today card: a terminal routine with an output file. The card shows
 * the newest successful run's output, parsed by CustomOutput; Refresh is Run now.
 * Output is untrusted: every string goes in with textContent, and the only
 * element built from it with an attribute is an `a` whose URL passed safeUrl().
 * Contract: docs/design-today-custom.md.
 */
class CustomPart extends TodayPart {
  static RAW_MAX = 4000;
  static VISIBLE_ITEMS = 10;

  constructor(taskId) {
    super();
    this.taskId = taskId;
    this.id = `custom-${taskId}`;
    this.modes = ['home', 'work'];
    this.order = 16;
    this.title = '';
    this.sources = ['tasks'];
    this.events = [EVT.TASKS_LOADED, EVT.TASK_UPDATED];
    this._history = null;
  }

  // One fetch per (task, lastRun): the newest run (for the failure reason) and
  // the newest successful run (what the card shows).
  _runs(task) {
    if (!this._history) {
      const tm = this.ctx.container.has('taskManager') ? this.ctx.container.get('taskManager') : null;
      this._history = new RoutineHistory({
        load: id => (tm ? tm.loadHistory(id) : Promise.resolve([])),
        onChange: () => this.paint(),
        limit: 50,
        pick: h => ({ newest: h[0] || null, good: h.find(e => e.status === 'success') || null }),
      });
    }
    return this._history.newest(task);
  }

  _el(tag, text, testid, cls) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (testid) el.dataset.testid = testid;
    if (cls) el.className = cls;
    return el;
  }

  _button(label, testid) {
    const b = this._el('button', label, testid, 'today__retry');
    b.type = 'button';
    b.addEventListener('click', () => {
      const tm = this.ctx.container.get('taskManager');
      Promise.resolve(tm.runTask(this.taskId)).finally(() => this.paint());
    });
    return b;
  }

  render(root) {
    delete root.dataset.stale;
    const task = this.ctx.state.tasks.get(this.taskId);
    if (!task) return;
    root.appendChild(todayEyebrow(task.name || this.title || this.id));
    const wrap = this._el('div', null, null, 'today-custom');
    root.appendChild(wrap);
    const status = task.lastStatus;
    const ran = status === 'success' || status === 'error' || status === 'timeout';
    const runs = ran || (status === 'running' && task.lastRun) ? this._runs(task) : null;
    const good = runs?.good || null;

    if (status === 'running') {
      wrap.appendChild(this._el('p', 'Running…', 'today-custom-running', 'today-custom__line'));
      if (good) this._output(wrap, good.output ?? '');
      return;
    }
    if (status === 'error' || status === 'timeout') {
      if (good) root.dataset.stale = 'true'; // stale only when an earlier output is on screen
      const head = this._el('div', null, null, 'today-custom__head');
      head.appendChild(this._el('p', RoutineSentence.result({ ...task, enabled: true }, runs?.newest || null).text, 'today-custom-failed', 'today-custom__line'));
      if (good) head.appendChild(this._el('span', 'Stale', 'today-custom-stale', 'today-custom__stale'));
      head.appendChild(this._button('Retry', 'today-custom-retry'));
      wrap.appendChild(head);
      if (good) this._output(wrap, good.output ?? '');
      return;
    }
    if (status === 'success' && !runs) return; // history still loading
    if (!good) {
      wrap.appendChild(this._el('p', 'No output yet.', 'today-custom-never', 'today-custom__line'));
      wrap.appendChild(this._button('Refresh', 'today-custom-refresh'));
      return;
    }
    wrap.appendChild(this._el('p', `Ran ${RoutineSentence.when(task.lastRun)}`, 'today-custom-when', 'today-custom__line'));
    this._output(wrap, good.output ?? '');
    wrap.appendChild(this._button('Refresh', 'today-custom-refresh'));
  }

  _output(wrap, text) {
    const parsed = CustomOutput.parse(text);
    if (!parsed.ok) {
      wrap.appendChild(this._el('p', `Output not understood (${parsed.reason}).`, 'today-custom-not-understood', 'today-custom__line'));
      const details = document.createElement('details');
      details.appendChild(this._el('summary', 'Show raw output'));
      details.appendChild(this._el('pre', String(text ?? '').slice(0, CustomPart.RAW_MAX), 'today-custom-raw', 'today-custom__raw'));
      wrap.appendChild(details);
      return;
    }
    const body = this._el('div', null, 'today-custom-body', `today-custom__body today-custom__body--${parsed.renderer}`);
    body.dataset.renderer = parsed.renderer;
    this[`_${parsed.renderer}`](body, parsed.data);
    wrap.appendChild(body);
  }

  _list(body, { items }) {
    for (const i of items.slice(0, CustomPart.VISIBLE_ITEMS)) {
      const row = this._el('div', null, 'today-custom-item', 'today-custom__item');
      let title;
      if (i.url) {
        title = document.createElement('a');
        title.href = i.url;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
        title.textContent = i.title;
      } else {
        title = this._el('span', i.title);
      }
      title.classList.add('today-custom__title');
      row.appendChild(title);
      if (i.detail) row.appendChild(this._el('span', i.detail, null, 'today-custom__detail'));
      body.appendChild(row);
    }
    if (items.length > CustomPart.VISIBLE_ITEMS) {
      body.appendChild(this._el('p', `+${items.length - CustomPart.VISIBLE_ITEMS} more`, null, 'today__more'));
    }
  }

  _table(body, { columns, rows }) {
    const table = this._el('table', null, null, 'today-custom__table');
    const head = table.createTHead().insertRow();
    for (const c of columns) head.appendChild(this._el('th', c));
    const tbody = table.createTBody();
    for (const r of rows) {
      const tr = tbody.insertRow();
      for (const c of r) tr.appendChild(this._el('td', c));
    }
    body.appendChild(table);
  }

  _metrics(body, { metrics }) {
    for (const m of metrics) {
      const tile = this._el('div', null, null, 'today-custom__metric');
      tile.appendChild(this._el('span', m.value, null, 'today-custom__value'));
      tile.appendChild(this._el('span', m.label, null, 'today-custom__label'));
      if (m.detail) tile.appendChild(this._el('span', m.detail, null, 'today-custom__detail'));
      body.appendChild(tile);
    }
  }
}

/** Keeps one CustomPart per card routine in the registry; the host and registry are untouched. */
class CustomParts {
  constructor({ registry, host, state, bus }) {
    this.registry = registry;
    this.host = host;
    this.state = state;
    this.bus = bus;
    this._parts = new Map(); // task id -> CustomPart
  }

  start() {
    for (const evt of [EVT.TASKS_LOADED, EVT.TASK_UPDATED, EVT.PROJECTS_LOADED]) this.bus.on(evt, () => this.sync());
    this.sync();
  }

  _modes(task) {
    const project = this.state.getProject(task.projectId);
    if (!project) return null;
    const m = Mode.normalizeProjectMode(project.mode);
    return m === 'both' ? ['home', 'work'] : [m];
  }

  sync() {
    const cards = [];
    for (const t of this.state.tasks.values()) if (CustomOutput.isPartTask(t)) cards.push(t);
    cards.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));
    let changed = false;
    const live = new Set();
    cards.forEach((t, i) => {
      const modes = this._modes(t);
      if (!modes) return;
      live.add(t.id);
      let part = this._parts.get(t.id);
      const order = 16 + i / 100;
      const title = t.name || t.id;
      if (!part) {
        part = new CustomPart(t.id);
        this._parts.set(t.id, part);
        this.registry.register(part);
        changed = true;
      }
      if (part.title !== title || part.order !== order || part.modes.join() !== modes.join()) {
        Object.assign(part, { title, order, modes });
        changed = true;
      }
    });
    for (const [id, part] of [...this._parts]) {
      if (live.has(id)) continue;
      this.registry.unregister(part.id);
      this._parts.delete(id);
      changed = true;
    }
    if (changed) this.host.setMode();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CustomPart, CustomParts };
