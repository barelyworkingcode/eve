/**
 * ActivityRail - vertical strip of project avatars (VS Code activity-bar style).
 * Renders into #railProjects; the active project drives the explorer panel.
 * Project switching happens here; secondary surfaces live in ProjectPanel.
 */
class ActivityRail {
  constructor(container) {
    this.container = container;
    this.state = container.get('state');
    this.el = null;            // #railProjects
    this.activeProjectId = null;
    this.onSelect = null;      // callback(projectId)
    this._colorCache = new Map();  // Cache avatar colors by project name/id
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
      avatar.textContent = (project.name || '?').trim().charAt(0).toUpperCase() || '?';
      avatar.style.setProperty('--project-avatar-bg', this._avatarColor(project.name || project.id));
      item.appendChild(avatar);

      item.addEventListener('click', () => {
        if (this.onSelect) this.onSelect(project.id);
      });

      this.el.appendChild(item);
    }
  }

  _avatarColor(seed) {
    const key = String(seed || '');
    if (this._colorCache.has(key)) {
      return this._colorCache.get(key);
    }
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const color = `hsl(${h % 360}, 38%, 38%)`;
    this._colorCache.set(key, color);
    return color;
  }
}
