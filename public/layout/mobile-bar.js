/**
 * MobileBar - fixed bottom action bar for mobile devices.
 * Provides quick access to menu, shell launcher, and new chat.
 * Visible only below 768px via CSS.
 */
class MobileBar {
  constructor(container) {
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.el = null;
  }

  init() {
    this._create();
  }

  _create() {
    this.el = document.createElement('div');
    this.el.className = 'mobile-bar';

    // Menu button
    const menuBtn = this._createButton('Menu', UI_ICONS.menu(20));
    menuBtn.addEventListener('click', () => {
      this.bus.emit(EVT.UI_TOGGLE_SIDEBAR);
    });

    // New Shell button
    const shellBtn = this._createButton('Shell', UI_ICONS.shell(20));
    shellBtn.addEventListener('click', () => {
      const projectId = this._getFirstProjectId();
      if (projectId) {
        this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId });
      }
    });

    // New Chat button
    const chatBtn = this._createButton('Chat', UI_ICONS.chat(20));
    chatBtn.addEventListener('click', () => {
      const projectId = this._getFirstProjectId();
      if (projectId) {
        this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId });
      }
    });

    this.el.appendChild(menuBtn);
    this.el.appendChild(shellBtn);
    this.el.appendChild(chatBtn);

    document.body.appendChild(this.el);
  }

  _createButton(label, svgHTML) {
    const btn = document.createElement('button');
    btn.className = 'mobile-bar__btn';
    btn.innerHTML = svgHTML;
    const span = document.createElement('span');
    span.className = 'mobile-bar__label';
    span.textContent = label;
    btn.appendChild(span);
    return btn;
  }

  _getFirstProjectId() {
    for (const [id] of this.state.projects) {
      return id;
    }
    return null;
  }
}
