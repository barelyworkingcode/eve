/** Terminals in in-mode projects and in no project, with their last line (S5a-A3). Task runs are left out by the board. */
class AgentsPart {
  constructor() {
    this.id = 'agents';
    this.modes = ['home', 'work'];
    this.order = 55;
    this.title = 'Agents';
    this.board = null;
  }

  mount(el, ctx) {
    const { state, container } = ctx;
    el.appendChild(todayEyebrow('Agents'));
    const mount = document.createElement('div');
    mount.className = 'agent-board';
    el.appendChild(mount);
    this.board = new AgentBoard({
      container,
      testidPrefix: 'today',
      showProject: true,
      filter: (_t, project) => !project || state.isProjectInMode(project),
    });
    this.board.mount(mount);
  }

  refresh() {
    this.board?.render({ fetch: true });
  }

  destroy() {
    this.board?.destroy();
    this.board = null;
  }
}
