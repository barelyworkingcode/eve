// FileAttachmentManager's constructor runs at boot(), before any slot renders,
// so it must stay DOM-free; render() hands it the button once index.html's
// static markup (#fileInput, #userInput, #attachedFiles) exists too.
features.register({
  id: 'fileAttachmentManager',
  init: (container) => new FileAttachmentManager(container),
  slots: [
    {
      slot: 'chat-input-leading',
      order: 10,
      render: (container) => {
        const btn = document.createElement('button');
        btn.id = 'attachBtn';
        btn.className = 'btn-attach';
        btn.type = 'button';
        btn.title = 'Attach files';
        btn.dataset.testid = 'chat-attach';
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
</svg>`;
        container.get('fileAttachmentManager').init(btn);
        return btn;
      },
    },
  ],
});
