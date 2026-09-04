features.register({
  id: 'sttManager',
  init: (container) => new STTManager(container),
  slots: [
    {
      slot: 'chat-input-trailing',
      order: 20,
      // renderSlots() runs after boot(), so this lookup resolves to the
      // manager boot() already created.
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
