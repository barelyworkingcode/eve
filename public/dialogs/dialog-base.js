/**
 * DialogBase - shared modal behavior for all dialogs.
 * Handles backdrop, escape key, focus trap, show/hide lifecycle.
 */
class DialogBase {
  constructor(container, dialogId) {
    this.container = container;
    this.bus = container.get('bus');
    this.dialogId = dialogId;
    this.el = null;
    this._panel = null;
    this._boundEscape = this._onEscape.bind(this);
    this._createShell();
  }

  _createShell() {
    this.el = document.createElement('div');
    this.el.id = this.dialogId;
    this.el.className = 'dialog hidden';

    const backdrop = document.createElement('div');
    backdrop.className = 'dialog__backdrop';
    backdrop.addEventListener('click', () => this.hide());

    this._panel = document.createElement('div');
    this._panel.className = 'dialog__panel';

    this.el.appendChild(backdrop);
    this.el.appendChild(this._panel);
    document.body.appendChild(this.el);
  }

  /**
   * Set the panel HTML content. Subclasses call this in render().
   */
  _setContent(html) {
    this._panel.innerHTML = html;
  }

  /**
   * Get the panel element for DOM manipulation.
   */
  get panel() {
    return this._panel;
  }

  show() {
    this.el.classList.remove('hidden');
    document.addEventListener('keydown', this._boundEscape);
    // Focus the first focusable element
    requestAnimationFrame(() => {
      const focusable = this._panel.querySelector('button, input, select, textarea, [tabindex]');
      if (focusable) focusable.focus();
    });
  }

  hide() {
    this.el.classList.add('hidden');
    document.removeEventListener('keydown', this._boundEscape);
  }

  get isVisible() {
    return !this.el.classList.contains('hidden');
  }

  _onEscape(e) {
    if (e.key === 'Escape' && this.isVisible) {
      e.preventDefault();
      this.hide();
    }
  }

  /**
   * Helper to create tabbed header.
   * Returns { header, setActiveTab } where setActiveTab(name) updates the UI.
   */
  _createTabs(tabs, onSwitch) {
    const header = document.createElement('div');
    header.className = 'dialog__tabs';

    const buttons = {};
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'dialog__tab';
      btn.textContent = tab.label;
      btn.dataset.tab = tab.name;
      btn.addEventListener('click', () => {
        onSwitch(tab.name);
        for (const b of Object.values(buttons)) b.classList.remove('dialog__tab--active');
        btn.classList.add('dialog__tab--active');
      });
      buttons[tab.name] = btn;
      header.appendChild(btn);
    }

    // Activate first tab
    if (tabs.length > 0) {
      buttons[tabs[0].name].classList.add('dialog__tab--active');
    }

    return {
      header,
      setActiveTab(name) {
        for (const b of Object.values(buttons)) b.classList.remove('dialog__tab--active');
        if (buttons[name]) buttons[name].classList.add('dialog__tab--active');
      }
    };
  }
}
