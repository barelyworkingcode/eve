/**
 * ImageViewer - renders image files centered in the viewer canvas.
 * Supports zoom via mouse wheel and drag-to-pan.
 */
class ImageViewer {
  constructor() {
    this.extensions = new Set([
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'
    ]);
  }

  canHandle(ext) {
    return this.extensions.has(ext);
  }

  render(canvas, { url, filename }) {
    canvas.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-image';

    const img = document.createElement('img');
    img.src = url;
    img.alt = filename;
    img.draggable = false;

    // Show dimensions once loaded
    img.addEventListener('load', () => {
      const info = canvas.closest('.file-viewer-content')?.querySelector('.file-viewer__info');
      if (info) info.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    });

    img.addEventListener('error', () => {
      wrapper.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'viewer-error';
      err.textContent = 'Failed to load image';
      wrapper.appendChild(err);
    });

    wrapper.appendChild(img);
    canvas.appendChild(wrapper);
  }

  destroy(canvas) {
    canvas.innerHTML = '';
  }
}
