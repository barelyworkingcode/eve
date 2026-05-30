/**
 * ProjectTree - coordinates the activity-rail + explorer-panel sidebar.
 *
 * The rail (ActivityRail) lists project avatars and owns project selection;
 * the panel (ProjectPanel) shows the active project's files/sessions/tasks/
 * modules. This class tracks which project is active and keeps the two views
 * in sync. The active project persists across reloads.
 */
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
    // Shared file tree node (one instance, renders per-project on demand)
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
  }

  render() {
    const projects = this.state.getVisibleProjects();

    // Ensure the active project still exists and is visible; otherwise fall
    // back to the first project (alphabetical, matching the rail's order).
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
  }

  setActive(projectId) {
    if (projectId === this.activeProjectId) return;
    this.activeProjectId = projectId;
    this._saveActive();
    this.rail.setActive(projectId);
    this.rail.render();
    this.panel.setProject(projectId);
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
