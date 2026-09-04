/**
 * View descriptors — the view -> element map `tab-manager.js` used to
 * hardcode as a `case` statement (`_containerForView`) plus three duplicated
 * element lists (`initElements`, `_hideAllContent`, `_allContentEls`), plus
 * the per-view render/layout/teardown arms that lived in
 * `_showContentForRef`, `_layoutPanes` and `_destroyActiveViewer`.
 *
 * One row per rendering surface, not per pane type: `session` has two views
 * (`chat`/`voice`); `file` has two (`editor`/`viewer`) plus a third that
 * belongs to no type at all (`htmlPreview`, pane-B only); and `viewer` /
 * `image` share one element (`#fileViewer`) — deliberately, since
 * `_containerForView` returning the same element for both is what stops a
 * viewer and an image tab from ever being split beside each other. The dead
 * `console` view (nothing in public/ ever produces it) is dropped here rather
 * than migrated.
 *
 * `elementId` names static markup in index.html (not slot-rendered), so
 * resolving it at TabManager.initElements() — once, at construction — is
 * safe; see core/pane-registry.js for the ordering rule this depends on.
 *
 * `show`/`layout`/`destroy` reach every owning service through `ctx.app`
 * (never captured — see core/pane-registry.js's header) and every container
 * element through `ctx.tabs`'s named properties (`chatContent`, `editorContent`,
 * ...), which `TabManager.initElements()` mirrors from `panes.views()` for
 * exactly this reason.
 */
panes.registerView({
  view: 'chat',
  elementId: 'chat',
  splittable: true,
  show(ref, ctx) {
    const { tabs, app } = ctx;
    tabs.chatContent.classList.remove('hidden');
    app.voiceChatManager?.deactivate();
    app._updateVoiceUIBtnVisibility?.();
    const sessionId = ref.sessionId;
    const prevSessionId = app.currentSessionId;
    if (prevSessionId && prevSessionId !== sessionId) {
      app.messageRenderer.finishAssistantMessage();
    }
    if (app.messageDispatcher) {
      app.messageDispatcher.flushBackgroundBuffer(sessionId);
    }
    app.currentSessionId = sessionId;
    app.renderMessages();
    app.updateStatsForSession(sessionId);
    if (app.messageDispatcher?.streamingSessions.has(sessionId)) {
      app.showStopButton();
      app.messageRenderer.showThinkingIndicator();
    } else {
      app.hideStopButton();
    }
  },
});

panes.registerView({
  view: 'voice',
  elementId: 'voiceChat',
  splittable: false,
  show(ref, ctx) {
    ctx.tabs.voiceChatContent?.classList.remove('hidden');
    ctx.app.voiceChatManager?.activateForSession(ref.sessionId);
    ctx.app._updateVoiceUIBtnVisibility?.();
  },
});

panes.registerView({
  view: 'editor',
  elementId: 'editor',
  splittable: true,
  show(ref, ctx) {
    ctx.tabs.editorContent.classList.remove('hidden');
    ctx.app.fileEditor?.showFile(ref.projectId, ref.path);
  },
  layout(ctx) {
    ctx.app.fileEditor?.editor?.layout();
  },
});

// `viewer` and `image` share `#fileViewer` and the same `_activeViewer` /
// `viewerCanvas` teardown — deliberate, not duplication: the two views must
// never be shown side by side (see _containerForView / _canSplit), so one
// destroy implementation covering both is correct, not a shortcut.
function destroyActiveViewer(ctx) {
  const t = ctx.tabs;
  if (t._activeViewer) {
    t._activeViewer.destroy(t.viewerCanvas);
    t._activeViewer = null;
  }
}

panes.registerView({
  view: 'viewer',
  elementId: 'fileViewer',
  splittable: true,
  show(ref, ctx) {
    ctx.tabs.viewerContent.classList.remove('hidden');
    const t = ctx.tabs.tabs.find(x => x.type === 'file' && x.projectId === ref.projectId && x.path === ref.path);
    ctx.tabs._renderViewer(t || { projectId: ref.projectId, path: ref.path, label: ref.label || ref.path });
  },
  destroy: destroyActiveViewer,
});

panes.registerView({
  view: 'image',
  elementId: 'fileViewer',
  splittable: true,
  show(ref, ctx) {
    ctx.tabs.viewerContent.classList.remove('hidden');
    const t = ctx.tabs.tabs.find(x => x.id === ref.imageTabId);
    if (t) ctx.tabs._renderImageTab(t);
  },
  destroy: destroyActiveViewer,
});

panes.registerView({
  view: 'terminal',
  elementId: 'terminal',
  splittable: true,
  show(ref, ctx) {
    ctx.tabs.terminalContent.classList.remove('hidden');
    ctx.app.terminalManager?.showTerminal(ref.terminalId);
  },
  layout(ctx) {
    ctx.app.terminalManager?.fitActive();
  },
});

panes.registerView({
  view: 'module',
  elementId: 'moduleContent',
  splittable: true,
  show(ref, ctx) {
    ctx.tabs.moduleContent?.classList.remove('hidden');
    ctx.app.moduleHost?.activate({
      id: `module:${ref.projectId}:${ref.moduleName}`,
      projectId: ref.projectId,
      moduleName: ref.moduleName,
    });
  },
});

panes.registerView({
  view: 'htmlPreview',
  elementId: 'htmlPreview',
  splittable: true,
  show(ref, ctx) {
    ctx.tabs.htmlPreviewContent?.classList.remove('hidden');
    ctx.app.htmlPreviewPane?.show(ref.projectId, ref.path);
  },
});
