/**
 * HtmlPreviewPane — renders a project HTML file as a live, sandboxed preview in
 * a split pane (the `htmlPreview` pane view).
 *
 * It reuses the same server endpoint the editor's preview uses
 * (`/api/files/...?preview=1&v=`) so the page's own scripts execute under the
 * relaxed preview CSP, and bumps the cache-bust token whenever the file changes
 * on disk — so an AI editing the page shows up live without a tab switch.
 */
class HtmlPreviewPane {
  constructor(_container) {
    this.host = document.getElementById('htmlPreview');
    this.current = null;   // { projectId, path }
    this.version = 0;
    this.iframe = null;
  }

  /** Show `path` from `project` in the preview pane (called by TabManager). */
  show(projectId, path) {
    if (!this.host) return;
    const changed = !this.current
      || this.current.projectId !== projectId
      || this.current.path !== path;
    this.current = { projectId, path };
    if (changed) this.version++;

    if (!this.iframe) {
      const iframe = document.createElement('iframe');
      // No allow-same-origin → opaque origin: the file's scripts run but it
      // cannot reach Eve's DOM, cookies, or session token (the server serves it
      // with a `sandbox allow-scripts` CSP via ?preview=1).
      iframe.setAttribute('sandbox', 'allow-scripts');
      this.host.appendChild(iframe);
      this.iframe = iframe;
    }

    const url = this._url();
    // Reassigning src is a navigation that restarts the page; only do it when
    // the URL actually changed.
    if (this.iframe.getAttribute('src') !== url) {
      this.iframe.setAttribute('src', url);
    }
  }

  /** Reload when the previewed file changes on disk (filewatcher push). */
  handleFileChanged(projectId, path) {
    if (!this.current) return;
    if (this.current.projectId !== projectId || this.current.path !== path) return;
    this.version++;
    if (this.iframe) this.iframe.setAttribute('src', this._url());
  }

  _url() {
    const { projectId, path } = this.current;
    const cleanPath = path
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    return `/api/files/${encodeURIComponent(projectId)}/${cleanPath}?preview=1&v=${this.version}`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HtmlPreviewPane;
}
