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
 * (never captured — see core/pane-registry.js's header). `show` also takes
 * the container element as its third argument (`TabManager._containerForView`
 * resolves it, so a descriptor never needs to know its own `elementId` twice);
 * `layout`/`destroy` still reach a container through `ctx.tabs`'s named
 * properties (`chatContent`, `editorContent`, ...), which `TabManager.initElements()`
 * mirrors from `panes.views()` for exactly this reason.
 */
panes.registerView({
  view: 'chat',
  elementId: 'chat',
  splittable: true,
  show(ref, ctx, el) {
    const { tabs, app } = ctx;
    el.classList.remove('hidden');
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
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    ctx.app.voiceChatManager?.activateForSession(ref.sessionId);
    ctx.app._updateVoiceUIBtnVisibility?.();
  },
});

panes.registerView({
  view: 'editor',
  elementId: 'editor',
  splittable: true,
  show(ref, ctx, el) {
    el.classList.remove('hidden');
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
  show(ref, ctx, el) {
    el.classList.remove('hidden');
    // Verbatim body of the pre-migration `TabManager#_renderViewer` (moved
    // here, not into the `file` type descriptor, per spec §M0.1: `viewer` is
    // produced by exactly one type, so there is nothing left to select
    // between). `t` re-finds the owning tab so a re-render picks up
    // `_reloadVersion`; a ref with no owning tab yet (e.g. a fresh open)
    // falls back to a synthetic one built from `ref` alone.
    const t = ctx.tabs.tabs.find(x => x.type === 'file' && x.projectId === ref.projectId && x.path === ref.path)
      || { projectId: ref.projectId, path: ref.path, label: ref.label || ref.path };

    const registry = ctx.app.viewerRegistry;
    const viewer = registry.getViewer(t.path);
    if (!viewer) return;

    const url = registry.buildFileUrl(t.projectId, t.path, t._reloadVersion);
    ctx.tabs.viewerPath.textContent = t.path;
    ctx.tabs.viewerInfo.textContent = '';
    ctx.tabs._activeViewer = viewer;

    viewer.render(ctx.tabs.viewerCanvas, {
      projectId: t.projectId,
      path: t.path,
      filename: t.label,
      url,
    });
  },
  destroy: destroyActiveViewer,
});

panes.registerView({
  view: 'image',
  elementId: 'fileViewer',
  splittable: true,
  show(ref, ctx, el) {
    el.classList.remove('hidden');
    const t = ctx.tabs.tabs.find(x => x.id === ref.imageTabId);
    if (t) {
      // Verbatim body of the pre-migration `_renderImageTab` — draws `t`'s
      // image into the shared viewer canvas via the viewer registry, falling
      // back to the generic image viewer by extension, and cache-busting the
      // URL after a refresh. Bug-for-bug: a registry miss (no viewer at all,
      // not even the fallback) silently no-ops.
      const registry = ctx.app.viewerRegistry;
      const cleanName = String(t.url).split('?')[0];
      const viewer = registry?.getViewer(cleanName) || registry?.getViewer('image.png');
      if (viewer) {
        const url = t._reloadVersion
          ? `${t.url}${t.url.includes('?') ? '&' : '?'}v=${t._reloadVersion}`
          : t.url;
        ctx.tabs.viewerPath.textContent = t.label;
        ctx.tabs.viewerInfo.textContent = '';
        ctx.tabs._activeViewer = viewer;
        viewer.render(ctx.tabs.viewerCanvas, { filename: t.label, url });
      }
    }
  },
  destroy: destroyActiveViewer,
});

panes.registerView({
  view: 'terminal',
  elementId: 'terminal',
  splittable: true,
  show(ref, ctx, el) {
    el.classList.remove('hidden');
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
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
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
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    ctx.app.htmlPreviewPane?.show(ref.projectId, ref.path);
  },
});
