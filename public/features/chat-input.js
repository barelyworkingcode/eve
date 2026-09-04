/**
 * Chat input button row — the first FeatureRegistry consumer.
 *
 * TEMPORARY HOME. These five buttons belong to five different features
 * (attach to file attachments, plan mode to permissions, send to the chat
 * form, mic to STT, stop to the run lifecycle). Later tasks move each button
 * to the feature that owns it (the mic to a TTS/STT feature, and so on); this
 * file is deleted when the last one leaves. That is the point of the
 * exercise: a feature owns its own DOM through a [data-slot] without
 * index.html or app.js knowing about it.
 *
 * Registration is at file scope against the page's registry singleton
 * (core/feature-registry.js). The render closures run at boot, so the DOM
 * they build must match the old literal markup exactly — same ids, classes,
 * types, titles, testids, and SVG.
 */

function buildInputButton({ id, classes, type, title, testid, svg }) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.className = classes;
  btn.type = type;
  if (title) btn.title = title;
  btn.dataset.testid = testid;
  btn.innerHTML = svg;
  return btn;
}

features.register({
  id: 'chat-input',
  slots: [
    {
      slot: 'chat-input-leading',
      order: 10,
      render: () => buildInputButton({
        id: 'attachBtn',
        classes: 'btn-attach',
        type: 'button',
        title: 'Attach files',
        testid: 'chat-attach',
        svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
</svg>`,
      }),
    },
    {
      slot: 'chat-input-leading',
      order: 20,
      render: () => buildInputButton({
        id: 'planModeBtn',
        classes: 'btn-attach',
        type: 'button',
        title: 'Toggle plan mode',
        testid: 'chat-plan-mode',
        svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
</svg>`,
      }),
    },
    {
      slot: 'chat-input-trailing',
      order: 10,
      render: () => buildInputButton({
        id: 'sendBtn',
        classes: 'btn-send',
        type: 'submit',
        testid: 'chat-submit',
        svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
</svg>`,
      }),
    },
    {
      slot: 'chat-input-trailing',
      order: 20,
      render: () => buildInputButton({
        id: 'micBtn',
        classes: 'btn-mic hidden',
        type: 'button',
        title: 'Dictate (Speech-to-Text)',
        testid: 'chat-mic',
        svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="23"/>
  <line x1="8" y1="23" x2="16" y2="23"/>
</svg>`,
      }),
    },
    {
      slot: 'chat-input-trailing',
      order: 30,
      render: () => buildInputButton({
        id: 'stopBtn',
        classes: 'btn-stop hidden',
        type: 'button',
        testid: 'chat-stop',
        svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
  <rect x="6" y="6" width="12" height="12" rx="2"/>
</svg>`,
      }),
    },
  ],
});
