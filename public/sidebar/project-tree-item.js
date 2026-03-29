/**
 * ProjectTreeItem - renders a single project header with action icons and file tree.
 */
class ProjectTreeItem {
  constructor(container, projectId, fileTreeNode) {
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.projectId = projectId;
    this.fileTreeNode = fileTreeNode;
    this.expanded = false;
    this.el = null;
  }

  render(parentEl) {
    const project = this.state.getProject(this.projectId);
    if (!project) return;

    this.el = document.createElement('div');
    this.el.className = 'project-tree__project';

    // Header row
    const header = document.createElement('div');
    header.className = `project-tree__header${this.expanded ? ' project-tree__header--expanded' : ''}`;

    // Chevron
    const chevron = document.createElement('span');
    chevron.className = 'project-tree__chevron';
    chevron.textContent = this.expanded ? '\u25BC' : '\u25B6';
    header.appendChild(chevron);

    // Project name
    const name = document.createElement('span');
    name.className = 'project-tree__project-name';
    name.textContent = project.name;
    header.appendChild(name);

    // Action icons (right-aligned)
    const actions = document.createElement('span');
    actions.className = 'project-tree__actions';

    // Shell launcher
    const shellBtn = document.createElement('button');
    shellBtn.className = 'project-tree__action-btn';
    shellBtn.title = 'New Shell';
    shellBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l5 4-5 4"/><line x1="8" y1="13" x2="14" y2="13"/></svg>';
    shellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: this.projectId });
    });
    actions.appendChild(shellBtn);

    // Task manager
    const taskBtn = document.createElement('button');
    taskBtn.className = 'project-tree__action-btn';
    taskBtn.title = 'Tasks';
    taskBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12M2 8h12M2 13h12"/><circle cx="13" cy="3" r="1.5" fill="currentColor"/></svg>';
    taskBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId });
    });
    actions.appendChild(taskBtn);

    // More menu (edit/delete)
    const moreBtn = document.createElement('button');
    moreBtn.className = 'project-tree__action-btn';
    moreBtn.title = 'More';
    moreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/></svg>';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showProjectMenu(e.clientX, e.clientY);
    });
    actions.appendChild(moreBtn);

    header.appendChild(actions);

    // Click header to expand/collapse
    header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this._rerender();
    });

    this.el.appendChild(header);

    // File tree (if expanded)
    if (this.expanded) {
      const treeContainer = document.createElement('div');
      treeContainer.className = 'file-tree';
      treeContainer.dataset.projectId = this.projectId;
      this.fileTreeNode.renderTree(this.projectId, treeContainer);
      this.el.appendChild(treeContainer);
    }

    parentEl.appendChild(this.el);
  }

  _rerender() {
    const parent = this.el?.parentElement;
    if (!parent) return;
    const next = this.el.nextSibling;
    this.el.remove();
    if (next) {
      parent.insertBefore(document.createDocumentFragment(), next);
    }
    this.render(parent);
    // Re-insert at correct position
    if (next && this.el.parentElement !== parent) {
      parent.insertBefore(this.el, next);
    }
  }

  _showProjectMenu(x, y) {
    // Remove any existing menu
    document.querySelectorAll('.file-tree__context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'file-tree__context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const editBtn = document.createElement('button');
    editBtn.className = 'file-tree__context-item';
    editBtn.textContent = 'Edit Project';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      this.bus.emit(EVT.DIALOG_PROJECT, { projectId: this.projectId });
    });
    menu.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'file-tree__context-item file-tree__context-item--danger';
    deleteBtn.textContent = 'Delete Project';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      this.bus.emit(EVT.DIALOG_CONFIRM, {
        message: `Delete project "${this.state.getProject(this.projectId)?.name}"? This cannot be undone.`,
        onConfirm: () => this.bus.emit(EVT.PROJECT_DELETED, { projectId: this.projectId }),
      });
    });
    menu.appendChild(deleteBtn);

    document.body.appendChild(menu);

    // Close on click outside
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}
