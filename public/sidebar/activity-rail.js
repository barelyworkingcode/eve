class ActivityRail {
  constructor(container) {
    this.container = container;
    this.state = container.get('state');
    this.el = null;
    this.activeProjectId = null;
    this.onSelect = null;
    this._colorCache = new Map();
  }

  init() {
    this.el = document.getElementById('railProjects');
  }

  setActive(projectId) {
    this.activeProjectId = projectId;
  }

  render() {
    if (!this.el) return;
    this.el.innerHTML = '';
    this._colorCache.clear();

    const projects = this.state.getVisibleProjects()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    for (const project of projects) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `rail__item${project.id === this.activeProjectId ? ' rail__item--active' : ''}`;
      item.title = project.name;
      item.dataset.testid = `sidebar-project-${project.id}`;

      const avatar = document.createElement('span');
      avatar.className = 'rail__avatar';
      avatar.textContent = projectMonogram(project.name);
      avatar.style.setProperty('--project-avatar-bg', this.state.projectColor(project.id));
      item.appendChild(avatar);

      if (this._hasRunningSession(project.id)) {
        const live = document.createElement('span');
        live.className = 'rail__live';
        live.title = 'Session running';
        item.appendChild(live);
      }

      item.addEventListener('click', () => {
        if (this.onSelect) this.onSelect(project.id);
      });

      this.el.appendChild(item);
    }
  }

  _hasRunningSession(projectId) {
    return this.state.getSessionsForProject(projectId)
      .some(s => s.active && !this.state.isTaskRun(s.id));
  }

  _avatarColor(seed) {
    const key = String(seed || '');
    if (this._colorCache.has(key)) {
      return this._colorCache.get(key);
    }
    const color = projectColor(key);
    this._colorCache.set(key, color);
    return color;
  }
}
