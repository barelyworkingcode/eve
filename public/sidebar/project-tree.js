/**
 * ProjectTree - renders the VS Code-style project explorer sidebar.
 * Each project is a top-level expandable tree node with file tree + action icons.
 */
class ProjectTree {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.fileTreeNode = null;
    this.projectItems = new Map(); // projectId -> ProjectTreeItem
    this.el = null;
  }

  init() {
    // Create the file tree node (shared across all projects)
    this.fileTreeNode = new FileTreeNode(this.container);
    this.fileTreeNode.init();
    this.fileTreeNode.restoreExpandState();

    // Subscribe to project changes
    this.bus.on(EVT.PROJECTS_LOADED, () => this.render());

    // Find or create container element
    this.el = document.getElementById('projectTree');
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'projectTree';
      this.el.className = 'project-tree';
    }
  }

  render() {
    if (!this.el) return;
    this.el.innerHTML = '';

    // Preserve expand state from existing items
    const expandState = new Map();
    for (const [pid, item] of this.projectItems) {
      expandState.set(pid, item.expanded);
    }
    this.projectItems.clear();

    const projects = Array.from(this.state.projects.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    if (projects.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-tree__empty';
      empty.textContent = 'No projects. Click + to add one.';
      this.el.appendChild(empty);
      return;
    }

    for (const project of projects) {
      const item = new ProjectTreeItem(this.container, project.id, this.fileTreeNode);
      // Restore expand state, default first project to expanded
      item.expanded = expandState.has(project.id)
        ? expandState.get(project.id)
        : projects.indexOf(project) === 0;
      item.render(this.el);
      this.projectItems.set(project.id, item);
    }
  }
}
