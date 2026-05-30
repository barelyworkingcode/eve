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
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 38%, 38%)`;
  }
}
