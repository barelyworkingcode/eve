/**
 * The Home | Work wordmark. One element, moved between two slots: the top of
 * the sidebar panel on wide, the top of Today on regular and compact.
 */
class ModeSwitch {
  constructor(container) {
    this.state = container.get('state');
    this.bus = container.get('bus');
    this.layout = container.has('layout') ? container.get('layout') : null;
  }

  init() {
    this.el = document.getElementById('modeSwitch');
    if (!this.el) return;
    this.buttons = [...this.el.querySelectorAll('[data-mode]')];
    for (const b of this.buttons) b.addEventListener('click', () => this.state.setMode(b.dataset.mode));
    this.bus.on(EVT.MODE_CHANGED, () => this.render());
    this.bus.on(EVT.LAYOUT_CHANGED, () => this.place());
    this.place();
    this.render();
  }

  place() {
    const which = this.layout && this.layout.name !== 'wide' ? 'today' : 'sidebar';
    const slot = document.querySelector(`[data-wordmark-slot="${which}"]`);
    if (slot && this.el.parentElement !== slot) slot.appendChild(this.el);
  }

  render() {
    for (const b of this.buttons) {
      const on = b.dataset.mode === this.state.mode;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('wordmark__word--active', on);
    }
  }
}
