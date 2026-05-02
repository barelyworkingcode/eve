/**
 * ViewerRegistry - Strategy pattern registry for file viewers.
 *
 * Each viewer is a strategy that knows how to render a category of files.
 * The registry selects the correct viewer based on file extension.
 * Registered in the DI container as 'viewerRegistry'.
 *
 * Usage:
 *   const registry = new ViewerRegistry();
 *   registry.register(new ImageViewer());
 *   registry.register(new PdfViewer());
 *
 *   const viewer = registry.getViewer('photo.png');
 *   if (viewer) viewer.render(container, fileInfo);
 */
class ViewerRegistry {
  constructor() {
    this._viewers = [];
  }

  /**
   * Register a viewer. Viewers are checked in registration order.
   * @param {object} viewer - Must implement canHandle(ext), render(canvas, fileInfo), destroy(canvas)
   */
  register(viewer) {
    this._viewers.push(viewer);
  }

  /**
   * Returns the first viewer that can handle the given filename, or null.
   */
  getViewer(filename) {
    const ext = this._getExtension(filename);
    for (const viewer of this._viewers) {
      if (viewer.canHandle(ext)) return viewer;
    }
    return null;
  }

  /**
   * Returns true if any registered viewer can handle this file.
   * Files without a viewer fall through to the Monaco text editor.
   */
  isViewerFile(filename) {
    return this.getViewer(filename) !== null;
  }

  /**
   * Build the HTTP URL for serving a raw file from a project. Pass `version`
   * (any string/number) to append a cache-busting query parameter.
   */
  buildFileUrl(projectId, filePath, version) {
    const cleanPath = filePath.replace(/^\/+/, '');
    const url = `/api/files/${encodeURIComponent(projectId)}/${cleanPath}`;
    return version ? `${url}?v=${encodeURIComponent(version)}` : url;
  }

  _getExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }
}
