// "What did it touch" (docs/design-routines.md, S5b-A4): the Relay tool calls a
// routine's project made, mounted into the routine sheet. Loads once each time
// it mounts and never polls. Every value reaches the DOM through textContent;
// the server sends only ts, tool, outcome and allowed.
class RoutineAudit {
  constructor({ container, projectId }) {
    this.container = container;
    this.projectId = projectId;
    this.el = null;
    this._run = 0;
  }

  mount(el) {
    this.el = el;
    this._load();
  }

  destroy() {
    this._run++; // a reply that lands after this is dropped
    this.el = null;
  }

  async _load() {
    const run = ++this._run;
    this._note('today__skeleton', '', 'loading');
    let data;
    try {
      data = await this.container.get('api').getProjectAudit(this.projectId);
    } catch {
      if (run === this._run && this.el) this._failed();
      return;
    }
    if (run === this._run && this.el) this._render(data);
  }

  get _projectName() {
    const p = this.container.get('state').projects.get(this.projectId);
    return (p && p.name) || this.projectId;
  }

  _note(cls, text, state) {
    this.el.textContent = '';
    this.el.dataset.state = state;
    const p = document.createElement('p');
    p.className = `routine-audit__note ${cls}`;
    p.dataset.testid = `routine-audit-${state}`;
    p.textContent = text;
    this.el.appendChild(p);
    return p;
  }

  _failed() {
    const note = this._note('routine-audit__note--error', "Couldn't load tool calls.", 'error');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'routine-audit__retry';
    retry.dataset.testid = 'routine-audit-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => this._load());
    note.append(' ', retry);
  }

  _render(data) {
    if (!data || data.recording === false) return void this._note('', "Relay isn't recording tool calls.", 'off');
    const records = Array.isArray(data.records) ? data.records.slice(0, 50) : [];
    if (records.length === 0) return void this._note('', `No tool calls through Relay for ${this._projectName} yet.`, 'empty');
    this.el.textContent = '';
    this.el.dataset.state = 'ready';
    const caption = document.createElement('p');
    caption.className = 'routine-audit__caption';
    caption.dataset.testid = 'routine-audit-caption';
    caption.textContent = `Tool calls ${this._projectName} made through Relay. A model's built-in tools aren't listed.`;
    const list = document.createElement('ul');
    list.className = 'routine-audit__list';
    for (const r of records) list.appendChild(this._row(r));
    this.el.append(caption, list);
  }

  _row(r) {
    const li = document.createElement('li');
    li.className = 'routine-audit__row';
    li.dataset.testid = 'routine-audit-row';
    const time = document.createElement('span');
    time.className = 'routine-audit__time';
    time.textContent = this._time(r.ts);
    const tool = document.createElement('span');
    tool.className = 'routine-audit__tool';
    tool.textContent = String(r.tool || '');
    const verdict = document.createElement('span');
    verdict.className = `routine-audit__verdict routine-audit__verdict--${r.allowed ? 'allowed' : 'denied'}`;
    verdict.textContent = r.allowed ? 'allowed' : 'denied';
    li.append(time, ' · ', tool, ' · ', verdict);
    return li;
  }

  _time(ts) {
    if (typeof RoutineSentence !== 'undefined' && ts) return RoutineSentence.when(ts);
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
window.RoutineAudit = RoutineAudit;
