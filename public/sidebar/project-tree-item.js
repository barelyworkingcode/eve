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
    this.onToggle = null; // callback(projectId, expanded)
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
    shellBtn.innerHTML = UI_ICONS.shell(14);
    shellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: this.projectId });
    });
    actions.appendChild(shellBtn);

    // Task manager
    const taskBtn = document.createElement('button');
    taskBtn.className = 'project-tree__action-btn';
    taskBtn.title = 'Tasks';
    taskBtn.innerHTML = UI_ICONS.tasks(14);
    taskBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId });
    });
    actions.appendChild(taskBtn);

    // More menu (edit/delete)
    const moreBtn = document.createElement('button');
    moreBtn.className = 'project-tree__action-btn';
    moreBtn.title = 'More';
    moreBtn.innerHTML = UI_ICONS.more(14);
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showProjectMenu(e.clientX, e.clientY);
    });
    actions.appendChild(moreBtn);

    header.appendChild(actions);

    // Click header to expand/collapse
    header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      if (this.onToggle) this.onToggle(this.projectId, this.expanded);
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
    // Build new element into a detached fragment, then insert at original position.
    const fragment = document.createDocumentFragment();
    this.render(fragment);
    parent.insertBefore(fragment, next);
  }

  _showProjectMenu(x, y) {
    showContextMenu(x, y, [
      { label: 'Edit Project', action: () => this.bus.emit(EVT.DIALOG_PROJECT, { projectId: this.projectId }) },
      { label: 'Delete Project', danger: true, action: () => {
        this.bus.emit(EVT.DIALOG_CONFIRM, {
          message: `Delete project "${this.state.getProject(this.projectId)?.name}"? This cannot be undone.`,
          onConfirm: () => this.bus.emit(EVT.PROJECT_DELETED, { projectId: this.projectId }),
        });
      }},
    ]);
  }
}
