class ProjectTree {
  static ACTIVE_KEY = 'eve-active-project';

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.fileTreeNode = null;
    this.rail = null;
    this.panel = null;
    this.activeProjectId = null;
  }

  init() {
    this.fileTreeNode = new FileTreeNode(this.container);
    this.fileTreeNode.init();
    this.fileTreeNode.restoreExpandState();

    this._restoreActive();

    this.rail = new ActivityRail(this.container);
    this.rail.init();
    this.rail.onSelect = (projectId) => this.setActive(projectId);

    this.panel = new ProjectPanel(this.container, this.fileTreeNode);
    this.panel.init();

    this.bus.on(EVT.PROJECTS_LOADED, () => this.render());
    // state.removeProject emits PROJECT_DELETED, not PROJECTS_LOADED, so this
    // listener is needed or the rail keeps a stale avatar. render() is
    // idempotent, which also makes it safe against the "please delete" emit
    // that precedes the actual removal.
    this.bus.on(EVT.PROJECT_DELETED, () => this.render());
  }

  render() {
    const projects = this.state.getVisibleProjects();

    const sorted = [...projects].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const stillValid = this.activeProjectId
      && sorted.some(p => p.id === this.activeProjectId);
    if (!stillValid) {
      this.activeProjectId = sorted[0]?.id || null;
      this._saveActive();
    }

    this.rail.setActive(this.activeProjectId);
    this.rail.render();
    this.panel.setProject(this.activeProjectId);
    this.bus.emit(EVT.PROJECT_ACTIVATED, { projectId: this.activeProjectId });
  }

  setActive(projectId) {
    if (projectId === this.activeProjectId) return;
    this.activeProjectId = projectId;
    this._saveActive();
    this.rail.setActive(projectId);
    this.rail.render();
    this.panel.setProject(projectId);
    this.bus.emit(EVT.PROJECT_ACTIVATED, { projectId });
  }

  _saveActive() {
    if (this.activeProjectId) {
      localStorage.setItem(ProjectTree.ACTIVE_KEY, this.activeProjectId);
    } else {
      localStorage.removeItem(ProjectTree.ACTIVE_KEY);
    }
  }

  _restoreActive() {
    this.activeProjectId = localStorage.getItem(ProjectTree.ACTIVE_KEY) || null;
  }
}
