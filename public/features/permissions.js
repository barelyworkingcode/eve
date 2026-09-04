class PermissionModeControl {
  constructor(container) {
    this.container = container;
    this.button = null;
  }

  syncMode(mode) {
    this.button?.classList.toggle('active', mode === 'plan');
  }

  setAvailable(available) {
    if (this.button) this.button.hidden = !available;
  }
}

features.register({
  id: 'permissions',
  init: (container) => new PermissionModeControl(container),
  slots: [
    {
      slot: 'chat-input-leading',
      order: 20,
      // renderSlots() runs after boot(), so this lookup resolves to the
      // control boot() already created.
      render: (container) => {
        const btn = document.createElement('button');
        btn.id = 'planModeBtn';
        btn.className = 'btn-attach';
        btn.type = 'button';
        btn.title = 'Toggle plan mode';
        btn.dataset.testid = 'chat-plan-mode';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
</svg>`;
        // relayLLM restarts Claude with --resume + the new --permission-mode
        // flag; .active reflects the server's mode_changed event.
        btn.addEventListener('click', () => {
          const app = container.get('app');
          if (!app.currentSessionId) return;
          const next = btn.classList.contains('active') ? 'default' : 'plan';
          app.wsClient.send({ type: 'set_permission_mode', sessionId: app.currentSessionId, mode: next });
        });
        container.get('permissions').button = btn;
        return btn;
      },
    },
  ],
});
