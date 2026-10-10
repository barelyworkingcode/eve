/** Small DOM helpers shared by Today's parts (moved from the old HomeScreen). */
const TODAY_ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.2-4.3A8 8 0 1 1 21 12z"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
};


function todayEyebrow(label, detail = '', hint = null) {
  const row = document.createElement('div');
  row.className = 'home__eyebrow';
  const l = document.createElement('span');
  l.className = 'home__eyebrow-label';
  l.textContent = label;
  row.appendChild(l);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'home__eyebrow-detail';
    d.textContent = detail;
    row.appendChild(d);
  }
  if (hint) {
    const h = document.createElement('span');
    h.className = 'home__eyebrow-hint';
    h.innerHTML = `<kbd>${escapeHtml(hint.kbd)}</kbd> ${escapeHtml(hint.hint)}`;
    row.appendChild(h);
  }
  return row;
}

function todayTile({ tone, icon, name, desc, onClick, testid }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `home__tile home__tile--${tone}`;
  btn.dataset.testid = testid;
  btn.setAttribute('aria-label', name);
  btn.innerHTML = `
    <span class="home__tile-icon">${icon}</span>
    <span class="home__tile-name">${escapeHtml(name)}</span>
    <span class="home__tile-desc">${escapeHtml(desc)}</span>
  `;
  btn.addEventListener('click', onClick);
  return btn;
}

const TODAY_DOT_TITLES = { running: 'Running', waiting: 'Waiting for you', failed: 'Failed' };

/**
 * One row: project monogram, title, sub line, a status dot (running | waiting |
 * failed; none for anything else) and an optional time.
 */
function todayRow(state, { testid, project, projectId, title, sub, status, kind, time, onClick }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'home__row';
  row.dataset.testid = testid;
  row.setAttribute('aria-label', title);
  if (kind) row.dataset.kind = kind;

  const mono = document.createElement('span');
  mono.className = 'home__monogram';
  mono.style.setProperty('--project-avatar-bg', state.projectColor(projectId));
  mono.textContent = projectMonogram(project?.name || '?');
  row.appendChild(mono);

  const body = document.createElement('span');
  body.className = 'home__row-body';
  const t = document.createElement('span');
  t.className = 'home__row-title';
  t.textContent = title;
  const s = document.createElement('span');
  s.className = 'home__row-sub';
  s.textContent = sub || '';
  const chip = project?.host && typeof hostChip === 'function'
    ? hostChip(project.host, { size: 'sm', status: state.hostStatus?.(project.host.id) })
    : null;
  if (chip) s.appendChild(chip);
  body.appendChild(t);
  body.appendChild(s);
  row.appendChild(body);

  const meta = document.createElement('span');
  meta.className = 'home__row-meta';
  if (TODAY_DOT_TITLES[status]) {
    const dot = document.createElement('span');
    dot.className = `home__live home__live--${status}`;
    dot.title = TODAY_DOT_TITLES[status];
    meta.appendChild(dot);
  }
  if (time) {
    const tm = document.createElement('span');
    tm.className = 'home__row-time';
    tm.textContent = relativeTime(time);
    meta.appendChild(tm);
  }
  row.appendChild(meta);
  row.addEventListener('click', onClick);
  return row;
}

/** Threads that are not task runs, in the current mode. */
function todayThreads(state) {
  const out = [];
  for (const s of state.sessions.values()) {
    if (state.isTaskRun(s.id) || !state.isSessionInMode(s)) continue;
    out.push(s);
  }
  return out;
}

function todayTaskIsFailed(task) {
  return task.lastStatus === 'error' || task.lastStatus === 'timeout';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TODAY_ICONS, todayEyebrow, todayTile, todayRow, todayThreads, todayTaskIsFailed };
}
