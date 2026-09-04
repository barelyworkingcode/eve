// `elementId` names static markup in index.html, not slot-rendered content,
// so resolving it once at TabManager.initElements() is safe.
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

// `viewer` and `image` deliberately share `#fileViewer`, which is what stops
// the two from ever being split beside each other — so one destroy
// implementation covering both is correct, not a shortcut.
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
    // Re-finds the owning tab (rather than trusting `ref`) so a re-render
    // picks up `_reloadVersion`; falls back to a synthetic tab built from
    // `ref` alone when there's no owning tab yet (e.g. a fresh open).
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
      // Deliberately silent no-op on a registry miss (no viewer at all, not
      // even the fallback) — looks like a bug, is preserved behavior.
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
