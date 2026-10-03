/**
 * Home screen — the view behind #welcomeScreen when no tab is open. Today.
 *
 * This is the host: it registers Today's parts (public/today/parts/) and lays
 * out whatever is registered for the current mode, in order. Each part owns its
 * DOM, its data and its error state; nothing here re-renders the page as a
 * whole. Design: docs/design-today-s1.md.
 */
class HomeScreen {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.el = null;
    this.registry = new TodayRegistry();
    this.host = null;
  }

  init() {
    this.el = document.getElementById('homeContent');
    if (!this.el) return;

    for (const Part of [SummaryPart, ContinuePart, NeedsYouPart, StartPart, RunningPart, RoutinesPart, AgentsPart, ProjectsPart]) {
      this.registry.register(new Part());
    }
    this.registry.register(new AskPart());
    this.registry.register(new BriefPart());
    this.container.register('todayParts', this.registry);

    const sources = this.container.get('todaySources');
    this.host = new TodayHost({
      registry: this.registry,
      bus: this.bus,
      ctxFor: (part, on) => ({
        bus: this.bus,
        state: this.state,
        container: this.container,
        sources,
        activity: this.container.get('sessionActivity'),
        mode: () => this.state.mode,
        on,
      }),
    });
    this.host.mount(this.el, this.state.mode);
    new CustomParts({ registry: this.registry, host: this.host, state: this.state, bus: this.bus }).start();
    this.bus.on(EVT.MODE_CHANGED, ({ mode }) => this.host.setMode(mode));
  }

  /** Today came back on screen (no tab is active). The Ask box takes focus on fine pointers unless the user is mid-something else (#129). */
  show() {
    this.registry.partsFor(this.state.mode).find(p => p.id === 'ask')?.focus?.();
  }

  static greeting(date) {
    return SummaryPart.greeting(date);
  }
}

HomeScreen.ICONS = TODAY_ICONS;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HomeScreen;
}
