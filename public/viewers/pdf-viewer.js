/**
 * PdfViewer - renders PDF files using the browser's built-in PDF viewer.
 * Uses an <iframe> for maximum compatibility (Chrome, Safari, Firefox all
 * have native PDF rendering).
 */
class PdfViewer {
  constructor() {
    this.extensions = new Set(['pdf']);
  }

  canHandle(ext) {
    return this.extensions.has(ext);
  }

  render(canvas, { url }) {
    canvas.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'viewer-pdf';

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = 'PDF Viewer';

    wrapper.appendChild(iframe);
    canvas.appendChild(wrapper);
  }

  destroy(canvas) {
    canvas.innerHTML = '';
  }
}
