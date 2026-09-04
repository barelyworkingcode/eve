/**
 * STT feature — owns the mic button in the chat input row.
 *
 * Registers STTManager under the container key 'sttManager' (the key the rest
 * of the app already resolves) and renders the mic button into the
 * chat-input-trailing slot. The render closure wires the click handler and
 * hands the manager its button: renderSlots() runs after boot(), so the
 * container lookup inside the closure resolves to the manager boot() created.
 */

features.register({
  id: 'sttManager',
  init: (container) => new STTManager(container),
  slots: [
    {
      slot: 'chat-input-trailing',
      order: 20,
      render: (container) => {
        const btn = document.createElement('button');
        btn.id = 'micBtn';
        btn.className = 'btn-mic hidden';
        btn.type = 'button';
        btn.title = 'Dictate (Speech-to-Text)';
        btn.dataset.testid = 'chat-mic';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="23"/>
  <line x1="8" y1="23" x2="16" y2="23"/>
</svg>`;
        btn.addEventListener('click', () => {
          container.get('sttManager').toggleRecording();
        });
        container.get('sttManager').button = btn;
        return btn;
      },
    },
  ],
});
