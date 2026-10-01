/** The Home | Work switch at the top of the explorer panel. */
class ModeSwitch {
  constructor(container) {
    this.state = container.get('state');
    this.bus = container.get('bus');
  }

  init() {
    this.el = document.getElementById('modeSwitch');
    if (!this.el) return;
    this.buttons = [...this.el.querySelectorAll('[data-mode]')];
    for (const b of this.buttons) b.addEventListener('click', () => this.state.setMode(b.dataset.mode));
    this.bus.on(EVT.MODE_CHANGED, () => this.render());
    this.render();
  }

  render() {
    for (const b of this.buttons) {
      const on = b.dataset.mode === this.state.mode;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('mode-switch__btn--active', on);
    }
  }
}
