/**
 * Chat input button row — the first FeatureRegistry consumer.
 *
 * TEMPORARY HOME. These three buttons belong to three different features
 * (plan mode to permissions, send and stop to the chat form); the attach
 * button moved to features/file-attachments.js and the mic lives in the STT
 * feature (features/stt.js). Later tasks move each remaining button to the
 * feature that owns it; this file is deleted when the last one leaves. That
 * is the point of the exercise: a feature owns its own DOM through a
 * [data-slot] without index.html or app.js knowing about it.
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
