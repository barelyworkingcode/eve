const UI_ICONS = {
  shell: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l5 4-5 4"/><line x1="8" y1="13" x2="14" y2="13"/></svg>`,
  tasks: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12M2 8h12M2 13h12"/><circle cx="13" cy="3" r="1.5" fill="currentColor"/></svg>`,
  more: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/></svg>`,
  menu: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  chat: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>`,
  terminal: (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 6l3 2-3 2"/></svg>`,
  speaker: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor"><path d="M11.536 3.464a5 5 0 010 7.072l-.707-.707a4 4 0 000-5.658l.707-.707zM8 1.5v13l-4-4H1V5.5h3l4-4zM13.657 1.343a8 8 0 010 11.314l-.707-.707a7 7 0 000-9.9l.707-.707z"/></svg>`,
  module: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M6 2h4v2a1 1 0 001 1h2v3h-2a1 1 0 100 2h2v3h-3v-2a1 1 0 10-2 0v2H4V8h2a1 1 0 100-2H4V3a1 1 0 011-1h1z"/></svg>`,
  search: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>`,
  newFolder: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.5 4a1 1 0 011-1h3l1.5 1.5h5.5a1 1 0 011 1V12a1 1 0 01-1 1h-10a1 1 0 01-1-1V4z"/><line x1="8" y1="7" x2="8" y2="11" stroke-linecap="round"/><line x1="6" y1="9" x2="10" y2="9" stroke-linecap="round"/></svg>`,
  refresh: (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3v3.5H10"/><path d="M13.2 6.5A5.5 5.5 0 102.5 8"/></svg>`,
  caret: (size = 12) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`,
};

function renderModelSelect(selectEl, models, options = {}) {
  selectEl.innerHTML = '';
  if (options.className) selectEl.className = options.className;
  if (options.name) selectEl.name = options.name;

  const groups = {};
  for (const m of models) {
    const group = m.group || m.provider || 'Other';
    if (!groups[group]) groups[group] = [];
    groups[group].push(m);
  }

  for (const [groupName, groupModels] of Object.entries(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    for (const m of groupModels) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      if (options.selectedValue === m.value) opt.selected = true;
      optgroup.appendChild(opt);
    }
    selectEl.appendChild(optgroup);
  }

  if (!options.selectedValue && models.length > 0) {
    selectEl.value = models[0].value;
  }
}

function isClaudeModel(models, value) {
  return models.find(m => m.value === value)?.provider === 'claude';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let _activeContextMenu = null;
let _activeContextMenuCloseHandler = null;

function showContextMenu(x, y, items) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'file-tree__context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'file-tree__context-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `file-tree__context-item${item.danger ? ' file-tree__context-item--danger' : ''}`;
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  _activeContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  _activeContextMenuCloseHandler = () => closeContextMenu();
  setTimeout(() => document.addEventListener('click', _activeContextMenuCloseHandler), 0);
}

function closeContextMenu() {
  if (_activeContextMenu) {
    _activeContextMenu.remove();
    _activeContextMenu = null;
  }
  if (_activeContextMenuCloseHandler) {
    document.removeEventListener('click', _activeContextMenuCloseHandler);
    _activeContextMenuCloseHandler = null;
  }
}

// Built from DOM APIs, not index.html markup, so adding this dialog needed no server restart.
function showPromptDialog(title, defaultValue = '', opts = {}) {
  return new Promise((resolve) => {
    closeContextMenu();

    const backdrop = document.createElement('div');
    backdrop.className = 'prompt-dialog__backdrop';

    const box = document.createElement('div');
    box.className = 'prompt-dialog';

    const heading = document.createElement('div');
    heading.className = 'prompt-dialog__title';
    heading.textContent = title;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-dialog__input';
    input.value = defaultValue || '';
    input.maxLength = opts.maxLength || 100;
    if (opts.placeholder) input.placeholder = opts.placeholder;

    const actions = document.createElement('div');
    actions.className = 'prompt-dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'prompt-dialog__btn';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'prompt-dialog__btn prompt-dialog__btn--primary';
    saveBtn.textContent = opts.confirmLabel || 'Save';

    actions.append(cancelBtn, saveBtn);
    box.append(heading, input, actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const commit = () => {
      const v = input.value.trim();
      finish(v || null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
    };

    cancelBtn.addEventListener('click', () => finish(null));
    saveBtn.addEventListener('click', commit);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });
    document.addEventListener('keydown', onKey, true);

    input.focus();
    input.select();
  });
}

function slugifyProjectName(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readScopeSlugFromUrl() {
  const segs = window.location.pathname.split('/').filter(Boolean);
  return segs.length === 1 ? segs[0].toLowerCase() : '';
}

// Two-letter monogram: initials of the first two words, or the first two
// letters of a single word. One letter collapses ("Hermes Mail", "Hermes
// Files", "Hermes Files v3" all read "H"); two keeps siblings apart.
function projectMonogram(name) {
  const words = String(name || '').trim().split(/[\s_\-/]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Golden-angle hue spread from a string hash. Adjacent hashes land far apart
// on the wheel, so sibling projects with near-identical names don't collide.
function projectHue(seed) {
  const key = String(seed || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return Math.round((h * 137.508) % 360);
}

function projectColor(seed) {
  return `hsl(${projectHue(seed)}, 42%, 44%)`;
}

// Rank-based hue: golden-angle steps from a blue origin, so consecutive
// ranks are ~137° apart and no two of the first dozen fall within 20°.
function projectColorAtRank(rank) {
  const hue = Math.round((212 + rank * 137.508) % 360);
  return `hsl(${hue}, 46%, 45%)`;
}

// Compact by design ("12m", "3h", "Sep 4"): it sits in 280px sidebar rows next
// to a model badge, where "12 minutes ago" would eat the title.
function relativeTime(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!t || Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// The one rule for what to call a session in lists. A user-chosen name wins;
// relayLLM's auto name ("<Project> - <model>") loses to the first thing the
// user actually asked, once SessionRecents has seen it.
function sessionDisplayName(session, project, { stripProject = true } = {}) {
  const fullName = session?.name || '';
  let name = fullName;
  if (project && name.startsWith(project.name + ' - ')) name = name.slice(project.name.length + 3) || fullName;
  const model = session?.model || '';
  const isAutoName = !name || name === model || name === model.split('/').pop();
  const shown = stripProject ? name : fullName;
  if (!isAutoName) return shown;
  const remembered = (typeof SessionRecents !== 'undefined') ? SessionRecents.get(session?.id)?.title : '';
  return remembered || shown;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { projectMonogram, projectHue, projectColor, projectColorAtRank, relativeTime, sessionDisplayName, escapeHtml, slugifyProjectName };
}
