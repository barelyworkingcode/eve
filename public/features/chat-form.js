/**
 * Chat-form feature — owns the send and stop buttons in the chat input row.
 *
 * Registers ChatFormControls under the container key 'chatForm' and renders
 * both buttons into the chat-input-trailing slot (send at order 10, stop at
 * order 30, with the STT feature's mic at order 20 between them). Send needs
 * no click handler — it is type="submit" and #inputForm's submit listener in
 * app.js handles it. Stop's click handler is wired here; handleStop() itself
 * stays in app.js because it orchestrates wsClient, messageDispatcher and
 * messageRenderer.
 *
 * app.js's showStopButton/hideStopButton/showSessionStarting/
 * clearSessionStarting delegate to this service so the eleven external call
 * sites (message-dispatcher.js, tab-manager.js, shell-launcher-dialog.js)
 * that go through those four app.js methods do not have to move.
 */

class ChatFormControls {
  constructor() {
    this.sendBtn = null;
    this.stopBtn = null;
  }

  showStop() {
    this.sendBtn?.classList.add('hidden');
    this.stopBtn?.classList.remove('hidden');
  }

  hideStop() {
    this.stopBtn?.classList.add('hidden');
    this.sendBtn?.classList.remove('hidden');
  }

  setSubmitEnabled(enabled) {
    if (this.sendBtn) this.sendBtn.disabled = !enabled;
  }
}

features.register({
  id: 'chatForm',
  init: (container) => new ChatFormControls(),
  slots: [
    {
      slot: 'chat-input-trailing',
      order: 10,
      render: (container) => {
        const btn = document.createElement('button');
        btn.id = 'sendBtn';
        btn.className = 'btn-send';
        btn.type = 'submit';
        btn.dataset.testid = 'chat-submit';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
</svg>`;
        container.get('chatForm').sendBtn = btn;
        return btn;
      },
    },
    {
      slot: 'chat-input-trailing',
      order: 30,
      render: (container) => {
        const btn = document.createElement('button');
        btn.id = 'stopBtn';
        btn.className = 'btn-stop hidden';
        btn.type = 'button';
        btn.dataset.testid = 'chat-stop';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
  <rect x="6" y="6" width="12" height="12" rx="2"/>
</svg>`;
        btn.addEventListener('click', () => container.get('app').handleStop());
        container.get('chatForm').stopBtn = btn;
        return btn;
      },
    },
  ],
});
