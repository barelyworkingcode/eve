/**
 * Shared UI utilities — DRY helpers for repeated patterns.
 */

// --- SVG Icons ---

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

// --- Model Select Dropdown ---

/**
 * Populate a <select> element with grouped model options.
 * @param {HTMLSelectElement} selectEl - The select element to populate.
 * @param {Array} models - Array of {value, label, group, provider}.
 * @param {Object} [options] - { selectedValue, className, name }
 */
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

// --- HTML escape ---

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Context Menu ---

let _activeContextMenu = null;
let _activeContextMenuCloseHandler = null;

/**
 * Show a positioned context menu.
 * @param {number} x - Left position.
 * @param {number} y - Top position.
 * @param {Array} items - Array of { label, action, danger? } or { separator: true }.
 */
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

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  // Close on click outside
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

// --- Prompt dialog ---

/**
 * Show a lightweight single-input modal and resolve with the entered text.
 * Built on the fly (no index.html markup → no server restart) and themed via
 * the .prompt-dialog* classes. Resolves with the trimmed value, or `null` if
 * the user cancels / submits empty (Escape, Cancel, backdrop click, or blank).
 *
 * @param {string} title
 * @param {string} [defaultValue]
 * @param {{ placeholder?: string, confirmLabel?: string, maxLength?: number }} [opts]
 * @returns {Promise<string|null>}
 */
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

// --- URL-scoped project filter ---

function slugifyProjectName(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readScopeSlugFromUrl() {
  const segs = window.location.pathname.split('/').filter(Boolean);
  return segs.length === 1 ? segs[0].toLowerCase() : '';
}
