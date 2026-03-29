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
    const menuBtn = this._createButton('Menu', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>');
    menuBtn.addEventListener('click', () => {
      this.bus.emit(EVT.UI_TOGGLE_SIDEBAR);
    });

    // New Shell button
    const shellBtn = this._createButton('Shell', '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l5 4-5 4"/><line x1="8" y1="13" x2="14" y2="13"/></svg>');
    shellBtn.addEventListener('click', () => {
      const projectId = this._getFirstProjectId();
      if (projectId) {
        this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId });
      }
    });

    // New Chat button
    const chatBtn = this._createButton('Chat', '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>');
    chatBtn.addEventListener('click', () => {
      const projectId = this._getFirstProjectId();
      if (projectId) {
        // Launch web chat for the first project with default model
        const ws = this.bus; // We'll emit an event to create session
        const app = document.querySelector ? window.client : null;
        if (app?.modalManager) {
          app.modalManager.showSessionModal(projectId);
        }
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
