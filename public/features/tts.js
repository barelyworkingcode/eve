features.register({
  id: 'ttsManager',
  init: (container) => new TTSManager(container),
  slots: [
    {
      slot: 'voice-drawer-controls',
      order: 10,
      // renderSlots() runs after boot(), so this lookup resolves to the
      // manager boot() already created.
      render: (container) => {
        const app = container.get('app');
        const btn = document.createElement('button');
        btn.id = 'voiceModeBtn';
        btn.className = 'btn-voice-mode';
        btn.type = 'button';
        btn.title = 'Voice mode (TTS)';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M11 5L6 9H2v6h4l5 4V5z"/>
  <path d="M19.07 4.93a10 10 0 010 14.14"/>
  <path d="M15.54 8.46a5 5 0 010 7.07"/>
</svg>`;

        let voiceBtnTimer = null;
        let voiceBtnHandled = false;
        const startLongPress = () => {
          voiceBtnHandled = false;
          voiceBtnTimer = setTimeout(() => {
            voiceBtnHandled = true;
            if (app.currentSessionId) {
              app.enableVoiceMode();
              app.voiceChatManager.convertToVoiceChat();
            }
          }, 500);
        };
        const cancelLongPress = () => { clearTimeout(voiceBtnTimer); };
        const shortTap = () => {
          if (voiceBtnHandled) return;
          voiceBtnHandled = true;
          app.toggleVoiceMode();
        };

        btn.addEventListener('mousedown', startLongPress);
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); startLongPress(); });
        btn.addEventListener('mouseup', cancelLongPress);
        btn.addEventListener('mouseleave', cancelLongPress);
        btn.addEventListener('touchend', (e) => { e.preventDefault(); cancelLongPress(); shortTap(); });
        btn.addEventListener('click', (e) => { e.preventDefault(); shortTap(); });

        container.get('ttsManager').button = btn;
        return btn;
      },
    },
  ],
});
