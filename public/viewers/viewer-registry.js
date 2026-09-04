class ViewerRegistry {
  constructor() {
    this._viewers = [];
  }

  register(viewer) {
    this._viewers.push(viewer);
  }

  getViewer(filename) {
    const ext = this._getExtension(filename);
    for (const viewer of this._viewers) {
      if (viewer.canHandle(ext)) return viewer;
    }
    return null;
  }

  // Files without a viewer fall through to the Monaco text editor.
  isViewerFile(filename) {
    return this.getViewer(filename) !== null;
  }

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
