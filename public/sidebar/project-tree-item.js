/**
 * ProjectTreeItem - renders a single project header with action icons and file tree.
 */
class ProjectTreeItem {
  constructor(container, projectId, fileTreeNode) {
    this.container = container;
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

    // Detached terminal badge
    const termMgr = this.container?.has('terminalManager') ? this.container.get('terminalManager') : null;
    const detached = termMgr?.getDetachedCountForPath(project.path) || 0;
    if (detached > 0) {
      const badge = document.createElement('span');
      badge.className = 'project-tree__badge';
      badge.textContent = detached;
      badge.title = `${detached} detached terminal${detached > 1 ? 's' : ''}`;
      actions.appendChild(badge);
    }

    actions.appendChild(this._actionBtn('New Shell', UI_ICONS.shell(14), () =>
      this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: this.projectId })));
    actions.appendChild(this._actionBtn('Tasks', UI_ICONS.tasks(14), () =>
      this.bus.emit(EVT.DIALOG_TASK, { projectId: this.projectId })));
    actions.appendChild(this._actionBtn('More', UI_ICONS.more(14), (e) =>
      this._showProjectMenu(e.clientX, e.clientY)));

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

  _actionBtn(title, iconHtml, onClick) {
    const btn = document.createElement('button');
    btn.className = 'project-tree__action-btn';
    btn.title = title;
    btn.innerHTML = iconHtml;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return btn;
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
