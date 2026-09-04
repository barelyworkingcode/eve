/**
 * Chat input button row — the first FeatureRegistry consumer.
 *
 * TEMPORARY HOME. These two buttons belong to the chat form feature; the
 * attach button moved to features/file-attachments.js, the plan-mode button
 * moved to features/permissions.js, and the mic lives in the STT feature
 * (features/stt.js). A later task moves send and stop to
 * features/chat-form.js; this file is deleted when the last one leaves. That
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
