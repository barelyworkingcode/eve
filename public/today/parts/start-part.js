/** The Start tiles: Chat, the first two terminal templates, Voice. */
class StartPart extends TodayPart {
  constructor() {
    super();
    this.id = 'start';
    this.modes = ['home', 'work'];
    this.order = 30;
    this.title = 'Start';
    this.sources = ['projects'];
    this.events = [EVT.PROJECT_ACTIVATED, EVT.PROJECTS_LOADED, EVT.PROJECT_RENAMED, EVT.PROJECT_DELETED, EVT.TERMINAL_TEMPLATES_LOADED, EVT.MODE_CHANGED];
  }

  render(root) {
    const { state, container, bus } = this.ctx;
    if (state.projects.size === 0) return;
    const app = container.has('app') ? container.get('app') : null;
    const activeId = app?.projectTree?.activeProjectId || app?._resolveActiveProjectId?.() || null;
    const project = activeId ? state.getProject(activeId) : null;

    root.appendChild(todayEyebrow('Start', project ? `in ${project.name}` : ''));
    const grid = document.createElement('div');
    grid.className = 'home__tiles';
    const projectId = project?.id || null;
    const open = (intent) => bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId, intent });

    grid.appendChild(todayTile({
      tone: 'blue', icon: TODAY_ICONS.chat, name: 'Chat',
      desc: 'Talk to a model in the browser', testid: 'home-tile-chat',
      onClick: () => open('web-chat'),
    }));

    let templates = [];
    if (projectId) {
      if (state.terminalTemplatesProjectId === projectId) {
        templates = state.terminalTemplates || [];
      } else if (container.has('terminalManager')) {
        container.get('terminalManager').requestTemplates(projectId);
      }
    }
    const tones = ['orange', 'gray', 'purple', 'green'];
    templates.slice(0, 2).forEach((tmpl, i) => {
      grid.appendChild(todayTile({
        tone: tones[i % tones.length],
        icon: /shell|zsh|bash|terminal/i.test(tmpl.id + tmpl.name) ? TODAY_ICONS.terminal : TODAY_ICONS.agent,
        name: tmpl.name,
        desc: StartPart.shortDescription(tmpl.description) || 'Terminal session',
        testid: `home-tile-${tmpl.id}`,
        onClick: () => open(`terminal:${tmpl.id}`),
      }));
    });

    grid.appendChild(todayTile({
      tone: 'teal', icon: TODAY_ICONS.mic, name: 'Voice',
      desc: 'Hands-free conversation', testid: 'home-tile-voice',
      onClick: () => open('voice-chat'),
    }));
    root.appendChild(grid);
  }

  static shortDescription(desc) {
    if (!desc) return '';
    const cut = String(desc).split(/[(:;]/)[0].trim();
    return cut.length > 44 ? cut.slice(0, 41).trimEnd() + '…' : cut;
  }
}
