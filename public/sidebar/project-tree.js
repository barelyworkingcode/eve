/**
 * ProjectTree - renders the VS Code-style project explorer sidebar.
 * Each project is a top-level expandable tree node with file tree + action icons.
 */
class ProjectTree {
  static STORAGE_KEY = 'eve-expanded-projects';
  static SECTION_STORAGE_KEY = 'eve-expanded-sections';

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.fileTreeNode = null;
    this.projectItems = new Map(); // projectId -> ProjectTreeItem
    this.expandedProjects = new Set(); // persisted to localStorage
    this._sectionState = {}; // projectId -> ['tasks', 'sessions', 'files']
    this.el = null;
  }

  init() {
    // Create the file tree node (shared across all projects)
    this.fileTreeNode = new FileTreeNode(this.container);
    this.fileTreeNode.init();
    this.fileTreeNode.restoreExpandState();

    // Restore project expand state from localStorage
    this._restoreExpandState();
    this._restoreSectionState();

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
      // Restore from in-memory state (which was loaded from localStorage)
      item.expanded = expandState.has(project.id)
        ? expandState.get(project.id)
        : this.expandedProjects.has(project.id);
      // Restore section expand state
      const savedSections = this._sectionState[project.id] || [];
      item.sectionState = {
        tasks: savedSections.includes('tasks'),
        sessions: savedSections.includes('sessions'),
        files: savedSections.includes('files'),
      };
      item.onToggle = (projectId, expanded) => {
        if (expanded) {
          this.expandedProjects.add(projectId);
        } else {
          this.expandedProjects.delete(projectId);
        }
        this._saveExpandState();
      };
      item.onSectionToggle = () => this._saveSectionState();
      item.render(this.el);
      this.projectItems.set(project.id, item);
    }
  }

  _saveExpandState() {
    localStorage.setItem(ProjectTree.STORAGE_KEY, JSON.stringify(Array.from(this.expandedProjects)));
  }

  _restoreExpandState() {
    try {
      const stored = JSON.parse(localStorage.getItem(ProjectTree.STORAGE_KEY));
      if (Array.isArray(stored)) {
        this.expandedProjects = new Set(stored);
      }
    } catch { /* ignore corrupt state */ }
  }

  _saveSectionState() {
    const state = {};
    for (const [pid, item] of this.projectItems) {
      const expanded = Object.entries(item.sectionState)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (expanded.length > 0) state[pid] = expanded;
    }
    localStorage.setItem(ProjectTree.SECTION_STORAGE_KEY, JSON.stringify(state));
  }

  _restoreSectionState() {
    try {
      const raw = JSON.parse(localStorage.getItem(ProjectTree.SECTION_STORAGE_KEY));
      if (raw && typeof raw === 'object') {
        this._sectionState = raw;
      }
    } catch { /* ignore corrupt state */ }
  }
}
